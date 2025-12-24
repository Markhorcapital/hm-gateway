import { BigNumber, Contract, utils } from 'ethers';
import { FastifyPluginAsync } from 'fastify';

import { Ethereum } from '../../../chains/ethereum/ethereum';
import { wrapEthereum } from '../../../chains/ethereum/routes/wrap';
import { ExecuteSwapRequestType, ExecuteSwapRequest } from '../../../schemas/clmm-schema';
import { SwapExecuteResponseType, SwapExecuteResponse } from '../../../schemas/router-schema';
import { logger } from '../../../services/logger';
import { formatTokenAmount } from '../../uniswap/uniswap.utils';
import { QuickSwap } from '../quickswap';
import { getQuickSwapV3SmartOrderRouterAddress, IAlgebraV3RouterABI } from '../quickswap.contracts';

import { getQuickSwapClmmQuote } from './quoteSwap';

/**
 * Safely convert a decimal amount to Wei, avoiding scientific notation issues
 * @param amount The decimal amount to convert
 * @param decimals The token decimals
 * @returns BigNumber representation in Wei
 */
function convertToWeiSafely(amount: number, decimals: number): BigNumber {
  try {
    // Handle the conversion using string manipulation to avoid scientific notation
    const amountStr = amount.toString();

    if (amountStr.includes('e') || amountStr.includes('E')) {
      // Handle scientific notation by using parseFloat and then converting
      const normalizedAmount = parseFloat(amountStr);
      return utils.parseUnits(normalizedAmount.toFixed(decimals), decimals);
    }

    // Handle decimal conversion properly for BigNumber
    if (amountStr.includes('.')) {
      const [wholePart, decimalPart] = amountStr.split('.');
      const paddedDecimalPart = decimalPart.padEnd(decimals, '0').slice(0, decimals);
      const fullNumber = wholePart + paddedDecimalPart;
      return BigNumber.from(fullNumber);
    } else {
      // No decimal part, just multiply by 10^decimals
      const multiplier = BigNumber.from(10).pow(decimals);
      return BigNumber.from(amountStr).mul(multiplier);
    }
  } catch (error) {
    logger.error(`Error converting to Wei safely: ${error}, amount: ${amount}, decimals: ${decimals}`);
    // Fallback to utils.parseUnits which handles most cases
    return utils.parseUnits(amount.toFixed(decimals), decimals);
  }
}

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
    const { quote, ethereum, baseTokenObj, quoteTokenObj } = await getQuickSwapClmmQuote(
      fastify,
      network,
      poolAddress,
      baseToken,
      quoteToken,
      amount,
      side,
      slippagePct,
    );

    // Debug: Log the quote structure
    logger.info('Quote structure received:', {
      hasInputAmount: !!quote.inputAmount,
      hasOutputAmount: !!quote.outputAmount,
      hasMinOutputAmount: !!quote.minOutputAmount,
      quoteKeys: Object.keys(quote),
      inputAmountType: typeof quote.inputAmount,
      outputAmountType: typeof quote.outputAmount,
    });

    // Get the wallet
    const wallet = await ethereum.getWallet(walletAddress);
    if (!wallet) {
      throw fastify.httpErrors.badRequest('Wallet not found');
    }

    // Check token allowance before executing swap
    const routerAddress = getQuickSwapV3SmartOrderRouterAddress(network);
    let inputTokenAddress = quote.inputToken.address;
    const outputTokenAddress = quote.outputToken.address;

    // Get current allowance for input token
    const inputTokenContract = ethereum.getContract(inputTokenAddress, wallet);
    const allowance = await ethereum.getERC20Allowance(
      inputTokenContract,
      wallet,
      routerAddress,
      quote.inputToken.decimals,
    );

    // Handle different quote structures
    let amountNeeded: BigNumber;
    if (quote.inputAmount && quote.inputAmount.quotient) {
      if (side === 'SELL') {
        amountNeeded = quote.inputAmount.quotient;
      } else {
        // For BUY side, we need the maximum input amount - use safe conversion
        amountNeeded = convertToWeiSafely(quote.maxAmountIn, quote.inputToken.decimals);
      }
    } else if (quote.estimatedAmountIn) {
      // Fallback to estimatedAmountIn if inputAmount.quotient is not available - use safe conversion
      const inputAmountWei = convertToWeiSafely(quote.estimatedAmountIn, quote.inputToken.decimals);
      amountNeeded = inputAmountWei;
    } else {
      throw new Error('Invalid quote structure: missing input amount information');
    }

    const currentAllowance = BigNumber.from(allowance.value);

    logger.info(
      `Current allowance: ${formatTokenAmount(currentAllowance.toString(), quote.inputToken.decimals)} ${quote.inputToken.symbol}`,
    );
    logger.info(
      `Amount needed: ${formatTokenAmount(amountNeeded.toString(), quote.inputToken.decimals)} ${quote.inputToken.symbol}`,
    );

    // Check if allowance is sufficient
    if (currentAllowance.lt(amountNeeded)) {
      logger.error(`Insufficient allowance for ${quote.inputToken.symbol}`);
      throw fastify.httpErrors.badRequest(
        `Insufficient allowance for ${quote.inputToken.symbol}. Please approve at least ${formatTokenAmount(amountNeeded.toString(), quote.inputToken.decimals)} ${quote.inputToken.symbol} (${inputTokenAddress}) for the QuickSwap V3 Router (${routerAddress})`,
      );
    } else {
      logger.info(
        `Sufficient allowance exists: ${formatTokenAmount(currentAllowance.toString(), quote.inputToken.decimals)} ${quote.inputToken.symbol}`,
      );
    }

    // Extract info from quote
    let wrapTxHash = null;

    // Handle ETH->WETH wrapping if needed
    if (baseToken === 'POL' && side === 'SELL') {
      const quickswap = await QuickSwap.getInstance(network);
      const wethToken = quickswap.getTokenBySymbol('WPOL');
      if (!wethToken) {
        throw new Error('WETH token not found');
      }

      logger.info(`ETH detected as input token, wrapping ${amount} ETH to WETH first`);

      const wrapResult = await wrapEthereum(fastify, network, walletAddress, amount.toString());

      if (!wrapResult.signature) {
        throw new Error('Failed to wrap ETH to WETH');
      }

      wrapTxHash = wrapResult.signature;
      inputTokenAddress = wethToken.address;

      logger.info(`ETH wrapped successfully, tx hash: ${wrapTxHash}`);
    }

    // Get QuickSwap V3 router contract (SwapRouter02 equivalent)
    const routerContract = new Contract(routerAddress, IAlgebraV3RouterABI, wallet);

    // Prepare swap parameters for V3
    let inputAmount: BigNumber;
    let minOutputAmount: BigNumber;
    let outputAmount: BigNumber;

    if (quote.inputAmount && quote.inputAmount.quotient && quote.minOutputAmount && quote.minOutputAmount.quotient) {
      // Use the quotient values directly as they are already BigNumbers
      inputAmount = utils.parseUnits(quote.inputAmount.quotient.toString(), 0);
      minOutputAmount = utils.parseUnits(quote.minOutputAmount.quotient.toString(), 0);
      outputAmount = convertToWeiSafely(quote.estimatedAmountOut.toString(), quote.inputToken.decimals);
    } else if (quote.estimatedAmountIn && quote.minAmountOut) {
      // Fallback to estimatedAmountIn and minAmountOut with safe conversion
      inputAmount = convertToWeiSafely(quote.estimatedAmountIn, quote.inputToken.decimals);
      minOutputAmount = convertToWeiSafely(quote.minAmountOut, quote.outputToken.decimals);
      outputAmount = convertToWeiSafely(quote.estimatedAmountOut, quote.inputToken.decimals);
    } else {
      throw new Error('Invalid quote structure: missing amount information for swap execution');
    }

    const deadline = Math.floor(Date.now() / 1000) + 60 * 20; // 20 minutes from now

    // Get current gas price for Polygon
    const currentGasPrice = await ethereum.provider.getGasPrice();
    const maxPriorityFeePerGas = utils.parseUnits('30', 'gwei'); // 30 Gwei priority fee
    const maxFeePerGas = currentGasPrice.add(maxPriorityFeePerGas);

    logger.info(`Gas parameters for Polygon:`, {
      maxPriorityFeePerGas: utils.formatUnits(maxPriorityFeePerGas, 'gwei') + ' Gwei',
      maxFeePerGas: utils.formatUnits(maxFeePerGas, 'gwei') + ' Gwei',
      currentGasPrice: utils.formatUnits(currentGasPrice, 'gwei') + ' Gwei',
    });

    let swapTx;

    // Execute V3 swap using exactInputSingle or exactOutputSingle
    if (side === 'SELL') {
      // Exact input swap - no fee parameter
      const params = {
        tokenIn: inputTokenAddress,
        tokenOut: outputTokenAddress,
        recipient: walletAddress,
        deadline,
        amountIn: inputAmount,
        amountOutMinimum: minOutputAmount,
        limitSqrtPrice: 0, // No price limit
      };

      swapTx = await routerContract.exactInputSingle(params, {
        maxFeePerGas: maxFeePerGas,
        maxPriorityFeePerGas: maxPriorityFeePerGas,
      });
    } else {
      // Exact output swap (BUY) - no fee parameter for Algebra V3
      const params = {
        tokenIn: inputTokenAddress,
        tokenOut: outputTokenAddress,
        fee: 1000,
        recipient: walletAddress,
        deadline,
        amountOut: inputAmount,
        amountInMaximum: outputAmount,
        limitSqrtPrice: 0, // No price limit
      };

      swapTx = await routerContract.exactOutputSingle(params, {
        maxFeePerGas: maxFeePerGas,
        maxPriorityFeePerGas: maxPriorityFeePerGas,
      });
    }

    const receipt = await swapTx.wait();

    // Calculate actual amounts from logs
    const actualInputAmount = formatTokenAmount(inputAmount.toString(), quote.inputToken.decimals);
    const actualOutputAmount = formatTokenAmount(minOutputAmount.toString(), quote.outputToken.decimals);

    // Calculate balance changes
    const baseTokenBalanceChange = side === 'SELL' ? -actualInputAmount : actualOutputAmount;
    const quoteTokenBalanceChange = side === 'SELL' ? actualOutputAmount : -actualInputAmount;

    // Calculate gas fee
    const gasUsed = receipt.gasUsed;
    const gasPrice = receipt.effectiveGasPrice || swapTx.gasPrice;
    const gasFee = parseFloat(gasUsed.mul(gasPrice).toString()) / 1e18; // Convert to ETH
    // Check if the transaction was successful
    if (receipt.status === 0) {
      logger.error(`Transaction failed on-chain. Receipt: ${JSON.stringify(receipt)}`);
      throw fastify.httpErrors.internalServerError(
        'Transaction reverted on-chain. This could be due to slippage, insufficient funds, or other blockchain issues.',
      );
    }

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
    const txSignature = wrapTxHash ? `swap:${receipt.transactionHash},wrap:${wrapTxHash}` : receipt.transactionHash;

    return {
      signature: txSignature,
      status: 1, // CONFIRMED
      data: {
        tokenIn: inputTokenAddress,
        tokenOut: outputTokenAddress,
        amountIn: actualInputAmount,
        amountOut: actualOutputAmount,
        fee: gasFee,
        baseTokenBalanceChange,
        quoteTokenBalanceChange,
      },
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
    firstWalletAddress = (await Ethereum.getFirstWalletAddress()) || firstWalletAddress;
  } catch (error) {
    logger.warn('No wallets found for examples in schema');
  }

  fastify.post<{
    Body: ExecuteSwapRequestType;
    Reply: SwapExecuteResponseType;
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
              examples: ['0x...'],
            },
            slippagePct: {
              type: 'number',
              description: 'Slippage tolerance percentage (0-100)',
              examples: [2.0, 5.0],
            },
          },
        },
        response: {
          200: SwapExecuteResponse,
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
          walletAddress = await Ethereum.getFirstWalletAddress();
          if (!walletAddress) {
            throw fastify.httpErrors.badRequest('No wallet address provided and no default wallet found');
          }
          logger.info(`Using first available wallet address: ${walletAddress}`);
        }

        // Find pool address if not provided
        const quickswap = await QuickSwap.getInstance(networkToUse);
        let poolAddress = requestedPoolAddress;
        if (!poolAddress) {
          poolAddress = await quickswap.findDefaultPool(baseToken, quoteToken, 'clmm');

          if (!poolAddress) {
            throw fastify.httpErrors.notFound(`No CLMM pool found for pair ${baseToken}-${quoteToken}`);
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
          throw fastify.httpErrors.internalServerError(`Execute swap failed: ${error.message}`);
        }
      }
    },
  );
};

export default executeSwapRoute;
