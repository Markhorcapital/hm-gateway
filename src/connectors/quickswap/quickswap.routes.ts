import sensible from '@fastify/sensible';
import type { FastifyPluginAsync } from 'fastify';

import { logger } from '../../services/logger';

// Import AMM routes (V2)
import ammExecuteSwapRoute from './amm-routes/executeSwap';
import ammPoolInfoRoute from './amm-routes/poolInfo';
import ammPositionInfoRoute from './amm-routes/positionInfo';
import quoteLiquidityRoute from './amm-routes/quoteLiquidity';
import ammQuoteSwapRoute from './amm-routes/quoteSwap';
import { addLiquidityRoute } from './amm-routes/addLiquidity';
import { removeLiquidityRoute } from './amm-routes/removeLiquidity';

// Import CLMM routes (V3)
import clmmExecuteSwapRoute from './clmm-routes/executeSwap';
import clmmPoolInfoRoute from './clmm-routes/poolInfo';
import clmmPositionInfoRoute from './clmm-routes/positionInfo';
import clmmQuoteSwapRoute from './clmm-routes/quoteSwap';
import openPositionRoute from './clmm-routes/openPosition';
import closePositionRoute from './clmm-routes/closePosition';
import { collectFeesRoute } from './clmm-routes/collectFees';
import { positionsOwnedRoute } from './clmm-routes/positionsOwned';
import { quotePositionRoute } from './clmm-routes/quotePosition';

// AMM routes including swap endpoints
const quickswapAmmRoutes: FastifyPluginAsync = async (fastify) => {
    await fastify.register(sensible);

    await fastify.register(async (instance) => {
        instance.addHook('onRoute', (routeOptions) => {
            if (routeOptions.schema && routeOptions.schema.tags) {
                routeOptions.schema.tags = ['quickswap/amm'];
            }
        });

        await instance.register(ammPoolInfoRoute);
        await instance.register(ammPositionInfoRoute);
        await instance.register(ammQuoteSwapRoute);
        await instance.register(quoteLiquidityRoute);
        await instance.register(ammExecuteSwapRoute);
        await instance.register(addLiquidityRoute);
        await instance.register(removeLiquidityRoute);
    });
};

// CLMM routes including swap endpoints
const quickswapClmmRoutes: FastifyPluginAsync = async (fastify) => {
    await fastify.register(sensible);

    await fastify.register(async (instance) => {
        instance.addHook('onRoute', (routeOptions) => {
            if (routeOptions.schema && routeOptions.schema.tags) {
                routeOptions.schema.tags = ['quickswap/clmm'];
            }
        });

        await instance.register(clmmPoolInfoRoute);
        await instance.register(clmmPositionInfoRoute);
        await instance.register(clmmQuoteSwapRoute);
        await instance.register(clmmExecuteSwapRoute);
        await instance.register(openPositionRoute);
        await instance.register(closePositionRoute);
        await instance.register(collectFeesRoute);
        await instance.register(positionsOwnedRoute);
        await instance.register(quotePositionRoute);
    });
};

// Main export that combines all routes
export const quickswapRoutes = {
    amm: quickswapAmmRoutes,
    clmm: quickswapClmmRoutes,
}; 