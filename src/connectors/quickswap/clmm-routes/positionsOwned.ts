import { Contract } from '@ethersproject/contracts';
import { FastifyPluginAsync } from 'fastify';

import { Ethereum } from '../../../chains/ethereum/ethereum';
import { logger } from '../../../services/logger';
import { QuickSwap } from '../quickswap';
import { getQuickSwapV3NftManagerAddress, IAlgebraV3PositionManagerABI } from '../quickswap.contracts';

export const positionsOwnedRoute: FastifyPluginAsync = async (fastify) => {
  await fastify.register(require('@fastify/sensible'));

  // Get first wallet address for example
  const ethereum = await Ethereum.getInstance('polygon');
  let firstWalletAddress = '<ethereum-wallet-address>';

  try {
    firstWalletAddress = (await Ethereum.getFirstWalletAddress()) || firstWalletAddress;
  } catch (error) {
    logger.warn('No wallets found for examples in schema');
  }

  fastify.get<{
    Querystring: {
      network?: string;
      walletAddress?: string;
    };
    Reply: {
      positions: Array<{
        tokenId: string;
        poolAddress: string;
        baseToken: string;
        quoteToken: string;
        fee: number;
        liquidity: string;
        tickLower: number;
        tickUpper: number;
      }>;
    };
  }>(
    '/positions-owned',
    {
      schema: {
        description: 'Get all QuickSwap V3 positions owned by a wallet',
        tags: ['quickswap/clmm'],
        querystring: {
          type: 'object',
          properties: {
            network: {
              type: 'string',
              description: 'Blockchain network (e.g., polygon, mumbai)',
              examples: ['polygon'],
              default: 'polygon',
            },
            walletAddress: {
              type: 'string',
              description: 'Wallet address to query positions for',
              examples: [firstWalletAddress],
            },
          },
        },
        response: {
          200: {
            description: 'Successful positions response',
            type: 'object',
            properties: {
              positions: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    tokenId: { type: 'string' },
                    poolAddress: { type: 'string' },
                    baseToken: { type: 'string' },
                    quoteToken: { type: 'string' },
                    fee: { type: 'number' },
                    liquidity: { type: 'string' },
                    tickLower: { type: 'number' },
                    tickUpper: { type: 'number' },
                  },
                },
              },
            },
          },
          400: {
            description: 'Bad Request - Invalid parameters',
            type: 'object',
            properties: {
              statusCode: { type: 'number', example: 400 },
              error: { type: 'string', example: 'BadRequestError' },
              message: { type: 'string', example: 'Wallet address required' },
            },
          },
          500: {
            description: 'Internal Server Error',
            type: 'object',
            properties: {
              statusCode: { type: 'number', example: 500 },
              error: { type: 'string', example: 'InternalServerError' },
              message: { type: 'string', example: 'Failed to fetch positions' },
            },
          },
        },
      },
    },
    async (request) => {
      try {
        const { network, walletAddress: requestedWalletAddress } = request.query;

        const networkToUse = network || 'polygon';

        // Get wallet address - either from request or first available
        let walletAddress = requestedWalletAddress;
        if (!walletAddress) {
          const ethereum = await Ethereum.getInstance(networkToUse);
          walletAddress = await Ethereum.getFirstWalletAddress();
          if (!walletAddress) {
            throw fastify.httpErrors.badRequest('No wallet address provided and no default wallet found');
          }
          logger.info(`Using first available wallet address: ${walletAddress}`);
        }

        // Get QuickSwap instance
        const quickswap = await QuickSwap.getInstance(networkToUse);

        // Get position manager address
        const positionManagerAddress = getQuickSwapV3NftManagerAddress(networkToUse);

        // Create position manager contract
        const positionManagerContract = new Contract(
          positionManagerAddress,
          IAlgebraV3PositionManagerABI,
          quickswap.provider,
        );

        // Get number of positions owned by wallet
        const balance = await positionManagerContract.balanceOf(walletAddress);
        const positions = [];

        // Iterate through all positions
        for (let i = 0; i < balance.toNumber(); i++) {
          try {
            const tokenId = await positionManagerContract.tokenOfOwnerByIndex(walletAddress, i);
            const position = await positionManagerContract.positions(tokenId);

            // Get token symbols
            const baseToken = quickswap.getTokenByAddress(position.token0);
            const quoteToken = quickswap.getTokenByAddress(position.token1);

            positions.push({
              tokenId: tokenId.toString(),
              poolAddress: '', // Would need to derive from token0, token1, fee
              baseToken: baseToken?.symbol || position.token0,
              quoteToken: quoteToken?.symbol || position.token1,
              fee: position.fee,
              liquidity: position.liquidity.toString(),
              tickLower: position.tickLower,
              tickUpper: position.tickUpper,
            });
          } catch (error) {
            logger.warn(`Failed to fetch position ${i}: ${error.message}`);
          }
        }

        logger.info(`Found ${positions.length} positions for wallet ${walletAddress}`);

        return { positions };
      } catch (error) {
        logger.error('Failed to fetch positions:', error);
        throw fastify.httpErrors.internalServerError(`Failed to fetch positions: ${error.message}`);
      }
    },
  );
};
