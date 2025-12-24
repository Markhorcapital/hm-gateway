import { Contract } from 'ethers';
import { FastifyPluginAsync } from 'fastify';

import { Ethereum } from '../../../chains/ethereum/ethereum';
import { GetPoolInfoRequestType, GetPoolInfoRequest, PoolInfo, PoolInfoSchema } from '../../../schemas/amm-schema';
import { logger } from '../../../services/logger';
import { formatTokenAmount } from '../../uniswap/uniswap.utils';
import { QuickSwap } from '../quickswap';

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
        const { poolAddress } = request.query;
        const network = request.query.network || 'polygon';

        const quickswap = await QuickSwap.getInstance(network);

        // Validate poolAddress is provided
        if (!poolAddress) {
          throw fastify.httpErrors.badRequest('poolAddress must be provided');
        }

        const poolAddressToUse = poolAddress;

        // Get token addresses from the pair contract
        const ethereum = await Ethereum.getInstance(network);
        const { IUniswapV2PairABI } = await import('../quickswap.contracts');
        const pairContract = new Contract(poolAddressToUse, IUniswapV2PairABI.abi, ethereum.provider);

        // Get token addresses from the pair
        const token0Address = await pairContract.token0();
        const token1Address = await pairContract.token1();

        // Get token objects by address
        const token0 = quickswap.getTokenByAddress(token0Address);
        const token1 = quickswap.getTokenByAddress(token1Address);

        if (!token0 || !token1) {
          throw fastify.httpErrors.notFound('Could not find tokens for pool');
        }

        // Get V2 pair data
        const v2Pair = await quickswap.getV2Pool(token0, token1, poolAddressToUse);

        if (!v2Pair) {
          throw fastify.httpErrors.notFound('Pool not found');
        }

        // Get the tokens from the pair
        const pairToken0 = v2Pair.token0;
        const pairToken1 = v2Pair.token1;

        // Use token0 as base and token1 as quote
        const actualBaseToken = pairToken0;
        const actualQuoteToken = pairToken1;
        const baseTokenAmount = formatTokenAmount(v2Pair.reserve0.quotient.toString(), pairToken0.decimals);
        const quoteTokenAmount = formatTokenAmount(v2Pair.reserve1.quotient.toString(), pairToken1.decimals);

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
          throw fastify.httpErrors.internalServerError(`Pool info request failed: ${e.message}`);
        }
      }
    },
  );
};

/**
 * Get QuickSwap V2 pool information
 */
async function getV2Pool(quickswap: any, baseToken: any, quoteToken: any, poolAddress: string): Promise<any> {
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
