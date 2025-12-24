import { Contract } from '@ethersproject/contracts';
import { Percent } from '@uniswap/sdk-core';
import { BigNumber } from 'ethers';
import { FastifyPluginAsync } from 'fastify';

import { Ethereum } from '../../../chains/ethereum/ethereum';
import {
  AddLiquidityRequestType,
  AddLiquidityRequest,
  AddLiquidityResponseType,
  AddLiquidityResponse,
} from '../../../schemas/amm-schema';
import { logger } from '../../../services/logger';
import { getUniswapAmmLiquidityQuote } from '../../uniswap/amm-routes/quoteLiquidity';
import { formatTokenAmount, getUniswapPoolInfo } from '../../uniswap/uniswap.utils';
import { QuickSwap } from '../quickswap';
import { getQuickSwapV2RouterAddress, IUniswapV2Router02ABI } from '../quickswap.contracts';

// Import the quote function from Uniswap since QuickSwap uses same interface

async function addLiquidity(
  network: string,
  walletAddress: string,
  poolAddress: string,
  baseToken: string,
  quoteToken: string,
  baseTokenAmount: number,
  quoteTokenAmount: number,
  slippagePct?: number,
): Promise<AddLiquidityResponseType> {
  const networkToUse = network || 'polygon';

  // Get quote first to calculate optimal amounts and get execution data
  const quote = await getUniswapAmmLiquidityQuote(
    networkToUse,
    poolAddress,
    baseToken,
    quoteToken,
    baseTokenAmount,
    quoteTokenAmount,
  );

  // Get QuickSwap and Ethereum instances
  const quickswap = await QuickSwap.getInstance(networkToUse);
  const ethereum = await Ethereum.getInstance(networkToUse);

  // Get the wallet
  const wallet = await ethereum.getWallet(walletAddress);
  if (!wallet) {
    throw new Error('Wallet not found');
  }

  // Get token objects
  const baseTokenObj = quickswap.getTokenBySymbol(baseToken);
  const quoteTokenObj = quickswap.getTokenBySymbol(quoteToken);

  if (!baseTokenObj || !quoteTokenObj) {
    throw new Error('Token not found');
  }

  // Calculate slippage tolerance
  const slippagePercent = slippagePct || quickswap.config.slippagePct || 0.5;
  const slippageTolerance = new Percent(Math.floor(slippagePercent * 100), 10000);

  // Calculate minimum amounts based on slippage
  const baseTokenAmountMin = quote.rawBaseTokenAmount
    .mul(BigNumber.from(1000).sub(BigNumber.from(slippageTolerance.numerator.toString())))
    .div(1000);

  const quoteTokenAmountMin = quote.rawQuoteTokenAmount
    .mul(BigNumber.from(1000).sub(BigNumber.from(slippageTolerance.numerator.toString())))
    .div(1000);

  // Get router address
  const routerAddress = getQuickSwapV2RouterAddress(networkToUse);
  const routerContract = new Contract(routerAddress, IUniswapV2Router02ABI.abi, wallet);

  // Check allowances
  const baseTokenContract = new Contract(
    baseTokenObj.address,
    ['function allowance(address,address) view returns (uint256)'],
    wallet,
  );

  const quoteTokenContract = new Contract(
    quoteTokenObj.address,
    ['function allowance(address,address) view returns (uint256)'],
    wallet,
  );

  const baseAllowance = await baseTokenContract.allowance(walletAddress, routerAddress);
  const quoteAllowance = await quoteTokenContract.allowance(walletAddress, routerAddress);

  // Approve tokens if needed
  if (baseAllowance.lt(quote.baseTokenAmountMax)) {
    logger.info(`Approving ${baseToken} for router...`);
    const baseTokenApproveContract = new Contract(
      baseTokenObj.address,
      ['function approve(address,uint256) returns (bool)'],
      wallet,
    );
    const approveTx = await baseTokenApproveContract.approve(routerAddress, quote.baseTokenAmountMax);
    await approveTx.wait();
    logger.info(`${baseToken} approval confirmed`);
  }

  if (quoteAllowance.lt(quote.quoteTokenAmountMax)) {
    logger.info(`Approving ${quoteToken} for router...`);
    const quoteTokenApproveContract = new Contract(
      quoteTokenObj.address,
      ['function approve(address,uint256) returns (bool)'],
      wallet,
    );
    const approveTx = await quoteTokenApproveContract.approve(routerAddress, quote.quoteTokenAmountMax);
    await approveTx.wait();
    logger.info(`${quoteToken} approval confirmed`);
  }

  // Execute addLiquidity
  logger.info(`Adding liquidity: ${baseTokenAmount} ${baseToken} + ${quoteTokenAmount} ${quoteToken}`);

  const deadline = Math.floor(Date.now() / 1000) + 1200; // 20 minutes

  const addLiquidityTx = await routerContract.addLiquidity(
    baseTokenObj.address,
    quoteTokenObj.address,
    quote.baseTokenAmountMax,
    quote.quoteTokenAmountMax,
    baseTokenAmountMin,
    quoteTokenAmountMin,
    walletAddress,
    deadline,
  );

  const receipt = await addLiquidityTx.wait();

  logger.info(`Liquidity added successfully. Transaction hash: ${receipt.transactionHash}`);

  return {
    signature: receipt.transactionHash,
    status: 1, // CONFIRMED
    data: {
      fee: formatTokenAmount(receipt.gasUsed.mul(receipt.effectiveGasPrice).toString(), 18),
      baseTokenAmountAdded: quote.baseTokenAmountMax,
      quoteTokenAmountAdded: quote.quoteTokenAmountMax,
    },
  };
}

export const addLiquidityRoute: FastifyPluginAsync = async (fastify) => {
  await fastify.register(require('@fastify/sensible'));

  // Get first wallet address for example
  let firstWalletAddress = '<ethereum-wallet-address>';

  try {
    firstWalletAddress = (await Ethereum.getFirstWalletAddress()) || firstWalletAddress;
  } catch (error) {
    logger.warn('No wallets found for examples in schema');
  }

  fastify.post<{
    Body: AddLiquidityRequestType;
    Reply: AddLiquidityResponseType;
  }>(
    '/add-liquidity',
    {
      schema: {
        description: 'Add liquidity to QuickSwap V2 pool',
        tags: ['quickswap/amm'],
        body: {
          ...AddLiquidityRequest,
          properties: {
            ...AddLiquidityRequest.properties,
            network: { type: 'string', default: 'polygon' },
            walletAddress: { type: 'string', examples: [firstWalletAddress] },
            poolAddress: {
              type: 'string',
              examples: ['0x...'],
            },
            baseToken: { type: 'string', examples: ['WPOL'] },
            quoteToken: { type: 'string', examples: ['USDC'] },
            baseTokenAmount: { type: 'number', examples: [1.0] },
            quoteTokenAmount: { type: 'number', examples: [1000.0] },
            slippagePct: { type: 'number', examples: [2.0] },
          },
        },
        response: {
          200: AddLiquidityResponse,
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
              message: { type: 'string', example: 'Add liquidity failed: Insufficient balance' },
            },
          },
        },
        'x-examples': {
          'Add WPOL-USDC Liquidity': {
            summary: 'Add liquidity to WPOL-USDC pool',
            value: {
              network: 'polygon',
              walletAddress: firstWalletAddress,
              baseToken: 'WPOL',
              quoteToken: 'USDC',
              baseTokenAmount: 1.0,
              quoteTokenAmount: 1000.0,
              slippagePct: 2.0,
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
          baseTokenAmount,
          quoteTokenAmount,
          slippagePct,
          walletAddress: requestedWalletAddress,
        } = request.body;

        const networkToUse = network || 'polygon';

        // Validate essential parameters
        if (!requestedPoolAddress || !baseTokenAmount || !quoteTokenAmount) {
          throw fastify.httpErrors.badRequest(
            'Missing required parameters: poolAddress, baseTokenAmount, quoteTokenAmount',
          );
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

        // Get pool info to determine tokens
        const poolAddress = requestedPoolAddress;
        const poolInfo = await getUniswapPoolInfo(poolAddress, networkToUse, 'amm');
        if (!poolInfo) {
          throw fastify.httpErrors.notFound(`Pool not found: ${poolAddress}`);
        }

        // Get token addresses from pool info and resolve to symbols
        const quickswap = await QuickSwap.getInstance(networkToUse);
        const baseTokenObj = quickswap.getTokenByAddress(poolInfo.baseTokenAddress);
        const quoteTokenObj = quickswap.getTokenByAddress(poolInfo.quoteTokenAddress);

        if (!baseTokenObj || !quoteTokenObj) {
          throw fastify.httpErrors.badRequest('Could not resolve tokens from pool address');
        }

        const baseTokenToUse = baseTokenObj.symbol;
        const quoteTokenToUse = quoteTokenObj.symbol;

        const result = await addLiquidity(
          networkToUse,
          walletAddress,
          poolAddress,
          baseTokenToUse,
          quoteTokenToUse,
          baseTokenAmount,
          quoteTokenAmount,
          slippagePct,
        );

        return result;
      } catch (error) {
        logger.error('Add liquidity failed:', error);
        throw fastify.httpErrors.internalServerError(`Add liquidity failed: ${error.message}`);
      }
    },
  );
};
