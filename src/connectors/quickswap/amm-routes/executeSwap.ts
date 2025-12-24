import { BigNumber, Contract } from 'ethers';
import { FastifyPluginAsync } from 'fastify';

import { Ethereum } from '../../../chains/ethereum/ethereum';
import { wrapEthereum } from '../../../chains/ethereum/routes/wrap';
import { ExecuteSwapRequestType, ExecuteSwapRequest } from '../../../schemas/amm-schema';
import { SwapExecuteResponseType, SwapExecuteResponse } from '../../../schemas/router-schema';
import { logger } from '../../../services/logger';
import { formatTokenAmount } from '../../uniswap/uniswap.utils';
import { QuickSwap } from '../quickswap';
import { getQuickSwapV2RouterAddress, IUniswapV2Router02ABI } from '../quickswap.contracts';

import { getQuickSwapAmmQuote } from './quoteSwap';

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
    // Get quote using the shared quote function - this eliminates duplication
    const { quote, ethereum, baseTokenObj, quoteTokenObj } = await getQuickSwapAmmQuote(
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

    // Check token allowance before executing swap
    const routerAddress = getQuickSwapV2RouterAddress(network);
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

    const amountNeeded =
      side === 'SELL'
        ? quote.inputAmount.quotient
        : BigNumber.from(Math.floor(quote.maxAmountIn * Math.pow(10, quote.inputToken.decimals)).toString());
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
        `Insufficient allowance for ${quote.inputToken.symbol}. Please approve at least ${formatTokenAmount(amountNeeded.toString(), quote.inputToken.decimals)} ${quote.inputToken.symbol} (${inputTokenAddress}) for the QuickSwap V2 Router (${routerAddress})`,
      );
    } else {
      logger.info(
        `Sufficient allowance exists: ${formatTokenAmount(currentAllowance.toString(), quote.inputToken.decimals)} ${quote.inputToken.symbol}`,
      );
    }

    // Extract info from quote
    let wrapTxHash = null;

    // Handle ETH->WETH wrapping if needed
    if (baseToken === 'ETH' && side === 'SELL') {
      const quickswap = await QuickSwap.getInstance(network);
      const wethToken = quickswap.getTokenBySymbol('WETH');
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

    // Get QuickSwap router contract
    const routerContract = new Contract(routerAddress, IUniswapV2Router02ABI.abi, wallet);

    // Prepare swap parameters
    const inputAmount = BigNumber.from(quote.inputAmount.quotient.toString());
    const minOutputAmount = BigNumber.from(quote.minOutputAmount.quotient.toString());
    const deadline = Math.floor(Date.now() / 1000) + 60 * 20; // 20 minutes from now
    const path = [inputTokenAddress, outputTokenAddress];

    let swapTx;

    // Execute the appropriate swap function
    if (side === 'SELL') {
      // Exact tokens in, minimum tokens out
      if (outputTokenAddress === ethereum.nativeTokenSymbol) {
        // Swap tokens for ETH
        swapTx = await routerContract.swapExactTokensForETH(
          inputAmount,
          minOutputAmount,
          path,
          walletAddress,
          deadline,
        );
      } else {
        // Swap tokens for tokens
        swapTx = await routerContract.swapExactTokensForTokens(
          inputAmount,
          minOutputAmount,
          path,
          walletAddress,
          deadline,
        );
      }
    } else {
      // BUY: Exact tokens out, maximum tokens in
      if (inputTokenAddress === ethereum.nativeTokenSymbol) {
        // Swap ETH for exact tokens
        swapTx = await routerContract.swapETHForExactTokens(minOutputAmount, path, walletAddress, deadline, {
          value: inputAmount,
        });
      } else {
        // Swap tokens for exact tokens
        swapTx = await routerContract.swapTokensForExactTokens(
          minOutputAmount,
          inputAmount,
          path,
          walletAddress,
          deadline,
        );
      }
    }

    const receipt = await swapTx.wait();

    // Calculate actual amounts from logs
    const actualInputAmount = formatTokenAmount(quote.inputAmount.quotient.toString(), quote.inputToken.decimals);
    const actualOutputAmount = formatTokenAmount(quote.outputAmount.quotient.toString(), quote.outputToken.decimals);

    // Calculate balance changes
    const baseTokenBalanceChange = side === 'SELL' ? -actualInputAmount : actualOutputAmount;
    const quoteTokenBalanceChange = side === 'SELL' ? actualOutputAmount : -actualInputAmount;

    // Calculate gas fee
    const gasUsed = receipt.gasUsed;
    const gasPrice = receipt.effectiveGasPrice || swapTx.gasPrice;
    const gasFee = parseFloat(gasUsed.mul(gasPrice).toString()) / 1e18; // Convert to ETH

    logger.info('QuickSwap AMM swap executed successfully', {
      network,
      baseToken,
      quoteToken,
      side,
      inputAmount: actualInputAmount,
      outputAmount: actualOutputAmount,
      txHash: receipt.transactionHash,
      gasUsed: gasUsed.toString(),
      gasFee,
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
    logger.error('QuickSwap AMM swap execution failed', {
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
        description: 'Execute a swap on QuickSwap V2 AMM using Router02',
        tags: ['quickswap/amm'],
        body: {
          ...ExecuteSwapRequest,
          properties: {
            ...ExecuteSwapRequest.properties,
            network: { type: 'string', default: 'polygon' },
            walletAddress: { type: 'string', examples: [firstWalletAddress] },
            baseToken: { type: 'string', examples: ['WPOL'] },
            quoteToken: { type: 'string', examples: ['USDC'] },
            amount: { type: 'number', examples: [0.001] },
            side: { type: 'string', enum: ['BUY', 'SELL'], examples: ['SELL'] },
            poolAddress: { type: 'string', examples: [''] },
            slippagePct: { type: 'number', examples: [1] },
          },
        },
        response: {
          200: SwapExecuteResponse,
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
          poolAddress = await quickswap.findDefaultPool(baseToken, quoteToken, 'amm');

          if (!poolAddress) {
            throw fastify.httpErrors.notFound(`No AMM pool found for pair ${baseToken}-${quoteToken}`);
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
        logger.error('QuickSwap AMM execute swap route failed', error);
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
