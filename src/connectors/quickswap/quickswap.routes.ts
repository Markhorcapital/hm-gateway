import { FastifyPluginAsync } from 'fastify';
import sensible from '@fastify/sensible';

import { logger } from '../../services/logger';

// Import AMM routes (V2)
import ammExecuteSwapRoute from './amm-routes/executeSwap';
import ammPoolInfoRoute from './amm-routes/poolInfo';
import ammPositionInfoRoute from './amm-routes/positionInfo';
import quoteLiquidityRoute from './amm-routes/quoteLiquidity';
import ammQuoteSwapRoute from './amm-routes/quoteSwap';
import addLiquidityRoute from './amm-routes/addLiquidity';
import removeLiquidityRoute from './amm-routes/removeLiquidity';

// Import CLMM routes (V3)
import clmmExecuteSwapRoute from './clmm-routes/executeSwap';
import clmmPoolInfoRoute from './clmm-routes/poolInfo';
import clmmPositionInfoRoute from './clmm-routes/positionInfo';
import clmmQuoteSwapRoute from './clmm-routes/quoteSwap';
import openPositionRoute from './clmm-routes/openPosition';
import closePositionRoute from './clmm-routes/closePosition';

export const quickswapRoutes: FastifyPluginAsync = async (fastify) => {
    // Register sensible plugin for httpErrors
    await fastify.register(sensible);

    // Register AMM routes (QuickSwap V2)
    fastify.register(
        async (ammRouter) => {
            await ammRouter.register(ammPoolInfoRoute);
            await ammRouter.register(ammPositionInfoRoute);
            await ammRouter.register(ammQuoteSwapRoute);
            await ammRouter.register(quoteLiquidityRoute);
            await ammRouter.register(ammExecuteSwapRoute);
            await ammRouter.register(addLiquidityRoute);
            await ammRouter.register(removeLiquidityRoute);
        },
        { prefix: '/amm' },
    );

    // Register CLMM routes (QuickSwap V3)
    fastify.register(
        async (clmmRouter) => {
            await clmmRouter.register(clmmPoolInfoRoute);
            await clmmRouter.register(clmmPositionInfoRoute);
            await clmmRouter.register(clmmQuoteSwapRoute);
            await clmmRouter.register(clmmExecuteSwapRoute);
            await clmmRouter.register(openPositionRoute);
            await clmmRouter.register(closePositionRoute);
        },
        { prefix: '/clmm' },
    );
}; 