import sensible from '@fastify/sensible';
import { FastifyPluginAsync } from 'fastify';

// Import routes
import { quickswapAmmRoutes } from './amm-routes';
import { quickswapClmmRoutes } from './clmm-routes';

// AMM routes (QuickSwap V2)
const quickswapAmmRoutesWrapper: FastifyPluginAsync = async (fastify) => {
  await fastify.register(sensible);

  await fastify.register(async (instance) => {
    instance.addHook('onRoute', (routeOptions) => {
      if (routeOptions.schema && routeOptions.schema.tags) {
        routeOptions.schema.tags = ['/connector/quickswap'];
      }
    });

    await instance.register(quickswapAmmRoutes);
  });
};

// CLMM routes (QuickSwap V3)
const quickswapClmmRoutesWrapper: FastifyPluginAsync = async (fastify) => {
  await fastify.register(sensible);

  await fastify.register(async (instance) => {
    instance.addHook('onRoute', (routeOptions) => {
      if (routeOptions.schema && routeOptions.schema.tags) {
        routeOptions.schema.tags = ['/connector/quickswap'];
      }
    });

    await instance.register(quickswapClmmRoutes);
  });
};

// Export routes in the same pattern as other connectors
export const quickswapRoutes = {
  amm: quickswapAmmRoutesWrapper,
  clmm: quickswapClmmRoutesWrapper,
};

export default quickswapRoutes;
