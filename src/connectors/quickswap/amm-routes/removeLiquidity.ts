import { Contract } from '@ethersproject/contracts';
import { Percent } from '@uniswap/sdk-core';
import { BigNumber } from 'ethers';
import { FastifyPluginAsync } from 'fastify';

import { Ethereum } from '../../../chains/ethereum/ethereum';
import {
    RemoveLiquidityRequestType,
    RemoveLiquidityRequest,
    RemoveLiquidityResponseType,
    RemoveLiquidityResponse,
} from '../../../schemas/amm-schema';
import { logger } from '../../../services/logger';
import { QuickSwap } from '../quickswap';
import {
    getQuickSwapV2RouterAddress,
    IUniswapV2Router02ABI,
    IUniswapV2PairABI,
} from '../quickswap.contracts';

// No need to import checkLPAllowance as we handle allowance check directly

export const removeLiquidityRoute: FastifyPluginAsync = async (fastify) => {
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
        Body: RemoveLiquidityRequestType;
        Reply: RemoveLiquidityResponseType;
    }>(
        '/remove-liquidity',
        {
            schema: {
                description: 'Remove liquidity from a QuickSwap V2 pool',
                tags: ['quickswap/amm'],
                body: {
                    ...RemoveLiquidityRequest,
                    properties: {
                        ...RemoveLiquidityRequest.properties,
                        network: { type: 'string', default: 'polygon' },
                        walletAddress: { type: 'string', examples: [firstWalletAddress] },
                        poolAddress: {
                            type: 'string',
                            examples: ['0x...'],
                        },
                        baseToken: { type: 'string', examples: ['WPOL'] },
                        quoteToken: { type: 'string', examples: ['USDC'] },
                        percentageToRemove: { type: 'number', examples: [100] },
                    },
                },
                response: {
                    200: RemoveLiquidityResponse,
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
                            message: { type: 'string', example: 'Remove liquidity failed: Insufficient balance' },
                        },
                    },
                },
                'x-examples': {
                    'Remove WPOL-USDC Liquidity': {
                        summary: 'Remove liquidity from WPOL-USDC pool',
                        value: {
                            network: 'polygon',
                            walletAddress: firstWalletAddress,
                            baseToken: 'WPOL',
                            quoteToken: 'USDC',
                            percentageToRemove: 100,
                        },
                    },
                },
            },
        },
        async (request) => {
            try {
                const {
                    network,
                    poolAddress: requestedPoolAddress,
                    baseToken,
                    quoteToken,
                    percentageToRemove,
                    walletAddress: requestedWalletAddress,
                } = request.body;

                const networkToUse = network || 'polygon';

                // Validate essential parameters
                if (!baseToken || !quoteToken || !percentageToRemove) {
                    throw fastify.httpErrors.badRequest('Missing required parameters');
                }

                if (percentageToRemove <= 0 || percentageToRemove > 100) {
                    throw fastify.httpErrors.badRequest(
                        'Percentage to remove must be between 0 and 100',
                    );
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

                // Get pool address - either from request or from configuration
                let poolAddress = requestedPoolAddress;
                if (!poolAddress) {
                    const networkConfig = quickswap.config.networks[networkToUse];
                    if (networkConfig && networkConfig.amm) {
                        poolAddress = networkConfig.amm[`${baseToken}-${quoteToken}`];
                    }
                    if (!poolAddress) {
                        throw fastify.httpErrors.badRequest(
                            `No pool found for pair ${baseToken}-${quoteToken}`,
                        );
                    }
                }

                // Get token objects
                const baseTokenObj = quickswap.getTokenBySymbol(baseToken);
                const quoteTokenObj = quickswap.getTokenBySymbol(quoteToken);

                if (!baseTokenObj || !quoteTokenObj) {
                    throw fastify.httpErrors.badRequest('Token not found');
                }

                // Get router address
                const routerAddress = getQuickSwapV2RouterAddress(networkToUse);
                const routerContract = new Contract(routerAddress, IUniswapV2Router02ABI.abi, wallet);

                // Get pair contract
                const pairContract = new Contract(poolAddress, IUniswapV2PairABI.abi, wallet);

                // Get LP token balance
                const lpBalance = await pairContract.balanceOf(walletAddress);
                if (lpBalance.isZero()) {
                    throw fastify.httpErrors.badRequest('No LP tokens to remove');
                }

                // Calculate amount to remove based on percentage
                const amountToRemove = lpBalance.mul(percentageToRemove).div(100);

                // Get reserves
                const reserves = await pairContract.getReserves();
                const totalSupply = await pairContract.totalSupply();

                // Calculate expected token amounts
                const expectedBaseTokenAmount = reserves[0].mul(amountToRemove).div(totalSupply);
                const expectedQuoteTokenAmount = reserves[1].mul(amountToRemove).div(totalSupply);

                // Calculate minimum amounts with slippage tolerance
                const slippageTolerance = new Percent(quickswap.config.allowedSlippage);
                const baseTokenAmountMin = expectedBaseTokenAmount.mul(
                    BigNumber.from(1000).sub(BigNumber.from(slippageTolerance.numerator.toString())),
                ).div(1000);

                const quoteTokenAmountMin = expectedQuoteTokenAmount.mul(
                    BigNumber.from(1000).sub(BigNumber.from(slippageTolerance.numerator.toString())),
                ).div(1000);

                // Check LP token allowance
                const lpAllowance = await pairContract.allowance(walletAddress, routerAddress);
                if (lpAllowance.lt(amountToRemove)) {
                    logger.info(`Approving LP tokens for router...`);
                    const approveTx = await pairContract.approve(routerAddress, amountToRemove);
                    await approveTx.wait();
                    logger.info(`LP token approval confirmed`);
                }

                // Execute removeLiquidity
                logger.info(
                    `Removing ${percentageToRemove}% liquidity: ${expectedBaseTokenAmount} ${baseToken} + ${expectedQuoteTokenAmount} ${quoteToken}`,
                );

                const deadline = Math.floor(Date.now() / 1000) + 1200; // 20 minutes

                const removeLiquidityTx = await routerContract.removeLiquidity(
                    baseTokenObj.address,
                    quoteTokenObj.address,
                    amountToRemove,
                    baseTokenAmountMin,
                    quoteTokenAmountMin,
                    walletAddress,
                    deadline,
                );

                const receipt = await removeLiquidityTx.wait();

                logger.info(
                    `Liquidity removed successfully. Transaction hash: ${receipt.transactionHash}`,
                );

                return {
                    signature: receipt.transactionHash,
                    fee: receipt.gasUsed.mul(receipt.effectiveGasPrice).toNumber(),
                    baseTokenAmountRemoved: expectedBaseTokenAmount.toNumber(),
                    quoteTokenAmountRemoved: expectedQuoteTokenAmount.toNumber(),
                };
            } catch (error) {
                logger.error('Remove liquidity failed:', error);
                throw fastify.httpErrors.internalServerError(
                    `Remove liquidity failed: ${error.message}`,
                );
            }
        },
    );
}; 