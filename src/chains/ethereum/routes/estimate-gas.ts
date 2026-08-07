import { FastifyPluginAsync, FastifyInstance } from 'fastify';

import {
  EstimateGasRequestType,
  EstimateGasResponse,
  EstimateGasRequestSchema,
  EstimateGasResponseSchema,
} from '../../../schemas/chain-schema';
import { gasCostInEthString } from '../../../services/base';
import { logger } from '../../../services/logger';
import { Ethereum } from '../ethereum';

export async function estimateGasEthereum(
  fastify: FastifyInstance,
  network: string,
  gasLimit?: number,
): Promise<EstimateGasResponse> {
  try {
    const ethereum = await Ethereum.getInstance(network);

    // Get gas price in GWEI (EIP-1559 aware; Base no longer uses 2.5 Gwei floor)
    const gasPrice = await ethereum.estimateGasPrice();

    // For fee estimates / arbitrage, use a realistic swap gas limit instead of the
    // 3M hard cap. Callers can still override via gasLimit.
    const gasLimitUsed =
      gasLimit ||
      (ethereum.isOpStackNetwork()
        ? Ethereum.DEFAULT_SWAP_GAS_LIMIT
        : ethereum.gasLimitTransaction);

    // On Base/Optimism include L1 security fee via GasPriceOracle
    const gasCost = ethereum.isOpStackNetwork()
      ? await ethereum.estimateTotalFees(gasLimitUsed)
      : parseFloat(gasCostInEthString(gasPrice, gasLimitUsed));

    return {
      gasPrice: gasPrice,
      gasPriceToken: ethereum.nativeTokenSymbol,
      gasLimit: gasLimitUsed,
      gasCost: gasCost,
    };
  } catch (error) {
    logger.error(`Error estimating gas: ${error.message}`);
    throw fastify.httpErrors.internalServerError(
      `Failed to estimate gas: ${error.message}`,
    );
  }
}

export const estimateGasRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post<{
    Body: EstimateGasRequestType;
    Reply: EstimateGasResponse;
  }>(
    '/estimate-gas',
    {
      schema: {
        description: 'Estimate gas prices for Ethereum transactions',
        tags: ['ethereum'],
        body: {
          ...EstimateGasRequestSchema,
          properties: {
            ...EstimateGasRequestSchema.properties,
            network: {
              type: 'string',
              examples: [
                'mainnet',
                'arbitrum',
                'optimism',
                'base',
                'sepolia',
                'bsc',
                'avalanche',
                'celo',
                'polygon',
                'blast',
                'zora',
                'worldchain',
              ],
            },
            gasLimit: { type: 'number', examples: [21000] },
          },
        },
        response: {
          200: EstimateGasResponseSchema,
        },
      },
    },
    async (request) => {
      const { network, gasLimit } = request.body;
      return await estimateGasEthereum(fastify, network, gasLimit);
    },
  );
};

export default estimateGasRoute;
