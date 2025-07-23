import { Contract } from '@ethersproject/contracts';
import { BigNumber } from 'ethers';
import { FastifyPluginAsync } from 'fastify';

import { Ethereum } from '../../../chains/ethereum/ethereum';
import {
    QuotePositionRequestType,
    QuotePositionRequest,
    QuotePositionResponseType,
    QuotePositionResponse,
} from '../../../schemas/clmm-schema';
import { logger } from '../../../services/logger';
import { QuickSwap } from '../quickswap';
import { getQuickSwapV3NftManagerAddress } from '../quickswap.contracts';

export const quotePositionRoute: FastifyPluginAsync = async (fastify) => {
    await fastify.register(require('@fastify/sensible'));

    // Get first wallet address for example
    const ethereum = await Ethereum.getInstance('polygon');
    let firstWalletAddress = '<ethereum-wallet-address>';

    try {
        firstWalletAddress =
            (await ethereum.getFirstWalletAddress()) || firstWalletAddress;
    } catch (error) {
        logger.warn('No wallets found for examples in schema');
    }

    fastify.post<{
        Body: QuotePositionRequestType;
        Reply: QuotePositionResponseType;
    }>(
        '/quote-position',
        {
            schema: {
                description: 'Get a quote for opening a QuickSwap V3 position',
                tags: ['quickswap/clmm'],
                body: {
                    ...QuotePositionRequest,
                    properties: {
                        ...QuotePositionRequest.properties,
                        network: { type: 'string', default: 'polygon' },
                        walletAddress: { type: 'string', examples: [firstWalletAddress] },
                        baseToken: { type: 'string', examples: ['WPOL'] },
                        quoteToken: { type: 'string', examples: ['USDC'] },
                        baseTokenAmount: { type: 'number', examples: [1.0] },
                        quoteTokenAmount: { type: 'number', examples: [1000.0] },
                        lowerPrice: { type: 'number', examples: [0.001] },
                        upperPrice: { type: 'number', examples: [1000.0] },
                    },
                },
                response: {
                    200: QuotePositionResponse,
                    400: {
                        description: 'Bad Request - Invalid parameters',
                        type: 'object',
                        properties: {
                            statusCode: { type: 'number', example: 400 },
                            error: { type: 'string', example: 'BadRequestError' },
                            message: { type: 'string', example: 'Missing required parameters' },
                        },
                    },
                    500: {
                        description: 'Internal Server Error',
                        type: 'object',
                        properties: {
                            statusCode: { type: 'number', example: 500 },
                            error: { type: 'string', example: 'InternalServerError' },
                            message: { type: 'string', example: 'Position quote failed: Invalid tick range' },
                        },
                    },
                },
                'x-examples': {
                    'Quote WPOL-USDC Position': {
                        summary: 'Get quote for WPOL-USDC position',
                        value: {
                            network: 'polygon',
                            walletAddress: firstWalletAddress,
                            baseToken: 'WPOL',
                            quoteToken: 'USDC',
                            baseTokenAmount: 1.0,
                            quoteTokenAmount: 1000.0,
                            fee: 3000,
                            tickLower: -887220,
                            tickUpper: 887220,
                        },
                    },
                },
            },
        },
        async (request) => {
            try {
                const {
                    network,
                    baseToken,
                    quoteToken,
                    baseTokenAmount,
                    quoteTokenAmount,
                    lowerPrice,
                    upperPrice,
                } = request.body;

                const networkToUse = network || 'polygon';

                // Validate essential parameters
                if (!baseToken || !quoteToken || !baseTokenAmount || !quoteTokenAmount || !lowerPrice || !upperPrice) {
                    throw fastify.httpErrors.badRequest('Missing required parameters');
                }

                if (lowerPrice >= upperPrice) {
                    throw fastify.httpErrors.badRequest('lowerPrice must be less than upperPrice');
                }

                // Get QuickSwap and Ethereum instances
                const quickswap = await QuickSwap.getInstance(networkToUse);
                const ethereum = await Ethereum.getInstance(networkToUse);

                // Get token objects
                const baseTokenObj = quickswap.getTokenBySymbol(baseToken);
                const quoteTokenObj = quickswap.getTokenBySymbol(quoteToken);

                if (!baseTokenObj || !quoteTokenObj) {
                    throw fastify.httpErrors.badRequest('Token not found');
                }

                // Convert amounts to wei
                const baseTokenAmountWei = BigNumber.from(
                    Math.floor(baseTokenAmount * Math.pow(10, baseTokenObj.decimals)).toString(),
                );
                const quoteTokenAmountWei = BigNumber.from(
                    Math.floor(quoteTokenAmount * Math.pow(10, quoteTokenObj.decimals)).toString(),
                );

                // Calculate liquidity from amounts and tick range
                // This is a simplified calculation - in practice, you'd use the Uniswap V3 SDK
                const liquidity = baseTokenAmountWei.add(quoteTokenAmountWei).div(2);

                // Calculate position value
                const positionValue = baseTokenAmount + quoteTokenAmount;

                // Calculate optimal amounts (simplified calculation)
                const baseTokenAmountMax = baseTokenAmount;
                const quoteTokenAmountMax = quoteTokenAmount;
                const baseLimited = baseTokenAmount > quoteTokenAmount;

                logger.info(
                    `Position quote: ${baseTokenAmount} ${baseToken} + ${quoteTokenAmount} ${quoteToken} at price range ${lowerPrice}-${upperPrice}`,
                );

                return {
                    baseTokenAmount,
                    quoteTokenAmount,
                    baseLimited,
                    baseTokenAmountMax,
                    quoteTokenAmountMax,
                    liquidity: liquidity.toString(),
                };
            } catch (error) {
                logger.error('Position quote failed:', error);
                throw fastify.httpErrors.internalServerError(
                    `Position quote failed: ${error.message}`,
                );
            }
        },
    );
}; 