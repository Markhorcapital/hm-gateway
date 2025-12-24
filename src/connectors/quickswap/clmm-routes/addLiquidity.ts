import { Contract } from '@ethersproject/contracts';
import { Static } from '@sinclair/typebox';
import { Token, CurrencyAmount, Percent } from '@uniswap/sdk-core';
import { Position, Pool as V3Pool, NonfungiblePositionManager, FeeAmount } from '@uniswap/v3-sdk';
import { BigNumber, utils } from 'ethers';
import { FastifyPluginAsync, FastifyInstance } from 'fastify';
import JSBI from 'jsbi';

import { Ethereum } from '../../../chains/ethereum/ethereum';
import { AddLiquidityResponseType, AddLiquidityResponse } from '../../../schemas/clmm-schema';
import { logger } from '../../../services/logger';
import { UniswapClmmAddLiquidityRequest } from '../../uniswap/schemas';
import { formatTokenAmount } from '../../uniswap/uniswap.utils';
import { QuickSwap } from '../quickswap';
import { getQuickSwapV3NftManagerAddress, IAlgebraV3PositionManagerABI } from '../quickswap.contracts';

// Default gas limit for CLMM add liquidity operations
const CLMM_ADD_LIQUIDITY_GAS_LIMIT = 600000;

export async function addLiquidity(
  fastify: FastifyInstance,
  network: string,
  walletAddress: string,
  positionAddress: string,
  baseTokenAmount: number,
  quoteTokenAmount: number,
  slippagePct?: number,
): Promise<AddLiquidityResponseType> {
  if (!positionAddress || (baseTokenAmount === undefined && quoteTokenAmount === undefined)) {
    throw fastify.httpErrors.badRequest('Missing required parameters');
  }

  const quickswap = await QuickSwap.getInstance(network);
  const ethereum = await Ethereum.getInstance(network);
  const wallet = await ethereum.getWallet(walletAddress);
  if (!wallet) {
    throw fastify.httpErrors.badRequest('Wallet not found');
  }

  const positionManagerAddress = getQuickSwapV3NftManagerAddress(network);
  const positionManager = new Contract(positionManagerAddress, IAlgebraV3PositionManagerABI, ethereum.provider);
  const position = await positionManager.positions(positionAddress);

  const token0 = quickswap.getTokenByAddress(position.token0);
  const token1 = quickswap.getTokenByAddress(position.token1);
  const fee = position.fee;
  const tickLower = position.tickLower;
  const tickUpper = position.tickUpper;

  // For Algebra V3, we need to find the pool by pair (no fee parameter)
  // First try to get pool address from factory
  let poolAddress: string | undefined;
  try {
    if (quickswap.factoryV3) {
      poolAddress = await quickswap.factoryV3.poolByPair(token0.address, token1.address);
      if (poolAddress && poolAddress !== '0x0000000000000000000000000000000000000000') {
        // Pool found
      } else {
        poolAddress = undefined;
      }
    }
  } catch (e) {
    // Ignore error, will try getV3Pool without address
  }

  const pool = await quickswap.getV3Pool(token0, token1, poolAddress);
  if (!pool) {
    throw fastify.httpErrors.notFound('Pool not found for position');
  }

  const slippageTolerance = new Percent(Math.floor((slippagePct ?? quickswap.config.slippagePct) * 100), 10000);

  const baseTokenSymbol = token0.symbol === 'WETH' ? token0.symbol : token1.symbol;
  const isBaseToken0 = token0.symbol === baseTokenSymbol;

  let token0Amount = CurrencyAmount.fromRawAmount(token0, 0);
  let token1Amount = CurrencyAmount.fromRawAmount(token1, 0);

  if (baseTokenAmount !== undefined) {
    const baseAmountRaw = Math.floor(baseTokenAmount * Math.pow(10, isBaseToken0 ? token0.decimals : token1.decimals));
    if (isBaseToken0) {
      token0Amount = CurrencyAmount.fromRawAmount(token0, JSBI.BigInt(baseAmountRaw.toString()));
    } else {
      token1Amount = CurrencyAmount.fromRawAmount(token1, JSBI.BigInt(baseAmountRaw.toString()));
    }
  }

  if (quoteTokenAmount !== undefined) {
    const quoteAmountRaw = Math.floor(
      quoteTokenAmount * Math.pow(10, isBaseToken0 ? token1.decimals : token0.decimals),
    );
    if (isBaseToken0) {
      token1Amount = CurrencyAmount.fromRawAmount(token1, JSBI.BigInt(quoteAmountRaw.toString()));
    } else {
      token0Amount = CurrencyAmount.fromRawAmount(token0, JSBI.BigInt(quoteAmountRaw.toString()));
    }
  }

  const newPosition = Position.fromAmounts({
    pool,
    tickLower,
    tickUpper,
    amount0: token0Amount.quotient,
    amount1: token1Amount.quotient,
    useFullPrecision: true,
  });

  const increaseLiquidityOptions = {
    tokenId: positionAddress,
    slippageTolerance,
    deadline: Math.floor(Date.now() / 1000) + 60 * 20,
  };

  const { calldata, value } = NonfungiblePositionManager.addCallParameters(newPosition, increaseLiquidityOptions);

  // Check allowances
  if (!token0Amount.equalTo(0) && token0.symbol !== 'WETH') {
    const token0Contract = ethereum.getContract(token0.address, wallet);
    const allowance0 = await ethereum.getERC20Allowance(
      token0Contract,
      wallet,
      positionManagerAddress,
      token0.decimals,
    );
    const currentAllowance0 = BigNumber.from(allowance0.value);
    const requiredAmount0 = BigNumber.from(token0Amount.quotient.toString());

    if (currentAllowance0.lt(requiredAmount0)) {
      throw fastify.httpErrors.badRequest(
        `Insufficient ${token0.symbol} allowance. Please approve at least ${formatTokenAmount(requiredAmount0.toString(), token0.decimals)} ${token0.symbol} for the Position Manager (${positionManagerAddress})`,
      );
    }
  }

  if (!token1Amount.equalTo(0) && token1.symbol !== 'WETH') {
    const token1Contract = ethereum.getContract(token1.address, wallet);
    const allowance1 = await ethereum.getERC20Allowance(
      token1Contract,
      wallet,
      positionManagerAddress,
      token1.decimals,
    );
    const currentAllowance1 = BigNumber.from(allowance1.value);
    const requiredAmount1 = BigNumber.from(token1Amount.quotient.toString());

    if (currentAllowance1.lt(requiredAmount1)) {
      throw fastify.httpErrors.badRequest(
        `Insufficient ${token1.symbol} allowance. Please approve at least ${formatTokenAmount(requiredAmount1.toString(), token1.decimals)} ${token1.symbol} for the Position Manager (${positionManagerAddress})`,
      );
    }
  }

  const positionManagerWithSigner = new Contract(
    positionManagerAddress,
    [
      {
        inputs: [{ internalType: 'bytes[]', name: 'data', type: 'bytes[]' }],
        name: 'multicall',
        outputs: [{ internalType: 'bytes[]', name: 'results', type: 'bytes[]' }],
        stateMutability: 'payable',
        type: 'function',
      },
    ],
    wallet,
  );

  const txParams = await ethereum.prepareGasOptions(undefined, CLMM_ADD_LIQUIDITY_GAS_LIMIT);
  txParams.value = BigNumber.from(value.toString());
  const tx = await positionManagerWithSigner.multicall([calldata], txParams);
  const receipt = await tx.wait();

  const gasFee = formatTokenAmount(receipt.gasUsed.mul(receipt.effectiveGasPrice).toString(), 18);
  const actualToken0Amount = formatTokenAmount(newPosition.mintAmounts.amount0.toString(), token0.decimals);
  const actualToken1Amount = formatTokenAmount(newPosition.mintAmounts.amount1.toString(), token1.decimals);

  const actualBaseAmount = isBaseToken0 ? actualToken0Amount : actualToken1Amount;
  const actualQuoteAmount = isBaseToken0 ? actualToken1Amount : actualToken0Amount;

  return {
    signature: receipt.transactionHash,
    status: 1,
    data: {
      fee: gasFee,
      baseTokenAmountAdded: actualBaseAmount,
      quoteTokenAmountAdded: actualQuoteAmount,
    },
  };
}

export const addLiquidityRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post<{
    Body: Static<typeof UniswapClmmAddLiquidityRequest>;
    Reply: AddLiquidityResponseType;
  }>(
    '/add-liquidity',
    {
      schema: {
        description: 'Add liquidity to an existing QuickSwap V3 position',
        tags: ['/connector/quickswap'],
        body: UniswapClmmAddLiquidityRequest,
        response: {
          200: AddLiquidityResponse,
        },
      },
    },
    async (request) => {
      try {
        const {
          network,
          walletAddress: requestedWalletAddress,
          positionAddress,
          baseTokenAmount,
          quoteTokenAmount,
          slippagePct,
        } = request.body;

        let walletAddress = requestedWalletAddress;
        if (!walletAddress) {
          walletAddress = await Ethereum.getFirstWalletAddress();
          if (!walletAddress) {
            throw fastify.httpErrors.badRequest('No wallet address provided and no default wallet found');
          }
        }

        return await addLiquidity(
          fastify,
          network,
          walletAddress,
          positionAddress,
          baseTokenAmount,
          quoteTokenAmount,
          slippagePct,
        );
      } catch (e: any) {
        logger.error('Failed to add liquidity:', e);
        if (e.statusCode) {
          throw e;
        }
        throw fastify.httpErrors.internalServerError('Failed to add liquidity');
      }
    },
  );
};

export default addLiquidityRoute;
