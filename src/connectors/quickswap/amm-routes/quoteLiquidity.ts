import { FastifyPluginAsync } from 'fastify';

const quoteLiquidityRoute: FastifyPluginAsync = async (fastify) => {
    fastify.post('/quote-liquidity', {
        schema: {
            description: 'Get a quote for adding liquidity to QuickSwap AMM',
            tags: ['quickswap/amm'],
        },
    }, async (_request, _reply) => {
        throw fastify.httpErrors.notImplemented('QuickSwap AMM quote liquidity not yet implemented');
    });
};

export default quoteLiquidityRoute; 