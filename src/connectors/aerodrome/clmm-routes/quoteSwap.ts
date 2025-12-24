import { Token, CurrencyAmount, Percent, TradeType } from '@uniswap/sdk-core';
import { Pool as V3Pool, Route as V3Route, Trade as V3Trade } from '@uniswap/v3-sdk';
import { BigNumber, Contract } from 'ethers';
import { FastifyPluginAsync, FastifyInstance } from 'fastify';
import JSBI from 'jsbi';

import { Ethereum } from '../../../chains/ethereum/ethereum';
import {
  QuoteSwapRequestType,
  QuoteSwapResponseType,
  QuoteSwapRequest,
  QuoteSwapResponse,
} from '../../../schemas/clmm-schema';
import { logger } from '../../../services/logger';
import { sanitizeErrorMessage } from '../../../services/sanitize';
import { formatTokenAmount } from '../../uniswap/uniswap.utils';
import { Aerodrome } from '../aerodrome';
import { getAerodromeV3QuoterAddress, IAerodromeQuoterABI } from '../aerodrome.contracts';

async function quoteAerodromeSwap(
  aerodrome: Aerodrome,
  network: string,
  poolAddress: string,
  baseToken: Token,
  quoteToken: Token,
  amount: number,
  side: 'BUY' | 'SELL',
  slippagePct?: number,
): Promise<any> {
  try {
    // Get the V3 pool and tickSpacing
    const { pool, tickSpacing } = await aerodrome.getV3Pool(baseToken, quoteToken, poolAddress);
    if (!pool) {
      throw new Error(`Pool not found for ${baseToken.symbol}-${quoteToken.symbol}`);
    }

    // Determine which token is being traded (exact in/out)
    const exactIn = side === 'SELL';
    const [inputToken, outputToken] = exactIn ? [baseToken, quoteToken] : [quoteToken, baseToken];

    // Get quoter contract
    const quoterAddress = getAerodromeV3QuoterAddress(network);
    const quoterContract = new Contract(quoterAddress, IAerodromeQuoterABI, aerodrome.provider);

    // Convert amount to raw units
    const rawAmount = JSBI.BigInt(
      Math.floor(amount * Math.pow(10, (exactIn ? inputToken : outputToken).decimals)).toString(),
    );

    // Call Aerodrome quoter with tickSpacing
    let amountOut: BigNumber;
    let amountIn: BigNumber;

    if (exactIn) {
      // SELL: exactInputSingle - uses struct parameter
      const quoteParams = {
        tokenIn: inputToken.address,
        tokenOut: outputToken.address,
        amountIn: rawAmount.toString(),
        tickSpacing: tickSpacing,
        sqrtPriceLimitX96: 0, // sqrtPriceLimitX96 = 0 means no limit
      };
      const result = await quoterContract.callStatic.quoteExactInputSingle(quoteParams);
      amountOut = result.amountOut;
      amountIn = BigNumber.from(rawAmount.toString());
    } else {
      // BUY: exactOutputSingle - uses struct parameter
      const quoteParams = {
        tokenIn: inputToken.address,
        tokenOut: outputToken.address,
        amount: rawAmount.toString(), // Note: exactOutput uses 'amount' not 'amountOut'
        tickSpacing: tickSpacing,
        sqrtPriceLimitX96: 0, // sqrtPriceLimitX96 = 0 means no limit
      };
      const result = await quoterContract.callStatic.quoteExactOutputSingle(quoteParams);
      amountIn = result.amountIn;
      amountOut = BigNumber.from(rawAmount.toString());
    }

    // Calculate slippage-adjusted amounts
    const slippagePercent = slippagePct ?? aerodrome.config.slippagePct;
    const slippageTolerance = new Percent(Math.floor(slippagePercent * 100), 10000);

    const minAmountOut = exactIn
      ? amountOut
          .mul(Math.floor((10000 - slippagePercent * 100) * 100))
          .div(1000000)
          .toString()
      : amountOut.toString();

    const maxAmountIn = exactIn
      ? amountIn.toString()
      : amountIn
          .mul(Math.floor((10000 + slippagePercent * 100) * 100))
          .div(1000000)
          .toString();

    // Format amounts
    const estimatedAmountIn = formatTokenAmount(amountIn.toString(), inputToken.decimals);
    const estimatedAmountOut = formatTokenAmount(amountOut.toString(), outputToken.decimals);
    const minAmountOutValue = formatTokenAmount(minAmountOut, outputToken.decimals);
    const maxAmountInValue = formatTokenAmount(maxAmountIn, inputToken.decimals);

    // Calculate price impact (simplified - can be enhanced)
    const priceImpact = 0; // Aerodrome quoter doesn't return price impact directly

    return {
      poolAddress,
      estimatedAmountIn,
      estimatedAmountOut,
      minAmountOut: minAmountOutValue,
      maxAmountIn: maxAmountInValue,
      priceImpact,
      inputToken,
      outputToken,
      // Add raw values for execution
      rawAmountIn: amountIn.toString(),
      rawAmountOut: amountOut.toString(),
      rawMinAmountOut: minAmountOut,
      rawMaxAmountIn: maxAmountIn,
      tickSpacing,
    };
  } catch (error) {
    logger.error(`Error quoting Aerodrome CLMM swap: ${error.message}`);
    throw error;
  }
}

export async function getAerodromeClmmQuote(
  _fastify: FastifyInstance,
  network: string,
  poolAddress: string,
  baseToken: string,
  quoteToken: string,
  amount: number,
  side: 'BUY' | 'SELL',
  slippagePct?: number,
): Promise<{
  quote: any;
  aerodrome: any;
  ethereum: any;
  baseTokenObj: any;
  quoteTokenObj: any;
}> {
  // Get instances
  const aerodrome = await Aerodrome.getInstance(network);
  const ethereum = await Ethereum.getInstance(network);

  if (!ethereum.ready()) {
    logger.info('Ethereum instance not ready, initializing...');
    await ethereum.init();
  }

  // Resolve tokens
  const baseTokenObj = aerodrome.getTokenBySymbol(baseToken);
  const quoteTokenObj = aerodrome.getTokenBySymbol(quoteToken);

  if (!baseTokenObj) {
    logger.error(`Base token not found: ${baseToken}`);
    throw new Error(sanitizeErrorMessage('Base token not found: {}', baseToken));
  }

  if (!quoteTokenObj) {
    logger.error(`Quote token not found: ${quoteToken}`);
    throw new Error(sanitizeErrorMessage('Quote token not found: {}', quoteToken));
  }

  logger.info(`Base token: ${baseTokenObj.symbol}, address=${baseTokenObj.address}, decimals=${baseTokenObj.decimals}`);
  logger.info(
    `Quote token: ${quoteTokenObj.symbol}, address=${quoteTokenObj.address}, decimals=${quoteTokenObj.decimals}`,
  );

  // Get the quote
  const quote = await quoteAerodromeSwap(
    aerodrome,
    network,
    poolAddress,
    baseTokenObj,
    quoteTokenObj,
    amount,
    side as 'BUY' | 'SELL',
    slippagePct,
  );

  if (!quote) {
    throw new Error('Failed to get swap quote');
  }

  return {
    quote,
    aerodrome,
    ethereum,
    baseTokenObj,
    quoteTokenObj,
  };
}

async function formatSwapQuote(
  fastify: FastifyInstance,
  network: string,
  poolAddress: string,
  baseToken: string,
  quoteToken: string,
  amount: number,
  side: 'BUY' | 'SELL',
  slippagePct?: number,
): Promise<QuoteSwapResponseType> {
  logger.info(
    `formatSwapQuote: poolAddress=${poolAddress}, baseToken=${baseToken}, quoteToken=${quoteToken}, amount=${amount}, side=${side}, network=${network}`,
  );

  try {
    // Use the extracted quote function
    const { quote, aerodrome, ethereum, baseTokenObj, quoteTokenObj } = await getAerodromeClmmQuote(
      fastify,
      network,
      poolAddress,
      baseToken,
      quoteToken,
      amount,
      side,
      slippagePct,
    );

    logger.info(
      `Quote result: estimatedAmountIn=${quote.estimatedAmountIn}, estimatedAmountOut=${quote.estimatedAmountOut}`,
    );

    // Calculate balance changes based on which tokens are being swapped
    const baseTokenBalanceChange = side === 'BUY' ? quote.estimatedAmountOut : -quote.estimatedAmountIn;
    const quoteTokenBalanceChange = side === 'BUY' ? -quote.estimatedAmountIn : quote.estimatedAmountOut;

    logger.info(
      `Balance changes: baseTokenBalanceChange=${baseTokenBalanceChange}, quoteTokenBalanceChange=${quoteTokenBalanceChange}`,
    );

    // Get gas estimate for V3 swap
    const estimatedGasValue = 200000; // V3 swaps use more gas than V2
    const gasPrice = await ethereum.provider.getGasPrice();
    logger.info(`Gas price from provider: ${gasPrice.toString()}`);

    // Calculate gas cost
    const estimatedGasBN = BigNumber.from(estimatedGasValue.toString());
    const gasCostRaw = gasPrice.mul(estimatedGasBN);
    const gasCost = formatTokenAmount(gasCostRaw.toString(), 18); // ETH has 18 decimals
    logger.info(`Gas cost: ${gasCost} ETH`);

    // Calculate price based on side
    // For SELL: price = quote received / base sold
    // For BUY: price = quote needed / base received
    const price =
      side === 'SELL'
        ? quote.estimatedAmountOut / quote.estimatedAmountIn
        : quote.estimatedAmountIn / quote.estimatedAmountOut;

    // Format gas price as Gwei
    const gasPriceGwei = formatTokenAmount(gasPrice.toString(), 9); // Convert to Gwei
    logger.info(`Gas price in Gwei: ${gasPriceGwei}`);

    // Calculate price impact percentage
    const priceImpactPct = quote.priceImpact;

    // Determine token addresses for computed fields
    const tokenIn = quote.inputToken.address;
    const tokenOut = quote.outputToken.address;

    return {
      // Base QuoteSwapResponse fields in correct order
      poolAddress,
      tokenIn,
      tokenOut,
      amountIn: quote.estimatedAmountIn,
      amountOut: quote.estimatedAmountOut,
      price,
      slippagePct: slippagePct || 1, // Default 1% if not provided
      minAmountOut: quote.minAmountOut,
      maxAmountIn: quote.maxAmountIn,
      // CLMM-specific fields
      priceImpactPct,
    };
  } catch (error) {
    logger.error(`Error formatting swap quote: ${error.message}`);
    if (error.stack) {
      logger.debug(`Stack trace: ${error.stack}`);
    }
    throw error;
  }
}

export const quoteSwapRoute: FastifyPluginAsync = async (fastify) => {
  // Import the httpErrors plugin to ensure it's available
  await fastify.register(require('@fastify/sensible'));

  fastify.get<{
    Querystring: QuoteSwapRequestType;
    Reply: QuoteSwapResponseType;
  }>(
    '/quote-swap',
    {
      schema: {
        description: 'Get swap quote for Aerodrome V3 CLMM',
        tags: ['/connector/aerodrome'],
        querystring: {
          ...QuoteSwapRequest,
          properties: {
            ...QuoteSwapRequest.properties,
            network: { type: 'string', default: 'base' },
            baseToken: { type: 'string', examples: ['WETH'] },
            quoteToken: { type: 'string', examples: ['USDC'] },
            amount: { type: 'number', examples: [0.001] },
            side: { type: 'string', enum: ['BUY', 'SELL'], examples: ['SELL'] },
            slippagePct: { type: 'number', examples: [1] },
          },
        },
        response: { 200: QuoteSwapResponse },
      },
    },
    async (request) => {
      try {
        const { network, poolAddress, baseToken, quoteToken, amount, side, slippagePct } = request.query;

        const networkToUse = network;

        // Validate essential parameters
        if (!baseToken || !amount || !side) {
          throw fastify.httpErrors.badRequest('baseToken, amount, and side are required');
        }

        const aerodrome = await Aerodrome.getInstance(networkToUse);

        let poolAddressToUse = poolAddress;
        let baseTokenToUse: string;
        let quoteTokenToUse: string;

        if (poolAddressToUse) {
          // Pool address provided, get pool info to determine tokens
          const { pool } = await aerodrome.getV3Pool(baseToken, quoteToken || '', poolAddressToUse);
          if (!pool) {
            throw fastify.httpErrors.notFound(sanitizeErrorMessage('Pool not found: {}', poolAddressToUse));
          }

          // For Aerodrome, we need both tokens to determine the pair
          if (!quoteToken) {
            throw fastify.httpErrors.badRequest('quoteToken is required when using poolAddress');
          }

          baseTokenToUse = baseToken;
          quoteTokenToUse = quoteToken;
        } else {
          // No pool address provided, need quoteToken to find pool
          if (!quoteToken) {
            throw fastify.httpErrors.badRequest('quoteToken is required when poolAddress is not provided');
          }

          baseTokenToUse = baseToken;
          quoteTokenToUse = quoteToken;

          // Find pool using findDefaultPool
          poolAddressToUse = await aerodrome.findDefaultPool(baseTokenToUse, quoteTokenToUse, 'clmm');

          if (!poolAddressToUse) {
            throw fastify.httpErrors.notFound(`No CLMM pool found for pair ${baseTokenToUse}-${quoteTokenToUse}`);
          }
        }

        return await formatSwapQuote(
          fastify,
          networkToUse,
          poolAddressToUse,
          baseTokenToUse,
          quoteTokenToUse,
          amount,
          side as 'BUY' | 'SELL',
          slippagePct,
        );
      } catch (e) {
        logger.error(e);
        if (e.statusCode) {
          throw e;
        }
        logger.error('Unexpected error getting swap quote:', e);
        throw fastify.httpErrors.internalServerError('Error getting swap quote');
      }
    },
  );
};

export default quoteSwapRoute;

// Export quoteSwap wrapper for chain-level routes
export async function quoteSwap(
  fastify: FastifyInstance,
  network: string,
  poolAddress: string,
  baseToken: string,
  quoteToken: string,
  amount: number,
  side: 'BUY' | 'SELL',
  slippagePct?: number,
): Promise<QuoteSwapResponseType> {
  return await formatSwapQuote(fastify, network, poolAddress, baseToken, quoteToken, amount, side, slippagePct);
}
