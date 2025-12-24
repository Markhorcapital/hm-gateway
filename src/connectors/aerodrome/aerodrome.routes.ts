import sensible from '@fastify/sensible';
import { FastifyPluginAsync } from 'fastify';

// Import routes
import { aerodromeClmmRoutes } from './clmm-routes';

// CLMM routes (Aerodrome V3)
const aerodromeClmmRoutesWrapper: FastifyPluginAsync = async (fastify) => {
  await fastify.register(sensible);

  await fastify.register(async (instance) => {
    instance.addHook('onRoute', (routeOptions) => {
      if (routeOptions.schema && routeOptions.schema.tags) {
        routeOptions.schema.tags = ['/connector/aerodrome'];
      }
    });

    await instance.register(aerodromeClmmRoutes);
  });
};

// Export routes in the same pattern as other connectors
export const aerodromeRoutes = {
  clmm: aerodromeClmmRoutesWrapper,
};

export default aerodromeRoutes;
