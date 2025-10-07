import { Type, Static } from '@sinclair/typebox';
import { FastifyPluginAsync } from 'fastify';
import { BigNumber, utils, Contract } from 'ethers';

import { QuickSwap } from '../quickswap';
import { logger } from '../../../services/logger';
import { Ethereum } from '../../../chains/ethereum/ethereum';
import { formatTokenAmount } from '../../uniswap/uniswap.utils';

// Schemas
const QuoteSwapRequestSchema = Type.Object({
    baseToken: Type.String({
        description: 'Base token symbol (e.g., ALI, WPOL, USDC)',
        examples: ['ALI', 'WPOL', 'USDC'],
    }),
    quoteToken: Type.String({
        description: 'Quote token symbol (e.g., WPOL, USDC, ALI)',
        examples: ['WPOL', 'USDC', 'ALI'],
    }),
    amount: Type.Number({
        description: 'Amount to swap (in base token units for SELL, quote token units for BUY)',
        examples: [100, 1.5, 1000],
    }),
    side: Type.Union([
        Type.Literal('BUY', { description: 'Buy base token with quote token' }),
        Type.Literal('SELL', { description: 'Sell base token for quote token' })
    ], {
        description: 'Trade direction',
        examples: ['SELL', 'BUY'],
    }),
    network: Type.Optional(Type.String({
        description: 'Blockchain network (e.g., polygon, mumbai)',
        examples: ['polygon', 'mumbai'],
        default: 'polygon',
    })),
    poolAddress: Type.Optional(Type.String({
        description: 'Optional: Specific pool address for the token pair',
        examples: ['0x...'],
    })),
    slippagePct: Type.Optional(Type.Number({
        description: 'Slippage percentage (e.g., 1 for 1%)',
        examples: [1, 0.5],
    })),
});

const QuoteSwapResponseSchema = Type.Object({
    poolAddress: Type.Optional(Type.String({
        description: 'Pool address used for the quote (if available)',
        examples: ['0x...'],
    })),
    estimatedAmountIn: Type.Number({
        description: 'Estimated input amount for the swap',
        examples: [100],
    }),
    estimatedAmountOut: Type.Number({
        description: 'Estimated output amount from the swap',
        examples: [2.199246827241313],
    }),
    minAmountOut: Type.Number({
        description: 'Minimum output amount with slippage tolerance',
        examples: [2.179246827241313],
    }),
    maxAmountIn: Type.Number({
        description: 'Maximum input amount with slippage tolerance',
        examples: [100.5],
    }),
    baseTokenBalanceChange: Type.Number({
        description: 'Change in base token balance',
        examples: [-100],
    }),
    quoteTokenBalanceChange: Type.Number({
        description: 'Change in quote token balance',
        examples: [2.199246827241313],
    }),
    price: Type.Number({
        description: 'Price per base token in quote token units',
        examples: [0.021992468272413128],
    }),
    gasPrice: Type.Number({
        description: 'Current gas price in gwei',
        examples: [30.000000145],
    }),
    gasLimit: Type.Number({
        description: 'Estimated gas limit for the transaction',
        examples: [3000000],
    }),
    gasCost: Type.Number({
        description: 'Estimated gas cost in native tokens',
        examples: [0.090000000435],
    }),
});

type QuoteSwapRequest = Static<typeof QuoteSwapRequestSchema>;
type QuoteSwapResponse = Static<typeof QuoteSwapResponseSchema>;

/**
 * Get QuickSwap CLMM quote - shared function for both quote and execute routes
 */
export async function getQuickSwapClmmQuote(
    _fastify: any,
    network: string,
    poolAddress: string,
    baseToken: string,
    quoteToken: string,
    amount: number,
    side: 'BUY' | 'SELL',
    slippagePct?: number,
): Promise<{
    quote: any;
    quickswap: any;
    ethereum: any;
    baseTokenObj: any;
    quoteTokenObj: any;
}> {
    // Get instances
    const quickswap = await QuickSwap.getInstance(network);
    const ethereum = await Ethereum.getInstance(network);

    if (!ethereum.ready()) {
        logger.info('Ethereum instance not ready, initializing...');
        await ethereum.init();
    }

    // Resolve tokens
    const baseTokenObj = quickswap.getTokenBySymbol(baseToken);
    const quoteTokenObj = quickswap.getTokenBySymbol(quoteToken);

    if (!baseTokenObj) {
        logger.error(`Base token not found: ${baseToken}`);
        throw new Error(`Base token not found: ${baseToken}`);
    }

    if (!quoteTokenObj) {
        logger.error(`Quote token not found: ${quoteToken}`);
        throw new Error(`Quote token not found: ${quoteToken}`);
    }

    logger.info(
        `Base token: ${baseTokenObj.symbol}, address=${baseTokenObj.address}, decimals=${baseTokenObj.decimals}`,
    );
    logger.info(
        `Quote token: ${quoteTokenObj.symbol}, address=${quoteTokenObj.address}, decimals=${quoteTokenObj.decimals}`,
    );

    // Get the quote using QuickSwap V3
    const quote = await quoteClmmSwap(
        quickswap,
        baseTokenObj,
        quoteTokenObj,
        amount,
        side,
        poolAddress,
        slippagePct,
    );

    if (!quote) {
        throw new Error('Failed to get CLMM swap quote');
    }

    return {
        quote,
        quickswap,
        ethereum,
        baseTokenObj,
        quoteTokenObj,
    };
}

/**
 * Get QuickSwap V3 CLMM swap quote
 */
async function quoteClmmSwap(
    quickswap: any,
    baseToken: any,
    quoteToken: any,
    amount: number,
    side: 'BUY' | 'SELL',
    poolAddress?: string,
    slippagePct?: number,
): Promise<any> {
    const slippage = slippagePct || quickswap.config.allowedSlippage;
    const slippagePercent = parseFloat(slippage) / 100;

    // Convert amount to Wei based on token decimals
    const inputToken = side === 'SELL' ? baseToken : quoteToken;
    const outputToken = side === 'SELL' ? quoteToken : baseToken;

    // Convert amount to Wei based on token decimals
    const amountStr = amount.toString();
    const decimals = inputToken.decimals;

    let inputAmountWei: BigNumber;

    // Handle decimal conversion properly for BigNumber
    if (amountStr.includes('.')) {
        const [wholePart, decimalPart] = amountStr.split('.');
        const paddedDecimalPart = decimalPart.padEnd(decimals, '0').slice(0, decimals);
        const fullNumber = wholePart + paddedDecimalPart;
        inputAmountWei = BigNumber.from(fullNumber);
    } else {
        // No decimal part, just multiply by 10^decimals
        const multiplier = BigNumber.from(10).pow(decimals);
        inputAmountWei = BigNumber.from(amountStr).mul(multiplier);
    }

    try {
        // Find pool address if not provided
        let actualPoolAddress = poolAddress;
        if (!actualPoolAddress) {
            actualPoolAddress = await quickswap.findDefaultPool(
                baseToken.symbol,
                quoteToken.symbol,
                'clmm'
            );

            if (!actualPoolAddress) {
                throw new Error(`No CLMM pool found for ${baseToken.symbol}-${quoteToken.symbol}`);
            }

            logger.info(`Found pool address: ${actualPoolAddress} for ${baseToken.symbol}-${quoteToken.symbol}`);
        }

        // For Algebra V3, we use dynamic fees, so just use the default fee tier
        let feeTier = 1000; // Default to 0.3%

        // Use V3 quoter to get quote
        let quotedAmount: BigNumber;

        if (quickswap.quoterV3) {
            try {
                if (side === 'SELL') {
                    // Try using quoteExactInputSingle for Algebra V3
                    const result = await quickswap.quoterV3.quoteExactInputSingle(
                        inputToken.address,
                        outputToken.address,
                        inputAmountWei,
                        0 // No limit sqrt price
                    );
                    // Algebra V3 returns [amountOut, fee]
                    quotedAmount = result[0];
                } else {
                    // Try using quoteExactOutputSingle for Algebra V3
                    const result = await quickswap.quoterV3.quoteExactOutputSingle(
                        inputToken.address,
                        outputToken.address,
                        inputAmountWei,
                        0 // No limit sqrt price
                    );
                    // Algebra V3 returns [amountIn, fee]
                    quotedAmount = result[0];
                }
            } catch (error) {
                // If quoter fails, try direct pool call as fallback
                logger.warn('Quoter failed, trying direct pool call', error);

                if (actualPoolAddress) {
                    // Try to get quote directly from pool using globalState
                    const { Contract } = await import('ethers');
                    const poolContract = new Contract(
                        actualPoolAddress,
                        ['function globalState() external view returns (uint160 price, int24 tick, uint16 fee, uint16 timepointIndex, uint8 communityFeeToken0, uint8 communityFeeToken1, bool unlocked)'],
                        quickswap.ethereum.provider
                    );

                    const globalState = await poolContract.globalState();
                    const sqrtPriceX96 = globalState.price;

                    // Calculate quote using sqrt price with proper BigNumber handling
                    // Convert sqrtPriceX96 to a proper price ratio
                    const sqrtPrice = sqrtPriceX96.toString();
                    const priceRatio = BigNumber.from(sqrtPrice).mul(BigNumber.from(sqrtPrice)).div(BigNumber.from(2).pow(192));

                    if (side === 'SELL') {
                        // For SELL: amountOut = amountIn * priceRatio
                        quotedAmount = inputAmountWei.mul(priceRatio).div(BigNumber.from(10).pow(18));
                    } else {
                        // For BUY: amountIn = amountOut / priceRatio
                        quotedAmount = inputAmountWei.mul(BigNumber.from(10).pow(18)).div(priceRatio);
                    }
                } else {
                    throw error;
                }
            }
        } else {
            throw new Error('QuickSwap V3 Quoter not available');
        }

        const inputAmount = formatTokenAmount(inputAmountWei.toString(), inputToken.decimals);
        const outputAmount = formatTokenAmount(quotedAmount.toString(), outputToken.decimals);

        // Calculate slippage protection
        const minOutputAmount = outputAmount * (1 - slippagePercent);
        const maxInputAmount = inputAmount * (1 + slippagePercent);

        logger.info('QuickSwap CLMM quote calculated', {
            side,
            inputAmount,
            outputAmount,
            minOutputAmount,
            maxInputAmount,
            feeTier,
            slippage: slippagePercent,
            poolAddress: actualPoolAddress,
        });

        return {
            inputToken,
            outputToken,
            inputAmount: { quotient: inputAmountWei, currency: inputToken },
            outputAmount: { quotient: quotedAmount, currency: outputToken },
            minOutputAmount: { quotient: BigNumber.from(Math.floor(minOutputAmount * Math.pow(10, outputToken.decimals)).toString()), currency: outputToken },
            estimatedAmountIn: inputAmount,
            estimatedAmountOut: (outputAmount * (1 + slippagePercent)),
            minAmountOut: minOutputAmount,
            maxAmountIn: maxInputAmount,
            feeTier,
            poolAddress: actualPoolAddress,
        };
    } catch (error) {
        logger.error('QuickSwap CLMM quote failed', error);
        throw new Error(`Quote failed: ${error.message}`);
    }
}

const quoteSwapRoute: FastifyPluginAsync = async (fastify) => {
    fastify.get<{
        Querystring: QuoteSwapRequest;
        Reply: QuoteSwapResponse;
    }>(
        '/quote-swap',
        {
            schema: {
                description: 'Get a quote for swapping tokens via QuickSwap V3 CLMM (Concentrated Liquidity Market Maker)',
                summary: 'QuickSwap V3 CLMM Quote',
                tags: ['quickswap/clmm'],
                querystring: QuoteSwapRequestSchema,
                response: {
                    200: {
                        description: 'Successful quote response',
                        ...QuoteSwapResponseSchema,
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
                    500: {
                        description: 'Internal Server Error',
                        type: 'object',
                        properties: {
                            statusCode: { type: 'number', example: 500 },
                            error: { type: 'string', example: 'InternalServerError' },
                            message: { type: 'string', example: 'Quote swap failed: Insufficient liquidity' },
                        },
                    },
                },
                'x-examples': {
                    'ALI to WPOL': {
                        summary: 'Sell 100 ALI for WPOL',
                        value: {
                            baseToken: 'ALI',
                            quoteToken: 'WPOL',
                            amount: 100,
                            side: 'SELL',
                            network: 'polygon',
                        },
                    },
                    'WPOL to USDC': {
                        summary: 'Buy WPOL with USDC',
                        value: {
                            baseToken: 'WPOL',
                            quoteToken: 'USDC',
                            amount: 1,
                            side: 'BUY',
                            network: 'polygon',
                        },
                    },
                },
            },
        },
        async (request, _reply) => {
            const startTimestamp = Date.now();
            const { baseToken, quoteToken, amount, side, network, poolAddress, slippagePct } = request.query;

            try {
                logger.info('QuickSwap CLMM quote swap request received', {
                    baseToken,
                    quoteToken,
                    amount,
                    side,
                    network,
                    poolAddress,
                    slippagePct,
                });

                const networkToUse = network || 'polygon';

                // Get QuickSwap instance
                const quickswap = await QuickSwap.getInstance(networkToUse);

                if (!quickswap.ready) {
                    throw fastify.httpErrors.internalServerError('QuickSwap connector not ready');
                }

                // Get tokens
                const baseTokenObj = quickswap.getTokenBySymbol(baseToken);
                const quoteTokenObj = quickswap.getTokenBySymbol(quoteToken);

                if (!baseTokenObj) {
                    throw fastify.httpErrors.badRequest(`Base token ${baseToken} not found`);
                }

                if (!quoteTokenObj) {
                    throw fastify.httpErrors.badRequest(`Quote token ${quoteToken} not found`);
                }

                // Get actual quote using the shared function
                const quoteResult = await getQuickSwapClmmQuote(
                    fastify,
                    networkToUse,
                    poolAddress || '',
                    baseToken,
                    quoteToken,
                    amount,
                    side,
                    slippagePct,
                );

                // Get Ethereum instance for gas price
                const { Ethereum } = await import('../../../chains/ethereum/ethereum');
                const ethereum = await Ethereum.getInstance(networkToUse);

                const gasPriceBN = await ethereum.provider.getGasPrice();
                const gasPrice = parseFloat(gasPriceBN.toString()) / 1e9; // Convert to gwei
                const gasLimit = quickswap.gasLimitEstimate;

                const response: QuoteSwapResponse = {
                    poolAddress: quoteResult.quote.poolAddress || '',
                    estimatedAmountIn: quoteResult.quote.estimatedAmountIn,
                    estimatedAmountOut: quoteResult.quote.estimatedAmountOut,
                    minAmountOut: quoteResult.quote.minAmountOut || quoteResult.quote.estimatedAmountOut,
                    maxAmountIn: quoteResult.quote.maxAmountIn || quoteResult.quote.estimatedAmountIn,
                    baseTokenBalanceChange: side === 'SELL' ? -amount : quoteResult.quote.estimatedAmountOut,
                    quoteTokenBalanceChange: side === 'SELL' ? quoteResult.quote.estimatedAmountOut : -amount,
                    price: quoteResult.quote.estimatedAmountOut / quoteResult.quote.estimatedAmountIn,
                    gasPrice,
                    gasLimit,
                    gasCost: (gasPrice * gasLimit) / 1e9, // ETH cost
                };

                logger.info('QuickSwap CLMM quote swap completed', response);
                return response;
            } catch (error) {
                logger.error('QuickSwap CLMM quote swap failed', error);
                throw fastify.httpErrors.internalServerError(
                    `Quote swap failed: ${error.message}`,
                );
            }
        },
    );
};

export default quoteSwapRoute; 