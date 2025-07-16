import { BigNumber, Contract } from 'ethers';
import { FastifyPluginAsync } from 'fastify';

import { Ethereum } from '../../../chains/ethereum/ethereum';
import { wrapEthereum } from '../../../chains/ethereum/routes/wrap';
import {
    ExecuteSwapRequestType,
    ExecuteSwapRequest,
    ExecuteSwapResponseType,
    ExecuteSwapResponse,
} from '../../../schemas/swap-schema';
import { logger } from '../../../services/logger';
import { QuickSwap } from '../quickswap';
import {
    getQuickSwapV3SmartOrderRouterAddress,
} from '../quickswap.contracts';
import { ISwapRouter02ABI } from '../../uniswap/uniswap.contracts';
import { formatTokenAmount } from '../../../connectors/uniswap/uniswap.utils';

import { getQuickSwapClmmQuote } from './quoteSwap';

async function executeSwap(
    fastify: any,
    network: string,
    walletAddress: string,
    poolAddress: string,
    baseToken: string,
    quoteToken: string,
    amount: number,
    side: 'BUY' | 'SELL',
    slippagePct?: number,
): Promise<any> {
    const startTimestamp = Date.now();

    try {
        // Get quote using the shared quote function
        const { quote, ethereum, baseTokenObj, quoteTokenObj } =
            await getQuickSwapClmmQuote(
                fastify,
                network,
                poolAddress,
                baseToken,
                quoteToken,
                amount,
                side,
                slippagePct,
            );

        // Get the wallet
        const wallet = await ethereum.getWallet(walletAddress);
        if (!wallet) {
            throw fastify.httpErrors.badRequest('Wallet not found');
        }

        // Extract info from quote
        let wrapTxHash = null;
        let inputTokenAddress = quote.inputToken.address;
        let outputTokenAddress = quote.outputToken.address;

        // Handle ETH->WETH wrapping if needed
        if (baseToken === 'ETH' && side === 'SELL') {
            const quickswap = await QuickSwap.getInstance(network);
            const wethToken = quickswap.getTokenBySymbol('WETH');
            if (!wethToken) {
                throw new Error('WETH token not found');
            }

            logger.info(
                `ETH detected as input token, wrapping ${amount} ETH to WETH first`,
            );

            const wrapResult = await wrapEthereum(
                fastify,
                network,
                walletAddress,
                amount.toString(),
            );

            if (!wrapResult.signature) {
                throw new Error('Failed to wrap ETH to WETH');
            }

            wrapTxHash = wrapResult.signature;
            inputTokenAddress = wethToken.address;

            logger.info(`ETH wrapped successfully, tx hash: ${wrapTxHash}`);
        }

        // Get QuickSwap V3 router contract (SwapRouter02 equivalent)
        const routerAddress = getQuickSwapV3SmartOrderRouterAddress(network);
        const routerContract = new Contract(
            routerAddress,
            ISwapRouter02ABI,
            wallet,
        );

        // Prepare swap parameters for V3
        const inputAmount = BigNumber.from(quote.inputAmount.quotient.toString());
        const minOutputAmount = BigNumber.from(quote.minOutputAmount.quotient.toString());
        const deadline = Math.floor(Date.now() / 1000) + 60 * 20; // 20 minutes from now

        let swapTx;

        // Execute V3 swap using exactInputSingle or exactOutputSingle
        if (side === 'SELL') {
            // Exact input swap
            const params = {
                tokenIn: inputTokenAddress,
                tokenOut: outputTokenAddress,
                fee: quote.feeTier || 3000, // Default to 0.3% fee
                recipient: walletAddress,
                deadline,
                amountIn: inputAmount,
                amountOutMinimum: minOutputAmount,
                sqrtPriceLimitX96: 0, // No price limit
            };

            swapTx = await routerContract.exactInputSingle(params);
        } else {
            // Exact output swap (BUY)
            const params = {
                tokenIn: inputTokenAddress,
                tokenOut: outputTokenAddress,
                fee: quote.feeTier || 3000,
                recipient: walletAddress,
                deadline,
                amountOut: minOutputAmount,
                amountInMaximum: inputAmount,
                sqrtPriceLimitX96: 0,
            };

            swapTx = await routerContract.exactOutputSingle(params);
        }

        const receipt = await swapTx.wait();

        // Calculate actual amounts from logs
        let actualInputAmount = formatTokenAmount(
            quote.inputAmount.quotient.toString(),
            quote.inputToken.decimals,
        );
        let actualOutputAmount = formatTokenAmount(
            quote.outputAmount.quotient.toString(),
            quote.outputToken.decimals,
        );

        // Calculate balance changes
        const baseTokenBalanceChange = side === 'SELL' ? -actualInputAmount : actualOutputAmount;
        const quoteTokenBalanceChange = side === 'SELL' ? actualOutputAmount : -actualInputAmount;

        // Calculate gas fee
        const gasUsed = receipt.gasUsed;
        const gasPrice = receipt.effectiveGasPrice || swapTx.gasPrice;
        const gasFee = parseFloat(gasUsed.mul(gasPrice).toString()) / 1e18; // Convert to ETH

        logger.info('QuickSwap CLMM swap executed successfully', {
            network,
            baseToken,
            quoteToken,
            side,
            inputAmount: actualInputAmount,
            outputAmount: actualOutputAmount,
            txHash: receipt.transactionHash,
            gasUsed: gasUsed.toString(),
            gasFee,
            feeTier: quote.feeTier,
        });

        return {
            signature: receipt.transactionHash,
            totalInputSwapped: actualInputAmount,
            totalOutputSwapped: actualOutputAmount,
            fee: gasFee,
            baseTokenBalanceChange,
            quoteTokenBalanceChange,
            wrapTxHash, // Include wrap transaction hash if ETH was wrapped
        };
    } catch (error) {
        logger.error('QuickSwap CLMM swap execution failed', {
            error: error.message,
            network,
            baseToken,
            quoteToken,
            side,
            amount,
        });
        throw error;
    }
}

const executeSwapRoute: FastifyPluginAsync = async (fastify) => {
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
        Body: ExecuteSwapRequestType;
        Reply: ExecuteSwapResponseType;
    }>(
        '/execute-swap',
        {
            schema: {
                description: 'Execute a swap via QuickSwap V3 CLMM (Concentrated Liquidity Market Maker)',
                summary: 'QuickSwap V3 CLMM Execute Swap',
                tags: ['quickswap/clmm'],
                body: {
                    ...ExecuteSwapRequest,
                    properties: {
                        ...ExecuteSwapRequest.properties,
                        network: {
                            type: 'string',
                            description: 'Blockchain network (e.g., polygon, mumbai)',
                            default: 'polygon',
                            examples: ['polygon', 'mumbai'],
                        },
                        walletAddress: {
                            type: 'string',
                            description: 'Ethereum wallet address to execute the swap from',
                            examples: [firstWalletAddress],
                        },
                        baseToken: {
                            type: 'string',
                            description: 'Base token symbol (e.g., ALI, WPOL, USDC)',
                            examples: ['ALI', 'WPOL', 'USDC'],
                        },
                        quoteToken: {
                            type: 'string',
                            description: 'Quote token symbol (e.g., WPOL, USDC, ALI)',
                            examples: ['WPOL', 'USDC', 'ALI'],
                        },
                        amount: {
                            type: 'number',
                            description: 'Amount to swap (in base token units for SELL, quote token units for BUY)',
                            examples: [100, 1.5, 1000],
                        },
                        side: {
                            type: 'string',
                            enum: ['BUY', 'SELL'],
                            description: 'Trade direction',
                            examples: ['SELL', 'BUY'],
                        },
                        poolAddress: {
                            type: 'string',
                            description: 'Optional: Specific pool address for the token pair',
                            examples: ['0x4b9Bce8888bEE8b252a7D599AA534C2faB9a07A5'],
                        },
                        slippagePct: {
                            type: 'number',
                            description: 'Slippage tolerance percentage (0-100)',
                            examples: [2.0, 5.0],
                        },
                    },
                },
                response: {
                    200: {
                        description: 'Successful swap execution response',
                        ...ExecuteSwapResponse,
                    },
                    400: {
                        description: 'Bad Request - Invalid parameters',
                        type: 'object',
                        properties: {
                            statusCode: { type: 'number', example: 400 },
                            error: { type: 'string', example: 'BadRequestError' },
                            message: { type: 'string', example: 'Base token ALI not found' },
                        },
                    },
                    404: {
                        description: 'Pool Not Found',
                        type: 'object',
                        properties: {
                            statusCode: { type: 'number', example: 404 },
                            error: { type: 'string', example: 'Not Found' },
                            message: { type: 'string', example: 'No CLMM pool found for pair ALI-WPOL' },
                        },
                    },
                    500: {
                        description: 'Internal Server Error',
                        type: 'object',
                        properties: {
                            statusCode: { type: 'number', example: 500 },
                            error: { type: 'string', example: 'InternalServerError' },
                            message: { type: 'string', example: 'Swap execution failed: Insufficient balance' },
                        },
                    },
                },
                'x-examples': {
                    'Sell ALI for WPOL': {
                        summary: 'Sell 100 ALI tokens for WPOL',
                        value: {
                            network: 'polygon',
                            walletAddress: firstWalletAddress,
                            baseToken: 'ALI',
                            quoteToken: 'WPOL',
                            amount: 100,
                            side: 'SELL',
                            slippagePct: 2.0,
                        },
                    },
                    'Buy WPOL with USDC': {
                        summary: 'Buy WPOL tokens with USDC',
                        value: {
                            network: 'polygon',
                            walletAddress: firstWalletAddress,
                            baseToken: 'WPOL',
                            quoteToken: 'USDC',
                            amount: 1,
                            side: 'BUY',
                            slippagePct: 1.5,
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
                    amount,
                    side,
                    slippagePct,
                    walletAddress: requestedWalletAddress,
                } = request.body;

                const networkToUse = network || 'polygon';

                // Validate essential parameters
                if (!baseToken || !quoteToken || !amount || !side) {
                    throw fastify.httpErrors.badRequest('Missing required parameters');
                }

                // Get wallet address - either from request or first available
                let walletAddress = requestedWalletAddress;
                if (!walletAddress) {
                    const ethereum = await Ethereum.getInstance(networkToUse);
                    walletAddress = await ethereum.getFirstWalletAddress();
                    if (!walletAddress) {
                        throw fastify.httpErrors.badRequest(
                            'No wallet address provided and no default wallet found',
                        );
                    }
                    logger.info(`Using first available wallet address: ${walletAddress}`);
                }

                // Find pool address if not provided
                const quickswap = await QuickSwap.getInstance(networkToUse);
                let poolAddress = requestedPoolAddress;
                if (!poolAddress) {
                    poolAddress = await quickswap.findDefaultPool(
                        baseToken,
                        quoteToken,
                        'clmm',
                    );

                    if (!poolAddress) {
                        throw fastify.httpErrors.notFound(
                            `No CLMM pool found for pair ${baseToken}-${quoteToken}`,
                        );
                    }
                }

                return await executeSwap(
                    fastify,
                    networkToUse,
                    walletAddress,
                    poolAddress,
                    baseToken,
                    quoteToken,
                    amount,
                    side as 'BUY' | 'SELL',
                    slippagePct,
                );
            } catch (error) {
                logger.error('QuickSwap CLMM execute swap route failed', error);
                if (error.statusCode) {
                    throw error; // Already a formatted Fastify error
                } else {
                    throw fastify.httpErrors.internalServerError(
                        `Execute swap failed: ${error.message}`,
                    );
                }
            }
        },
    );
};

export default executeSwapRoute; 