import { BigNumber, Contract } from 'ethers';
import { FastifyPluginAsync } from 'fastify';

import { Ethereum } from '../../../chains/ethereum/ethereum';
import { GetPoolInfoRequestType, GetPoolInfoRequest, PoolInfo, PoolInfoSchema } from '../../../schemas/clmm-schema';
import { logger } from '../../../services/logger';
import { formatTokenAmount } from '../../uniswap/uniswap.utils';
import { QuickSwap } from '../quickswap';

const poolInfoRoute: FastifyPluginAsync = async (fastify) => {
  await fastify.register(require('@fastify/sensible'));

  fastify.get<{
    Querystring: GetPoolInfoRequestType;
    Reply: Record<string, any>;
  }>(
    '/pool-info',
    {
      schema: {
        description: 'Get information about a QuickSwap V3 CLMM pool including liquidity, price, and fees',
        summary: 'QuickSwap V3 CLMM Pool Information',
        tags: ['quickswap/clmm'],
        querystring: {
          ...GetPoolInfoRequest,
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
            poolAddress: {
              type: 'string',
              description: 'Optional: Specific pool address',
              examples: ['0x...'],
            },
            baseToken: {
              type: 'string',
              description: 'Base token symbol (e.g., ALI, WPOL)',
              examples: ['ALI', 'WPOL'],
            },
            quoteToken: {
              type: 'string',
              description: 'Quote token symbol (e.g., WPOL, USDC)',
              examples: ['WPOL', 'USDC'],
            },
          },
        },
        response: {
          200: {
            description: 'Successful pool information response',
            ...PoolInfoSchema,
          },
          400: {
            description: 'Bad Request - Invalid parameters',
            type: 'object',
            properties: {
              statusCode: { type: 'number', example: 400 },
              error: { type: 'string', example: 'BadRequestError' },
              message: {
                type: 'string',
                example: 'Either poolAddress or both baseToken and quoteToken must be provided',
              },
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
              message: { type: 'string', example: 'Pool info request failed: Contract call failed' },
            },
          },
        },
        'x-examples': {
          'ALI-WPOL Pool': {
            summary: 'Get ALI-WPOL pool information',
            value: {
              baseToken: 'ALI',
              quoteToken: 'WPOL',
              network: 'polygon',
            },
          },
          'Specific Pool': {
            summary: 'Get information for specific pool address',
            value: {
              poolAddress: '0x...',
              network: 'polygon',
            },
          },
        },
      },
    },
    async (request): Promise<PoolInfo> => {
      try {
        const { poolAddress } = request.query;
        const network = request.query.network || 'polygon';

        const quickswap = await QuickSwap.getInstance(network);

        // Validate poolAddress is provided
        if (!poolAddress) {
          throw fastify.httpErrors.badRequest('poolAddress must be provided');
        }

        const poolAddressToUse = poolAddress;

        // Get pool info to extract token addresses
        const { getUniswapPoolInfo } = await import('../../uniswap/uniswap.utils');
        const poolInfo = await getUniswapPoolInfo(poolAddressToUse, network, 'clmm');
        if (!poolInfo) {
          throw fastify.httpErrors.notFound(`Pool not found: ${poolAddressToUse}`);
        }

        // Get token objects from pool info
        const baseTokenObj = quickswap.getTokenByAddress(poolInfo.baseTokenAddress);
        const quoteTokenObj = quickswap.getTokenByAddress(poolInfo.quoteTokenAddress);

        if (!baseTokenObj || !quoteTokenObj) {
          throw fastify.httpErrors.notFound('Could not find tokens for pool');
        }

        // Get V3 pool data using the pool address
        const v3Pool = await quickswap.getV3Pool(baseTokenObj, quoteTokenObj, poolAddressToUse);
        if (!v3Pool) {
          throw fastify.httpErrors.notFound('Pool not found');
        }

        // Calculate price from pool
        const token0 = v3Pool.token0;
        const token1 = v3Pool.token1;
        const isBaseToken0 = baseTokenObj.address.toLowerCase() === token0.address.toLowerCase();

        // Get price from pool
        const price0 = parseFloat(v3Pool.token0Price.toSignificant(15));
        const price1 = parseFloat(v3Pool.token1Price.toSignificant(15));
        const price = isBaseToken0 ? price0 : price1;

        // Get liquidity amounts
        const liquidity = v3Pool.liquidity;
        const baseTokenAmount = formatTokenAmount(liquidity.toString(), baseTokenObj.decimals);
        const quoteTokenAmount = formatTokenAmount(liquidity.toString(), quoteTokenObj.decimals);

        // Get fee percentage (convert from basis points)
        // Algebra V3 pools have dynamic fees stored in globalState().fee
        let feePct = 0.3; // Default 0.3%
        try {
          const { Contract } = await import('ethers');
          const poolABI = await import(
            '@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json'
          );
          const ethereum = await Ethereum.getInstance(network);
          const poolContract = new Contract(poolAddressToUse, poolABI.default.abi, ethereum.provider);

          // Try to get fee from globalState for Algebra V3
          try {
            const globalState = await poolContract.globalState();
            if (globalState && globalState.fee) {
              feePct = parseFloat(globalState.fee.toString()) / 10000; // Convert basis points to percentage
            }
          } catch (e) {
            // If globalState doesn't exist, try fee()
            try {
              const fee = await poolContract.fee();
              if (fee) {
                feePct = parseFloat(fee.toString()) / 10000;
              }
            } catch (e2) {
              logger.warn('Could not get fee from pool contract, using default 0.3%');
            }
          }
        } catch (error) {
          logger.warn('Could not get fee from pool contract, using default');
        }

        logger.info('QuickSwap CLMM pool info retrieved', {
          network,
          poolAddress: poolAddressToUse,
          baseToken: baseTokenObj.symbol,
          quoteToken: quoteTokenObj.symbol,
          price,
          baseTokenAmount,
          quoteTokenAmount,
          feePct,
        });

        return {
          address: poolAddressToUse,
          baseTokenAddress: baseTokenObj.address,
          quoteTokenAddress: quoteTokenObj.address,
          feePct: feePct,
          price: price,
          baseTokenAmount: baseTokenAmount,
          quoteTokenAmount: quoteTokenAmount,
        } as PoolInfo;
      } catch (e) {
        logger.error(`Error in QuickSwap CLMM pool-info route: ${e.message}`);
        if (e.stack) {
          logger.debug(`Stack trace: ${e.stack}`);
        }

        // Return appropriate error based on the error message
        if (e.statusCode) {
          throw e; // Already a formatted Fastify error
        } else if (e.message && e.message.includes('invalid address')) {
          throw fastify.httpErrors.badRequest(`Invalid pool address`);
        } else if (e.message && e.message.includes('pool not found')) {
          throw fastify.httpErrors.notFound(`Pool not found`);
        } else {
          throw fastify.httpErrors.internalServerError(`Pool info request failed: ${e.message}`);
        }
      }
    },
  );
};

/**
 * Get QuickSwap V3 pool information using Algebra V3 interface
 */
async function getV3PoolInfo(
  quickswap: any,
  baseTokenSymbol: string,
  quoteTokenSymbol: string,
  poolAddress: string,
): Promise<any> {
  try {
    // Get token objects
    const baseToken = quickswap.getTokenBySymbol(baseTokenSymbol);
    const quoteToken = quickswap.getTokenBySymbol(quoteTokenSymbol);

    if (!baseToken || !quoteToken) {
      throw new Error('Tokens not found');
    }

    // Create pool contract with Algebra V3 interface
    const poolContract = new Contract(
      poolAddress,
      [
        'function globalState() external view returns (uint160 price, int24 tick, uint16 fee, uint16 timepointIndex, uint8 communityFeeToken0, uint8 communityFeeToken1, bool unlocked)',
        'function token0() external view returns (address)',
        'function token1() external view returns (address)',
        'function liquidity() external view returns (uint128)',
        'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
      ],
      quickswap.ethereum.provider,
    );

    // Get pool state
    const globalState = await poolContract.globalState();
    const liquidity = await poolContract.liquidity();
    const token0Address = await poolContract.token0();
    const token1Address = await poolContract.token1();

    // Determine token order
    let token0, token1;
    if (baseToken.address.toLowerCase() === token0Address.toLowerCase()) {
      token0 = baseToken;
      token1 = quoteToken;
    } else {
      token0 = quoteToken;
      token1 = baseToken;
    }

    // Calculate price from sqrtPriceX96
    const sqrtPriceX96 = globalState.price;
    const sqrtPrice = sqrtPriceX96.toString();

    // Convert sqrtPriceX96 to actual price
    // price = (sqrtPriceX96 / 2^96)^2
    const priceRatio = BigNumber.from(sqrtPrice).mul(BigNumber.from(sqrtPrice)).div(BigNumber.from(2).pow(192));

    // Convert to decimal price based on token decimals
    const decimalAdjustment = BigNumber.from(10).pow(token1.decimals - token0.decimals);
    const price = parseFloat(priceRatio.toString()) / parseFloat(decimalAdjustment.toString());

    // Calculate token amounts from liquidity and price
    // This is a simplified calculation - in reality, Algebra V3 has complex liquidity distribution
    const liquidityBN = BigNumber.from(liquidity.toString());

    // Simplified calculation: assume equal distribution around current price
    const baseTokenAmount = formatTokenAmount(liquidityBN.toString(), token0.decimals);
    const quoteTokenAmount = formatTokenAmount(
      liquidityBN.mul(priceRatio).div(BigNumber.from(10).pow(18)).toString(),
      token1.decimals,
    );

    // Get fee percentage (convert from basis points)
    const feeBps = globalState.fee;
    const feePct = parseFloat(feeBps.toString()) / 10000; // Convert basis points to percentage

    logger.info('QuickSwap V3 pool info calculated', {
      poolAddress,
      token0: token0.symbol,
      token1: token1.symbol,
      price,
      feePct,
      liquidity: liquidity.toString(),
      sqrtPriceX96: sqrtPriceX96.toString(),
    });

    return {
      baseToken: token0,
      quoteToken: token1,
      price,
      baseTokenAmount,
      quoteTokenAmount,
      feePct,
      liquidity: liquidity.toString(),
    };
  } catch (error) {
    logger.error('Failed to get QuickSwap V3 pool info', error);
    throw error;
  }
}

export default poolInfoRoute;
