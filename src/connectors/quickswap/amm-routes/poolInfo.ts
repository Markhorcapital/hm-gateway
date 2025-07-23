import { FastifyPluginAsync } from 'fastify';

import {
    GetPoolInfoRequestType,
    GetPoolInfoRequest,
    PoolInfo,
    PoolInfoSchema,
} from '../../../schemas/amm-schema';
import { logger } from '../../../services/logger';
import { QuickSwap } from '../quickswap';
import { formatTokenAmount } from '../../uniswap/uniswap.utils';

export const poolInfoRoute: FastifyPluginAsync = async (fastify) => {
    await fastify.register(require('@fastify/sensible'));

    fastify.get<{
        Querystring: GetPoolInfoRequestType;
        Reply: Record<string, any>;
    }>(
        '/pool-info',
        {
            schema: {
                tags: ['quickswap/amm'],
                querystring: {
                    ...GetPoolInfoRequest,
                    properties: {
                        network: { type: 'string', examples: ['polygon'], default: 'polygon' },
                        chain: {
                            type: 'string',
                            examples: ['ethereum'],
                            default: 'ethereum',
                        },
                        poolAddress: { type: 'string', examples: [''] },
                        baseToken: { type: 'string', examples: ['WPOL'] },
                        quoteToken: { type: 'string', examples: ['USDC'] },
                    },
                },
                response: {
                    200: PoolInfoSchema,
                },
            },
        },
        async (request): Promise<PoolInfo> => {
            try {
                const { poolAddress, baseToken, quoteToken } = request.query;
                const network = request.query.network || 'polygon';

                const quickswap = await QuickSwap.getInstance(network);

                // Check if either poolAddress or both baseToken and quoteToken are provided
                if (!poolAddress && (!baseToken || !quoteToken)) {
                    throw fastify.httpErrors.badRequest(
                        'Either poolAddress or both baseToken and quoteToken must be provided',
                    );
                }

                let poolAddressToUse = poolAddress;

                // If no pool address provided, find default pool using base and quote tokens
                if (!poolAddressToUse) {
                    poolAddressToUse = await quickswap.findDefaultPool(
                        baseToken,
                        quoteToken,
                        'amm',
                    );
                    if (!poolAddressToUse) {
                        throw fastify.httpErrors.notFound(
                            `No AMM pool found for pair ${baseToken}-${quoteToken}`,
                        );
                    }
                }

                // Get V2 pair data
                const baseTokenObj = baseToken
                    ? quickswap.getTokenBySymbol(baseToken)
                    : null;
                const quoteTokenObj = quoteToken
                    ? quickswap.getTokenBySymbol(quoteToken)
                    : null;

                // Use the QuickSwap V2 router to get pair information
                const v2Pair = await getV2Pool(
                    quickswap,
                    baseTokenObj || (baseTokenObj as any),
                    quoteTokenObj || (quoteTokenObj as any),
                    poolAddressToUse,
                );

                if (!v2Pair) {
                    throw fastify.httpErrors.notFound('Pool not found');
                }

                // Get the tokens from the pair
                const token0 = v2Pair.token0;
                const token1 = v2Pair.token1;

                // Determine which token is base and which is quote
                let actualBaseToken, actualQuoteToken;
                let baseTokenAmount, quoteTokenAmount;

                if (baseTokenObj && token0.address === baseTokenObj.address) {
                    actualBaseToken = token0;
                    actualQuoteToken = token1;
                    baseTokenAmount = formatTokenAmount(
                        v2Pair.reserve0.quotient.toString(),
                        token0.decimals,
                    );
                    quoteTokenAmount = formatTokenAmount(
                        v2Pair.reserve1.quotient.toString(),
                        token1.decimals,
                    );
                } else {
                    actualBaseToken = token1;
                    actualQuoteToken = token0;
                    baseTokenAmount = formatTokenAmount(
                        v2Pair.reserve1.quotient.toString(),
                        token1.decimals,
                    );
                    quoteTokenAmount = formatTokenAmount(
                        v2Pair.reserve0.quotient.toString(),
                        token0.decimals,
                    );
                }

                // Calculate price (quoteToken per baseToken)
                const price = baseTokenAmount > 0 ? quoteTokenAmount / baseTokenAmount : 0;

                logger.info('QuickSwap AMM pool info retrieved', {
                    network,
                    poolAddress: poolAddressToUse,
                    baseToken: actualBaseToken.symbol,
                    quoteToken: actualQuoteToken.symbol,
                    price,
                    baseTokenAmount,
                    quoteTokenAmount,
                });

                return {
                    address: poolAddressToUse,
                    baseTokenAddress: actualBaseToken.address,
                    quoteTokenAddress: actualQuoteToken.address,
                    feePct: 0.3, // QuickSwap V2 fee is fixed at 0.3%
                    price: price,
                    baseTokenAmount: baseTokenAmount,
                    quoteTokenAmount: quoteTokenAmount,
                    poolType: 'amm',
                    lpMint: {
                        address: poolAddressToUse, // In QuickSwap V2, the LP token address is the pair address
                        decimals: 18, // QuickSwap V2 LP tokens have 18 decimals
                    },
                };
            } catch (e) {
                logger.error(`Error in QuickSwap pool-info route: ${e.message}`);
                if (e.stack) {
                    logger.debug(`Stack trace: ${e.stack}`);
                }

                // Return appropriate error based on the error message
                if (e.statusCode) {
                    throw e; // Already a formatted Fastify error
                } else if (e.message && e.message.includes('invalid address')) {
                    throw fastify.httpErrors.badRequest(`Invalid pool address`);
                } else if (e.message && e.message.includes('pair not found')) {
                    throw fastify.httpErrors.notFound(`Pool not found`);
                } else {
                    throw fastify.httpErrors.internalServerError(
                        `Pool info request failed: ${e.message}`,
                    );
                }
            }
        },
    );
};

/**
 * Get QuickSwap V2 pool information
 */
async function getV2Pool(
    quickswap: any,
    baseToken: any,
    quoteToken: any,
    poolAddress: string,
): Promise<any> {
    try {
        // Import V2 SDK for pair creation
        const { Pair } = await import('@uniswap/v2-sdk');
        const { CurrencyAmount } = await import('@uniswap/sdk-core');

        // Get pair contract
        const pairContract = new (await import('ethers')).Contract(
            poolAddress,
            quickswap.v2PairABI || (await import('../quickswap.contracts')).IUniswapV2PairABI.abi,
            quickswap.ethereum.provider,
        );

        // Get reserves
        const reserves = await pairContract.getReserves();
        const [reserve0, reserve1] = reserves;

        // Get token addresses from pair
        const token0Address = await pairContract.token0();
        const token1Address = await pairContract.token1();

        // Create token objects if not provided
        let token0, token1;

        if (baseToken && baseToken.address === token0Address) {
            token0 = baseToken;
            token1 = quoteToken;
        } else {
            token0 = quoteToken;
            token1 = baseToken;
        }

        // Create proper CurrencyAmount objects
        const reserve0Amount = CurrencyAmount.fromRawAmount(token0, reserve0.toString());
        const reserve1Amount = CurrencyAmount.fromRawAmount(token1, reserve1.toString());

        // Create Uniswap V2 pair object
        const pair = new Pair(reserve0Amount, reserve1Amount);

        logger.info('QuickSwap V2 pair created', {
            poolAddress,
            token0: token0.symbol,
            token1: token1.symbol,
            reserve0: reserve0.toString(),
            reserve1: reserve1.toString(),
        });

        return pair;
    } catch (error) {
        logger.error('Failed to create QuickSwap V2 pair', error);
        throw error;
    }
}

export default poolInfoRoute; 