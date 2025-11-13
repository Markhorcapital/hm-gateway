import { Contract } from '@ethersproject/contracts';
import { CurrencyAmount } from '@uniswap/sdk-core';
import { NonfungiblePositionManager } from '@uniswap/v3-sdk';
import { BigNumber } from 'ethers';
import { FastifyPluginAsync } from 'fastify';

import { Ethereum } from '../../../chains/ethereum/ethereum';
import {
    CollectFeesRequestType,
    CollectFeesRequest,
    CollectFeesResponseType,
    CollectFeesResponse,
} from '../../../schemas/clmm-schema';
import { logger } from '../../../services/logger';
import { QuickSwap } from '../quickswap';
import { getQuickSwapV3NftManagerAddress, IAlgebraV3PositionManagerABI } from '../quickswap.contracts';

export const collectFeesRoute: FastifyPluginAsync = async (fastify) => {
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
        Body: CollectFeesRequestType;
        Reply: CollectFeesResponseType;
    }>(
        '/collect-fees',
        {
            schema: {
                description: 'Collect fees from a QuickSwap V3 position',
                tags: ['quickswap/clmm'],
                body: {
                    ...CollectFeesRequest,
                    properties: {
                        ...CollectFeesRequest.properties,
                        network: { type: 'string', default: 'polygon' },
                        walletAddress: { type: 'string', examples: [firstWalletAddress] },
                        positionAddress: {
                            type: 'string',
                            description: 'Position NFT token ID',
                            examples: ['1234'],
                        },
                    },
                },
                response: {
                    200: CollectFeesResponse,
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
                            message: { type: 'string', example: 'Collect fees failed: Position not found' },
                        },
                    },
                },
                'x-examples': {
                    'Collect Fees': {
                        summary: 'Collect fees from position 1234',
                        value: {
                            network: 'polygon',
                            walletAddress: firstWalletAddress,
                            positionAddress: '1234',
                        },
                    },
                },
            },
        },
        async (request) => {
            try {
                const {
                    network,
                    walletAddress: requestedWalletAddress,
                    positionAddress,
                } = request.body;

                const networkToUse = network || 'polygon';
                const chain = 'ethereum'; // Default to ethereum

                // Validate essential parameters
                if (!positionAddress) {
                    throw fastify.httpErrors.badRequest('Missing required parameters');
                }

                // Get QuickSwap and Ethereum instances
                const quickswap = await QuickSwap.getInstance(networkToUse);
                const ethereum = await Ethereum.getInstance(networkToUse);

                // Get wallet address - either from request or first available
                let walletAddress = requestedWalletAddress;
                if (!walletAddress) {
                    walletAddress = await ethereum.getFirstWalletAddress();
                    if (!walletAddress) {
                        throw fastify.httpErrors.badRequest(
                            'No wallet address provided and no default wallet found',
                        );
                    }
                    logger.info(`Using first available wallet address: ${walletAddress}`);
                }

                // Get the wallet
                const wallet = await ethereum.getWallet(walletAddress);
                if (!wallet) {
                    throw fastify.httpErrors.badRequest('Wallet not found');
                }

                // Get position manager address
                const positionManagerAddress = getQuickSwapV3NftManagerAddress(networkToUse);

                // Create position manager contract
                const positionManagerContract = new Contract(
                    positionManagerAddress,
                    IAlgebraV3PositionManagerABI,
                    wallet,
                );

                // Get position info
                const position = await positionManagerContract.positions(positionAddress);
                if (!position) {
                    throw fastify.httpErrors.badRequest('Position not found');
                }

                // Check if position has fees to collect
                const tokensOwed0 = position.tokensOwed0;
                const tokensOwed1 = position.tokensOwed1;

                if (tokensOwed0.isZero() && tokensOwed1.isZero()) {
                    throw fastify.httpErrors.badRequest('No fees to collect');
                }

                // Collect fees
                logger.info(
                    `Collecting fees from position ${positionAddress}: ${tokensOwed0} token0 + ${tokensOwed1} token1`,
                );

                const collectTx = await positionManagerContract.collect(
                    positionAddress,
                    walletAddress,
                    tokensOwed0,
                    tokensOwed1,
                );

                const receipt = await collectTx.wait();

                logger.info(
                    `Fees collected successfully. Transaction hash: ${receipt.transactionHash}`,
                );

                return {
                    signature: receipt.transactionHash,
                    fee: receipt.gasUsed.mul(receipt.effectiveGasPrice).toNumber(),
                    baseFeeAmountCollected: tokensOwed0.toNumber(),
                    quoteFeeAmountCollected: tokensOwed1.toNumber(),
                };
            } catch (error) {
                logger.error('Collect fees failed:', error);
                throw fastify.httpErrors.internalServerError(
                    `Collect fees failed: ${error.message}`,
                );
            }
        },
    );
}; 