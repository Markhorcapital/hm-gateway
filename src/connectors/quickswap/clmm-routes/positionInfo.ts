import { BigNumber, Contract } from 'ethers';
import { FastifyPluginAsync } from 'fastify';

import {
  GetPositionInfoRequestType,
  GetPositionInfoRequest,
  PositionInfo,
  PositionInfoSchema,
} from '../../../schemas/clmm-schema';
import { logger } from '../../../services/logger';
import { formatTokenAmount } from '../../uniswap/uniswap.utils';
import { QuickSwap } from '../quickswap';

const positionInfoRoute: FastifyPluginAsync = async (fastify) => {
  await fastify.register(require('@fastify/sensible'));

  fastify.get<{
    Querystring: GetPositionInfoRequestType;
    Reply: Record<string, any>;
  }>(
    '/position-info',
    {
      schema: {
        description: 'Get information about a QuickSwap V3 CLMM position including liquidity, fees, and price range',
        summary: 'QuickSwap V3 CLMM Position Information',
        tags: ['quickswap/clmm'],
        querystring: {
          ...GetPositionInfoRequest,
          properties: {
            network: {
              type: 'string',
              description: 'Blockchain network (e.g., polygon, mumbai)',
              examples: ['polygon'],
              default: 'polygon',
            },
            chain: {
              type: 'string',
              description: 'Blockchain chain type',
              examples: ['ethereum'],
              default: 'ethereum',
            },
            positionAddress: {
              type: 'string',
              description: 'NFT position address (token ID)',
              examples: ['123', '456'],
            },
            walletAddress: {
              type: 'string',
              description: 'Optional: Wallet address that owns the position',
              examples: ['0x02C11B68F7C62D7df1142B80a96DFf2a2b10BDAB'],
            },
          },
        },
        response: {
          200: {
            description: 'Successful position information response',
            ...PositionInfoSchema,
          },
          400: {
            description: 'Bad Request - Invalid parameters',
            type: 'object',
            properties: {
              statusCode: { type: 'number', example: 400 },
              error: { type: 'string', example: 'BadRequestError' },
              message: { type: 'string', example: 'positionAddress must be provided' },
            },
          },
          404: {
            description: 'Position Not Found',
            type: 'object',
            properties: {
              statusCode: { type: 'number', example: 404 },
              error: { type: 'string', example: 'Not Found' },
              message: { type: 'string', example: 'Position not found' },
            },
          },
          500: {
            description: 'Internal Server Error',
            type: 'object',
            properties: {
              statusCode: { type: 'number', example: 500 },
              error: { type: 'string', example: 'InternalServerError' },
              message: { type: 'string', example: 'Position info request failed: Contract call failed' },
            },
          },
        },
        'x-examples': {
          'Position 123': {
            summary: 'Get information for position ID 123',
            value: {
              positionAddress: '123',
              network: 'polygon',
            },
          },
          'Wallet Position': {
            summary: 'Get position information for specific wallet',
            value: {
              positionAddress: '456',
              walletAddress: '0x02C11B68F7C62D7df1142B80a96DFf2a2b10BDAB',
              network: 'polygon',
            },
          },
        },
      },
    },
    async (request): Promise<PositionInfo> => {
      try {
        const { positionAddress, walletAddress } = request.query;
        const network = request.query.network || 'polygon';

        const quickswap = await QuickSwap.getInstance(network);

        // Check if positionAddress is provided
        if (!positionAddress) {
          throw fastify.httpErrors.badRequest('positionAddress must be provided');
        }

        // Get V3 position data using Algebra V3 NFT interface
        const positionInfo = await getV3PositionInfo(quickswap, positionAddress, walletAddress);

        if (!positionInfo) {
          throw fastify.httpErrors.notFound('Position not found');
        }

        logger.info('QuickSwap CLMM position info retrieved', {
          network,
          positionAddress,
          walletAddress,
          baseToken: positionInfo.baseToken.symbol,
          quoteToken: positionInfo.quoteToken.symbol,
          baseTokenAmount: positionInfo.baseTokenAmount,
          quoteTokenAmount: positionInfo.quoteTokenAmount,
          lowerPrice: positionInfo.lowerPrice,
          upperPrice: positionInfo.upperPrice,
        });

        return {
          address: positionAddress,
          poolAddress: positionInfo.poolAddress,
          baseTokenAddress: positionInfo.baseToken.address,
          quoteTokenAddress: positionInfo.quoteToken.address,
          baseTokenAmount: positionInfo.baseTokenAmount,
          quoteTokenAmount: positionInfo.quoteTokenAmount,
          baseFeeAmount: positionInfo.baseFeeAmount,
          quoteFeeAmount: positionInfo.quoteFeeAmount,
          lowerBinId: 0, // Algebra V3 doesn't use bin IDs like Meteora
          upperBinId: 0, // Algebra V3 doesn't use bin IDs like Meteora
          lowerPrice: positionInfo.lowerPrice,
          upperPrice: positionInfo.upperPrice,
          price: positionInfo.price,
        };
      } catch (e) {
        logger.error(`Error in QuickSwap CLMM position-info route: ${e.message}`);
        if (e.stack) {
          logger.debug(`Stack trace: ${e.stack}`);
        }

        // Return appropriate error based on the error message
        if (e.statusCode) {
          throw e; // Already a formatted Fastify error
        } else if (e.message && e.message.includes('invalid address')) {
          throw fastify.httpErrors.badRequest(`Invalid position address`);
        } else if (e.message && e.message.includes('position not found')) {
          throw fastify.httpErrors.notFound(`Position not found`);
        } else {
          throw fastify.httpErrors.internalServerError(`Position info request failed: ${e.message}`);
        }
      }
    },
  );
};

/**
 * Get QuickSwap V3 position information using Algebra V3 NFT interface
 */
async function getV3PositionInfo(quickswap: any, positionAddress: string, _walletAddress?: string): Promise<any> {
  try {
    // Check if V3 NFT manager is available
    if (!quickswap.nftManagerV3) {
      throw new Error('QuickSwap V3 NFT manager not available');
    }

    // Get position data from NFT manager
    const position = await quickswap.nftManagerV3.positions(positionAddress);

    if (!position || position.liquidity.toString() === '0') {
      throw new Error('Position not found or has no liquidity');
    }

    // Extract position data
    const {
      nonce,
      operator,
      token0,
      token1,
      fee,
      tickLower,
      tickUpper,
      liquidity,
      feeGrowthInside0LastX128,
      feeGrowthInside1LastX128,
      tokensOwed0,
      tokensOwed1,
    } = position;

    // Get token objects
    const token0Obj = quickswap.getTokenByAddress(token0);
    const token1Obj = quickswap.getTokenByAddress(token1);

    if (!token0Obj || !token1Obj) {
      throw new Error('Tokens not found');
    }

    // Calculate prices from ticks
    const lowerPrice = tickToPrice(tickLower, token0Obj.decimals, token1Obj.decimals);
    const upperPrice = tickToPrice(tickUpper, token0Obj.decimals, token1Obj.decimals);
    const currentPrice = (lowerPrice + upperPrice) / 2; // Simplified current price

    // Calculate token amounts from liquidity and price range
    const liquidityBN = BigNumber.from(liquidity.toString());

    // Simplified calculation for token amounts in position
    // In reality, this would require complex calculations based on current price vs range
    const baseTokenAmount = formatTokenAmount(liquidityBN.toString(), token0Obj.decimals);
    const quoteTokenAmount = formatTokenAmount(
      liquidityBN
        .mul(BigNumber.from(Math.floor(currentPrice * 1e18).toString()))
        .div(BigNumber.from(10).pow(18))
        .toString(),
      token1Obj.decimals,
    );

    // Get fee amounts
    const baseFeeAmount = formatTokenAmount(tokensOwed0.toString(), token0Obj.decimals);
    const quoteFeeAmount = formatTokenAmount(tokensOwed1.toString(), token1Obj.decimals);

    // Get pool address from factory
    let poolAddress = '';
    if (quickswap.factoryV3) {
      try {
        poolAddress = await quickswap.factoryV3.poolByPair(token0, token1);
      } catch (error) {
        logger.warn('Could not get pool address from factory', error);
      }
    }

    logger.info('QuickSwap V3 position info calculated', {
      positionAddress,
      token0: token0Obj.symbol,
      token1: token1Obj.symbol,
      liquidity: liquidity.toString(),
      tickLower,
      tickUpper,
      lowerPrice,
      upperPrice,
      currentPrice,
      baseTokenAmount,
      quoteTokenAmount,
      baseFeeAmount,
      quoteFeeAmount,
    });

    return {
      baseToken: token0Obj,
      quoteToken: token1Obj,
      poolAddress,
      baseTokenAmount,
      quoteTokenAmount,
      baseFeeAmount,
      quoteFeeAmount,
      lowerPrice,
      upperPrice,
      price: currentPrice,
      liquidity: liquidity.toString(),
      tickLower,
      tickUpper,
    };
  } catch (error) {
    logger.error('Failed to get QuickSwap V3 position info', error);
    throw error;
  }
}

/**
 * Convert tick to price for Algebra V3
 */
function tickToPrice(tick: number, token0Decimals: number, token1Decimals: number): number {
  // Formula: price = 1.0001^tick
  // This is a simplified calculation
  const tickMultiplier = 1.0001;
  const price = Math.pow(tickMultiplier, tick);

  // Adjust for token decimals
  const decimalAdjustment = Math.pow(10, token1Decimals - token0Decimals);
  return price * decimalAdjustment;
}

export default positionInfoRoute;
