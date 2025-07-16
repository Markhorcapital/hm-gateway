import { Type, Static } from '@sinclair/typebox';
import { FastifyPluginAsync } from 'fastify';
import { BigNumber } from 'ethers';

import { QuickSwap } from '../quickswap';
import { logger } from '../../../services/logger';
import { Ethereum } from '../../../chains/ethereum/ethereum';
import { formatTokenAmount } from '../../uniswap/uniswap.utils';

// Schemas
const QuoteSwapRequestSchema = Type.Object({
    base: Type.String(),
    quote: Type.String(),
    amount: Type.String(),
    side: Type.Union([Type.Literal('BUY'), Type.Literal('SELL')]),
    network: Type.String(),
});

const QuoteSwapResponseSchema = Type.Object({
    network: Type.String(),
    timestamp: Type.Number(),
    latency: Type.Number(),
    base: Type.String(),
    quote: Type.String(),
    amount: Type.String(),
    expectedAmount: Type.String(),
    price: Type.String(),
    gasPrice: Type.Number(),
    gasPriceToken: Type.String(),
    gasLimit: Type.Number(),
    gasCost: Type.String(),
});

type QuoteSwapRequest = Static<typeof QuoteSwapRequestSchema>;
type QuoteSwapResponse = Static<typeof QuoteSwapResponseSchema>;

/**
 * Get QuickSwap AMM quote - shared function for both quote and execute routes
 */
export async function getQuickSwapAmmQuote(
    _fastify: any,
    network: string,
    _poolAddress: string,
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

    // Get the quote using QuickSwap V2 router
    const quote = await quoteAmmSwap(
        quickswap,
        baseTokenObj,
        quoteTokenObj,
        amount,
        side,
        slippagePct,
    );

    if (!quote) {
        throw new Error('Failed to get swap quote');
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
 * Get QuickSwap V2 AMM swap quote
 */
async function quoteAmmSwap(
    quickswap: any,
    baseToken: any,
    quoteToken: any,
    amount: number,
    side: 'BUY' | 'SELL',
    slippagePct?: number,
): Promise<any> {
    const slippage = slippagePct || quickswap.config.allowedSlippage;
    const slippagePercent = parseFloat(slippage) / 100;

    // Convert amount to Wei based on token decimals
    const inputToken = side === 'SELL' ? baseToken : quoteToken;
    const outputToken = side === 'SELL' ? quoteToken : baseToken;

    // Convert amount to Wei using proper decimal handling
    const amountStr = amount.toString();
    const decimals = inputToken.decimals;

    let inputAmountWei: BigNumber;

    if (amountStr.includes('.')) {
        // Handle decimal amounts properly
        const [wholePart, decimalPart] = amountStr.split('.');
        const paddedDecimalPart = decimalPart.padEnd(decimals, '0').slice(0, decimals);
        const fullNumber = wholePart + paddedDecimalPart;
        inputAmountWei = BigNumber.from(fullNumber);
    } else {
        // Handle whole numbers
        const multiplier = '1' + '0'.repeat(decimals);
        inputAmountWei = BigNumber.from(amountStr).mul(BigNumber.from(multiplier));
    }

    // Get amounts using QuickSwap V2 router
    try {
        const path = [inputToken.address, outputToken.address];
        let amounts: BigNumber[];

        if (side === 'SELL') {
            // Get amounts out for exact input
            amounts = await quickswap.routerV2.getAmountsOut(inputAmountWei, path);
        } else {
            // Get amounts in for exact output  
            amounts = await quickswap.routerV2.getAmountsIn(inputAmountWei, path);
        }

        const inputAmount = formatTokenAmount(amounts[0].toString(), inputToken.decimals);
        const outputAmount = formatTokenAmount(amounts[amounts.length - 1].toString(), outputToken.decimals);

        // Calculate slippage protection
        const minOutputAmount = outputAmount * (1 - slippagePercent);
        const maxInputAmount = inputAmount * (1 + slippagePercent);

        logger.info('QuickSwap AMM quote calculated', {
            side,
            inputAmount,
            outputAmount,
            minOutputAmount,
            maxInputAmount,
            slippage: slippagePercent,
        });

        return {
            inputToken,
            outputToken,
            inputAmount: { quotient: amounts[0], currency: inputToken },
            outputAmount: { quotient: amounts[amounts.length - 1], currency: outputToken },
            minOutputAmount: { quotient: BigNumber.from(Math.floor(minOutputAmount * Math.pow(10, outputToken.decimals)).toString()) },
            estimatedAmountIn: inputAmount,
            estimatedAmountOut: outputAmount,
            minAmountOut: minOutputAmount,
            maxAmountIn: maxInputAmount,
            pathAddresses: path,
        };
    } catch (error) {
        logger.error('QuickSwap AMM quote failed', error);
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
                description: 'Get a quote for swapping tokens via QuickSwap AMM',
                tags: ['quickswap/amm'],
                querystring: QuoteSwapRequestSchema,
                response: {
                    200: QuoteSwapResponseSchema,
                },
            },
        },
        async (request, _reply) => {
            const startTimestamp = Date.now();
            const { base, quote, amount, side, network } = request.query;

            try {
                logger.info('QuickSwap AMM quote swap request received', {
                    base,
                    quote,
                    amount,
                    side,
                    network,
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
                const quoteResult = await getQuickSwapAmmQuote(
                    fastify,
                    network,
                    '', // poolAddress not needed for basic quote
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
                };

                logger.info('QuickSwap AMM quote swap completed', response);
                return response;
            } catch (error) {
                logger.error('QuickSwap AMM quote swap failed', error);
                throw fastify.httpErrors.internalServerError(
                    `Quote swap failed: ${error.message}`,
                );
            }
        },
    );
};

export default quoteSwapRoute; 