import { FastifyPluginAsync } from 'fastify';

const positionInfoRoute: FastifyPluginAsync = async (fastify) => {
    fastify.get('/position-info', {
        schema: {
            description: 'Get position information for QuickSwap AMM',
            tags: ['quickswap/amm'],
        },
    }, async (_request, _reply) => {
        throw fastify.httpErrors.notImplemented('QuickSwap AMM position info not yet implemented');
    });
};

export default positionInfoRoute; 