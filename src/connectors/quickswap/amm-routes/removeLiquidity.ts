import { FastifyPluginAsync } from 'fastify';

const removeLiquidityRoute: FastifyPluginAsync = async (fastify) => {
    fastify.post('/remove-liquidity', {
        schema: {
            description: 'Remove liquidity from QuickSwap AMM pool',
            tags: ['quickswap/amm'],
        },
    }, async (_request, _reply) => {
        throw fastify.httpErrors.notImplemented('QuickSwap AMM remove liquidity not yet implemented');
    });
};

export default removeLiquidityRoute; 