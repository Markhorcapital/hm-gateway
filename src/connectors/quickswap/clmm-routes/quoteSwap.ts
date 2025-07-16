import { Type, Static } from '@sinclair/typebox';
import { FastifyPluginAsync } from 'fastify';
import { BigNumber, utils, Contract } from 'ethers';

import { QuickSwap } from '../quickswap';
import { logger } from '../../../services/logger';
import { Ethereum } from '../../../chains/ethereum/ethereum';
import { formatTokenAmount } from '../../uniswap/uniswap.utils';

// Schemas
const QuoteSwapRequestSchema = Type.Object({
    base: Type.String({
        description: 'Base token symbol (e.g., ALI, WPOL, USDC)',
        examples: ['ALI', 'WPOL', 'USDC'],
    }),
    quote: Type.String({
        description: 'Quote token symbol (e.g., WPOL, USDC, ALI)',
        examples: ['WPOL', 'USDC', 'ALI'],
    }),
    amount: Type.String({
        description: 'Amount to swap (in base token units for SELL, quote token units for BUY)',
        examples: ['100', '1.5', '1000'],
    }),
    side: Type.Union([
        Type.Literal('BUY', { description: 'Buy base token with quote token' }),
        Type.Literal('SELL', { description: 'Sell base token for quote token' })
    ], {
        description: 'Trade direction',
        examples: ['SELL', 'BUY'],
    }),
    network: Type.String({
        description: 'Blockchain network (e.g., polygon, mumbai)',
        examples: ['polygon', 'mumbai'],
        default: 'polygon',
    }),
    poolAddress: Type.Optional(Type.String({
        description: 'Optional: Specific pool address for the token pair',
        examples: ['0x4b9Bce8888bEE8b252a7D599AA534C2faB9a07A5'],
    })),
});

const QuoteSwapResponseSchema = Type.Object({
    network: Type.String({
        description: 'Blockchain network used for the quote',
        examples: ['polygon'],
    }),
    timestamp: Type.Number({
        description: 'Unix timestamp when the quote was generated',
        examples: [1752698443968],
    }),
    latency: Type.Number({
        description: 'Response time in milliseconds',
        examples: [1057],
    }),
    base: Type.String({
        description: 'Base token symbol',
        examples: ['ALI'],
    }),
    quote: Type.String({
        description: 'Quote token symbol',
        examples: ['WPOL'],
    }),
    amount: Type.String({
        description: 'Input amount for the swap',
        examples: ['100'],
    }),
    expectedAmount: Type.String({
        description: 'Expected output amount from the swap',
        examples: ['2.199246827241313'],
    }),
    price: Type.String({
        description: 'Price per base token in quote token units',
        examples: ['0.021992468272413128'],
    }),
    gasPrice: Type.Number({
        description: 'Current gas price in gwei',
        examples: [30.000000145],
    }),
    gasPriceToken: Type.String({
        description: 'Native token symbol for gas payments',
        examples: ['POL'],
    }),
    gasLimit: Type.Number({
        description: 'Estimated gas limit for the transaction',
        examples: [3000000],
    }),
    gasCost: Type.String({
        description: 'Estimated gas cost in native tokens',
        examples: ['0.090000000435'],
    }),
    poolAddress: Type.Optional(Type.String({
        description: 'Pool address used for the quote (if available)',
        examples: ['0x4b9Bce8888bEE8b252a7D599AA534C2faB9a07A5'],
    })),
    feeTier: Type.Optional(Type.Number({
        description: 'Fee tier in basis points (e.g., 3000 = 0.3%)',
        examples: [3000],
    })),
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

    // Use string-based calculation to avoid scientific notation
    const amountStr = amount.toString();
    const decimals = inputToken.decimals;

    let inputAmountWei: BigNumber;
    // If amount already has enough decimal places, use it directly
    if (amountStr.includes('.') && amountStr.split('.')[1].length >= decimals) {
        inputAmountWei = BigNumber.from(amountStr.replace('.', ''));
    } else {
        // Otherwise, multiply by 10^decimals using string arithmetic
        const multiplier = '1' + '0'.repeat(decimals);
        inputAmountWei = BigNumber.from(amountStr).mul(BigNumber.from(multiplier));
    }

    try {
        // If poolAddress is provided, get fee tier from pool
        let feeTier = 3000; // Default to 0.3%

        if (poolAddress && quickswap.factoryV3) {
            // For Algebra V3, we can't determine fee tier from pool address easily
            // since it uses dynamic fees. Just use the default fee tier.
            feeTier = 3000; // Default to 0.3%
        }

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

                if (poolAddress) {
                    // Try to get quote directly from pool using globalState
                    const { Contract } = await import('ethers');
                    const poolContract = new Contract(
                        poolAddress,
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
            poolAddress,
        });

        return {
            inputToken,
            outputToken,
            inputAmount: { quotient: inputAmountWei, currency: inputToken },
            outputAmount: { quotient: quotedAmount, currency: outputToken },
            minOutputAmount: { quotient: BigNumber.from(Math.floor(minOutputAmount * Math.pow(10, outputToken.decimals)).toString()) },
            estimatedAmountIn: inputAmount,
            estimatedAmountOut: outputAmount,
            minAmountOut: minOutputAmount,
            maxAmountIn: maxInputAmount,
            feeTier,
            poolAddress,
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
                            base: 'ALI',
                            quote: 'WPOL',
                            amount: '100',
                            side: 'SELL',
                            network: 'polygon',
                        },
                    },
                    'WPOL to USDC': {
                        summary: 'Buy WPOL with USDC',
                        value: {
                            base: 'WPOL',
                            quote: 'USDC',
                            amount: '1',
                            side: 'BUY',
                            network: 'polygon',
                        },
                    },
                },
            },
        },
        async (request, _reply) => {
            const startTimestamp = Date.now();
            const { base, quote, amount, side, network, poolAddress } = request.query;

            try {
                logger.info('QuickSwap CLMM quote swap request received', {
                    base,
                    quote,
                    amount,
                    side,
                    network,
                    poolAddress,
                });

                // Get QuickSwap instance
                const quickswap = await QuickSwap.getInstance(network);

                if (!quickswap.ready) {
                    throw fastify.httpErrors.internalServerError('QuickSwap connector not ready');
                }

                // Get tokens
                const baseToken = quickswap.getTokenBySymbol(base);
                const quoteToken = quickswap.getTokenBySymbol(quote);

                if (!baseToken) {
                    throw fastify.httpErrors.badRequest(`Base token ${base} not found`);
                }

                if (!quoteToken) {
                    throw fastify.httpErrors.badRequest(`Quote token ${quote} not found`);
                }

                // Parse amount properly to avoid scientific notation
                const amountNumber = parseFloat(amount);
                if (isNaN(amountNumber)) {
                    throw fastify.httpErrors.badRequest('Invalid amount parameter');
                }

                // Get actual quote using the shared function
                const quoteResult = await getQuickSwapClmmQuote(
                    fastify,
                    network,
                    poolAddress || '',
                    base,
                    quote,
                    amountNumber,
                    side,
                );

                // Get Ethereum instance for gas price
                const { Ethereum } = await import('../../../chains/ethereum/ethereum');
                const ethereum = await Ethereum.getInstance(network);

                const gasPriceBN = await ethereum.provider.getGasPrice();
                const gasPrice = parseFloat(gasPriceBN.toString()) / 1e9; // Convert to gwei
                const gasLimit = quickswap.gasLimitEstimate;

                const response: QuoteSwapResponse = {
                    network,
                    timestamp: startTimestamp,
                    latency: Date.now() - startTimestamp,
                    base,
                    quote,
                    amount,
                    expectedAmount: quoteResult.quote.estimatedAmountOut.toString(),
                    price: (quoteResult.quote.estimatedAmountOut / quoteResult.quote.estimatedAmountIn).toString(),
                    gasPrice,
                    gasPriceToken: ethereum.nativeTokenSymbol,
                    gasLimit,
                    gasCost: ((gasPrice * gasLimit) / 1e9).toString(), // ETH cost
                    poolAddress: quoteResult.quote.poolAddress || '',
                    feeTier: quoteResult.quote.feeTier || 0,
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