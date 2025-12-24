import { FastifyPluginAsync } from 'fastify';

import { addLiquidityRoute } from './addLiquidity';
import closePositionRoute from './closePosition';
import { collectFeesRoute } from './collectFees';
import clmmExecuteSwapRoute from './executeSwap';
import openPositionRoute from './openPosition';
import clmmPoolInfoRoute from './poolInfo';
import clmmPositionInfoRoute from './positionInfo';
import { positionsOwnedRoute } from './positionsOwned';
import { quotePositionRoute } from './quotePosition';
import clmmQuoteSwapRoute from './quoteSwap';
import { removeLiquidityRoute } from './removeLiquidity';

export const quickswapClmmRoutes: FastifyPluginAsync = async (fastify) => {
  await fastify.register(clmmPoolInfoRoute);
  await fastify.register(clmmPositionInfoRoute);
  await fastify.register(clmmQuoteSwapRoute);
  await fastify.register(clmmExecuteSwapRoute);
  await fastify.register(openPositionRoute);
  await fastify.register(closePositionRoute);
  await fastify.register(collectFeesRoute);
  await fastify.register(positionsOwnedRoute);
  await fastify.register(quotePositionRoute);
  await fastify.register(addLiquidityRoute);
  await fastify.register(removeLiquidityRoute);
};

export default quickswapClmmRoutes;
