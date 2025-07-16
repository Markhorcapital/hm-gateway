import { FastifyPluginAsync } from 'fastify';

const addLiquidityRoute: FastifyPluginAsync = async (fastify) => {
    fastify.post('/add-liquidity', {
        schema: {
            description: 'Add liquidity to QuickSwap AMM pool',
            tags: ['quickswap/amm'],
        },
    }, async (_request, _reply) => {
        throw fastify.httpErrors.notImplemented('QuickSwap AMM add liquidity not yet implemented');
    });
};

export default addLiquidityRoute; 