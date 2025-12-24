import { Provider } from '@ethersproject/providers';
import { Protocol, Trade as RouterTrade } from '@uniswap/router-sdk';
import { TradeType, Percent, Currency, CurrencyAmount, Token } from '@uniswap/sdk-core';
import {
  SwapRouter,
  SwapOptions,
  UNIVERSAL_ROUTER_ADDRESS,
  UniversalRouterVersion,
} from '@uniswap/universal-router-sdk';
import { Pair as V2Pair, Route as V2Route, Trade as V2Trade, computePairAddress } from '@uniswap/v2-sdk';
import IUniswapV3Pool from '@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json';
import {
  Pool as V3Pool,
  Route as V3Route,
  Trade as V3Trade,
  FeeAmount,
  computePoolAddress,
  FACTORY_ADDRESS,
  nearestUsableTick,
  TickMath,
  TICK_SPACINGS,
} from '@uniswap/v3-sdk';
import { BigNumber, Contract } from 'ethers';

import { Ethereum } from '../../chains/ethereum/ethereum';
import { logger } from '../../services/logger';

import {
  IUniswapV2PairABI,
  getUniswapV3FactoryAddress,
  getUniswapV2FactoryAddress,
  getUniswapV3QuoterV2ContractAddress,
  getUniswapV4PoolManagerAddress,
  getUniswapV4StateViewAddress,
  getUniswapV4QuoterAddress,
  IV4QuoterABI,
  IStateViewABI,
} from './uniswap.contracts';

// Common fee tiers for V3
const V3_FEE_TIERS = [FeeAmount.LOWEST, FeeAmount.LOW, FeeAmount.MEDIUM, FeeAmount.HIGH];

// V4 common configurations
// Default fee: 3000 (0.3%), tickSpacing: 60, no hooks
const V4_DEFAULT_FEE = 3000; // 0.3%
const V4_DEFAULT_TICK_SPACING = 60;
const V4_NO_HOOKS = '0x0000000000000000000000000000000000000000';

// V4 Universal Router commands and actions
const V4_COMMANDS = {
  V4_SWAP: 0x10, // V4 swap command
};

const V4_ACTIONS = {
  SWAP_EXACT_IN_SINGLE: 0x06,
  SWAP_EXACT_OUT_SINGLE: 0x08,
  SETTLE_ALL: 0x0c,
  TAKE_ALL: 0x0f,
};

export interface V4PoolKey {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
}

export interface V4QuoteResult {
  poolKey: V4PoolKey;
  zeroForOne: boolean;
  amountIn: CurrencyAmount<Currency>;
  amountOut: CurrencyAmount<Currency>;
  priceImpact: number;
}

export interface UniversalRouterQuoteResult {
  trade: RouterTrade<Currency, Currency, TradeType> | null;
  route: string[];
  routePath: string;
  priceImpact: number;
  estimatedGasUsed: BigNumber;
  estimatedGasUsedQuoteToken: CurrencyAmount<Currency>;
  quote: CurrencyAmount<Currency>;
  quoteGasAdjusted: CurrencyAmount<Currency>;
  methodParameters?: {
    calldata: string;
    value: string;
    to: string;
  };
  // V4-specific fields
  v4Quote?: V4QuoteResult;
  isV4?: boolean;
}

export class UniversalRouterService {
  private provider: Provider;
  private chainId: number;
  private network: string;
  private ethereum: Ethereum | null = null;

  constructor(provider: Provider, chainId: number, network: string) {
    this.provider = provider;
    this.chainId = chainId;
    this.network = network;
  }

  private async getEthereum(): Promise<Ethereum> {
    if (!this.ethereum) {
      this.ethereum = await Ethereum.getInstance(this.network);
    }
    return this.ethereum;
  }

  /**
   * Get a quote for a swap using Universal Router
   */
  async getQuote(
    tokenIn: Token,
    tokenOut: Token,
    amount: CurrencyAmount<Currency>,
    tradeType: TradeType,
    options: {
      slippageTolerance: Percent;
      deadline: number;
      recipient: string;
      protocols?: Protocol[];
    },
  ): Promise<UniversalRouterQuoteResult> {
    logger.info(`[UniversalRouter] Starting quote generation`);
    logger.info(`[UniversalRouter] Input: ${amount.toExact()} ${tokenIn.symbol} (${tokenIn.address})`);
    logger.info(`[UniversalRouter] Output: ${tokenOut.symbol} (${tokenOut.address})`);
    logger.info(
      `[UniversalRouter] Trade type: ${tradeType === TradeType.EXACT_INPUT ? 'EXACT_INPUT' : 'EXACT_OUTPUT'}`,
    );
    logger.info(`[UniversalRouter] Recipient: ${options.recipient}`);
    logger.info(`[UniversalRouter] Slippage: ${options.slippageTolerance.toSignificant()}%`);

    const protocols = options.protocols || [Protocol.V4];
    logger.info(`[UniversalRouter] Protocols to check: ${protocols.join(', ')}`);
    const routes: any[] = [];
    let v4Quote: V4QuoteResult | null = null;

    // Try to find routes through each protocol
    if (protocols.includes(Protocol.V4)) {
      logger.info(`[UniversalRouter] Searching for V4 routes...`);
      try {
        const v4Result = await this.findV4Route(tokenIn, tokenOut, amount, tradeType);
        if (v4Result) {
          logger.info(
            `[UniversalRouter] Found V4 route: ${v4Result.amountIn.toExact()} -> ${v4Result.amountOut.toExact()}`,
          );
          v4Quote = v4Result;
          routes.push({
            routev4: v4Result,
            inputAmount: v4Result.amountIn,
            outputAmount: v4Result.amountOut,
          });
        } else {
          logger.info(`[UniversalRouter] No V4 route found`);
        }
      } catch (error) {
        logger.warn(`[UniversalRouter] Failed to find V4 route: ${error.message}`);
      }
    }

    if (protocols.includes(Protocol.V3)) {
      logger.info(`[UniversalRouter] Searching for V3 routes...`);
      try {
        const v3Trade = await this.findV3Route(tokenIn, tokenOut, amount, tradeType);
        if (v3Trade) {
          logger.info(
            `[UniversalRouter] Found V3 route: ${v3Trade.inputAmount.toExact()} -> ${v3Trade.outputAmount.toExact()}`,
          );
          routes.push({
            routev3: v3Trade.route,
            inputAmount: v3Trade.inputAmount,
            outputAmount: v3Trade.outputAmount,
          });
        } else {
          logger.info(`[UniversalRouter] No V3 route found`);
        }
      } catch (error) {
        logger.warn(`[UniversalRouter] Failed to find V3 route: ${error.message}`);
      }
    }

    if (protocols.includes(Protocol.V2)) {
      logger.info(`[UniversalRouter] Searching for V2 routes...`);
      try {
        const v2Trade = await this.findV2Route(tokenIn, tokenOut, amount, tradeType);
        if (v2Trade) {
          logger.info(
            `[UniversalRouter] Found V2 route: ${v2Trade.inputAmount.toExact()} -> ${v2Trade.outputAmount.toExact()}`,
          );
          routes.push({
            routev2: v2Trade.route,
            inputAmount: v2Trade.inputAmount,
            outputAmount: v2Trade.outputAmount,
          });
        } else {
          logger.info(`[UniversalRouter] No V2 route found`);
        }
      } catch (error) {
        logger.warn(`[UniversalRouter] Failed to find V2 route: ${error.message}`);
      }
    }

    if (routes.length === 0) {
      logger.error(`[UniversalRouter] No routes found for ${tokenIn.symbol} -> ${tokenOut.symbol}`);
      throw new Error(`No routes found for ${tokenIn.symbol} -> ${tokenOut.symbol}`);
    }

    logger.info(`[UniversalRouter] Found ${routes.length} route(s), selecting best route`);
    // Pick the best route (for now, just use the first one)
    const bestRoute = routes[0];

    // Handle V4 route separately (V4 uses different swap mechanism)
    if (bestRoute.routev4 && v4Quote) {
      logger.info(`[UniversalRouter] Using V4 route - building V4 swap parameters...`);
      const { calldata, value } = await this.buildV4SwapCalldata(
        v4Quote,
        tokenIn,
        tokenOut,
        amount,
        tradeType,
        options,
      );

      const result = {
        trade: null, // V4 doesn't use RouterTrade
        route: [tokenIn.symbol || tokenIn.address, tokenOut.symbol || tokenOut.address],
        routePath: `${tokenIn.symbol || tokenIn.address} -> ${tokenOut.symbol || tokenOut.address}`,
        priceImpact: v4Quote.priceImpact,
        estimatedGasUsed: BigNumber.from(0),
        estimatedGasUsedQuoteToken: CurrencyAmount.fromRawAmount(tokenOut, '0'),
        quote: v4Quote.amountOut,
        quoteGasAdjusted: v4Quote.amountOut,
        methodParameters: {
          calldata,
          value,
          to: UNIVERSAL_ROUTER_ADDRESS(UniversalRouterVersion.V2_0, this.chainId),
        },
        v4Quote,
        isV4: true,
      };

      logger.info(`[UniversalRouter] V4 quote generation complete`);
      logger.info(`[UniversalRouter] Input: ${v4Quote.amountIn.toExact()} ${tokenIn.symbol}`);
      logger.info(`[UniversalRouter] Output: ${v4Quote.amountOut.toExact()} ${tokenOut.symbol}`);
      logger.info(`[UniversalRouter] Price Impact: ${result.priceImpact}%`);

      return result;
    }

    // Create RouterTrade based on the best route (V2 or V3)
    let bestTrade: RouterTrade<Currency, Currency, TradeType>;

    if (bestRoute.routev3) {
      logger.info(`[UniversalRouter] Creating RouterTrade with V3 route`);
      bestTrade = new RouterTrade({
        v2Routes: [],
        v3Routes: [bestRoute],
        v4Routes: [],
        tradeType,
      });
    } else {
      logger.info(`[UniversalRouter] Creating RouterTrade with V2 route`);
      bestTrade = new RouterTrade({
        v2Routes: [bestRoute],
        v3Routes: [],
        v4Routes: [],
        tradeType,
      });
    }

    // Build the Universal Router swap
    const swapOptions: SwapOptions = {
      slippageTolerance: options.slippageTolerance,
      deadlineOrPreviousBlockhash: options.deadline,
      recipient: options.recipient,
    };

    logger.info(`[UniversalRouter] Building swap parameters...`);
    // Create method parameters for the swap
    const { calldata, value } = SwapRouter.swapCallParameters(bestTrade, swapOptions);
    logger.info(`[UniversalRouter] Calldata length: ${calldata.length}, Value: ${value}`);

    // Calculate route path
    const route = this.extractRoutePath(bestTrade);
    const routePath = route.join(' -> ');
    logger.info(`[UniversalRouter] Route path: ${routePath}`);

    // Skip gas estimation during quote phase - it will be done during execution
    logger.info(`[UniversalRouter] Skipping gas estimation for quote (will estimate during execution)`);
    const estimatedGasUsed = BigNumber.from(0); // Placeholder, actual estimation happens during execution

    // Simple gas cost estimation
    const estimatedGasUsedQuoteToken = CurrencyAmount.fromRawAmount(
      tokenOut,
      '0', // Simplified for now
    );

    const result = {
      trade: bestTrade,
      route,
      routePath,
      priceImpact: parseFloat(bestTrade.priceImpact.toSignificant(6)),
      estimatedGasUsed,
      estimatedGasUsedQuoteToken,
      quote: bestTrade.outputAmount,
      quoteGasAdjusted: bestTrade.outputAmount,
      methodParameters: {
        calldata,
        value,
        to: UNIVERSAL_ROUTER_ADDRESS(UniversalRouterVersion.V2_0, this.chainId),
      },
    };

    logger.info(`[UniversalRouter] Quote generation complete`);
    logger.info(`[UniversalRouter] Input: ${bestTrade.inputAmount.toExact()} ${bestTrade.inputAmount.currency.symbol}`);
    logger.info(
      `[UniversalRouter] Output: ${bestTrade.outputAmount.toExact()} ${bestTrade.outputAmount.currency.symbol}`,
    );
    logger.info(`[UniversalRouter] Price Impact: ${result.priceImpact}%`);

    return result;
  }

  /**
   * Find V3 route using pool address computation
   */
  private async findV3Route(
    tokenIn: Token,
    tokenOut: Token,
    amount: CurrencyAmount<Currency>,
    tradeType: TradeType,
  ): Promise<V3Trade<Currency, Currency, TradeType> | null> {
    // Try each fee tier
    for (const fee of V3_FEE_TIERS) {
      try {
        // Compute pool address
        const poolAddress = computePoolAddress({
          factoryAddress: getUniswapV3FactoryAddress(this.network),
          tokenA: tokenIn,
          tokenB: tokenOut,
          fee,
        });

        // Get pool contract
        const poolContract = new Contract(poolAddress, IUniswapV3Pool.abi, this.provider);

        // Check if pool exists by querying liquidity
        const liquidity = await poolContract.liquidity();
        if (liquidity.eq(0)) continue;

        // Get slot0 data
        const slot0 = await poolContract.slot0();
        const sqrtPriceX96 = slot0[0];
        const tick = slot0[1];

        // Create minimal tick data around current tick
        const tickSpacing = TICK_SPACINGS[fee];
        const numSurroundingTicks = 300; // Number of ticks on each side

        const minTick = nearestUsableTick(tick - numSurroundingTicks * tickSpacing, tickSpacing);
        const maxTick = nearestUsableTick(tick + numSurroundingTicks * tickSpacing, tickSpacing);

        // Create tick data - for simplicity, assume all ticks have liquidity
        const ticks = [];
        for (let i = minTick; i <= maxTick; i += tickSpacing) {
          ticks.push({
            index: i,
            liquidityNet: 0,
            liquidityGross: 1,
          });
        }

        // Create pool instance with tick data
        const pool = new V3Pool(tokenIn, tokenOut, fee, sqrtPriceX96.toString(), liquidity.toString(), tick, ticks);

        // Create route and trade
        const route = new V3Route([pool], tokenIn, tokenOut);

        return tradeType === TradeType.EXACT_INPUT ? V3Trade.exactIn(route, amount) : V3Trade.exactOut(route, amount);
      } catch (error) {
        // Pool doesn't exist or other error, continue to next fee tier
        continue;
      }
    }

    return null;
  }

  /**
   * Find V2 route for a token pair
   */
  private async findV2Route(
    tokenIn: Token,
    tokenOut: Token,
    amount: CurrencyAmount<Currency>,
    tradeType: TradeType,
  ): Promise<V2Trade<Currency, Currency, TradeType> | null> {
    try {
      // Compute pair address
      const pairAddress = computePairAddress({
        factoryAddress: getUniswapV2FactoryAddress(this.network),
        tokenA: tokenIn,
        tokenB: tokenOut,
      });

      const pairContract = new Contract(pairAddress, IUniswapV2PairABI.abi, this.provider);
      const reserves = await pairContract.getReserves();
      const token0 = await pairContract.token0();

      const [reserve0, reserve1] = reserves;
      const [reserveIn, reserveOut] =
        tokenIn.address.toLowerCase() === token0.toLowerCase() ? [reserve0, reserve1] : [reserve1, reserve0];

      const pair = new V2Pair(
        CurrencyAmount.fromRawAmount(tokenIn, reserveIn.toString()),
        CurrencyAmount.fromRawAmount(tokenOut, reserveOut.toString()),
      );

      const route = new V2Route([pair], tokenIn, tokenOut);

      return new V2Trade(route, amount, tradeType);
    } catch (error) {
      return null;
    }
  }

  /**
   * Find V4 route using pool key and quoter
   */
  private async findV4Route(
    tokenIn: Token,
    tokenOut: Token,
    amount: CurrencyAmount<Currency>,
    tradeType: TradeType,
  ): Promise<V4QuoteResult | null> {
    try {
      // Determine token order (currency0 < currency1)
      const token0Address =
        tokenIn.address.toLowerCase() < tokenOut.address.toLowerCase() ? tokenIn.address : tokenOut.address;
      const token1Address =
        tokenIn.address.toLowerCase() < tokenOut.address.toLowerCase() ? tokenOut.address : tokenIn.address;
      const zeroForOne = tokenIn.address.toLowerCase() < tokenOut.address.toLowerCase();

      // Create pool key with default values
      // In production, these should be discovered from on-chain data or configuration
      const poolKey: V4PoolKey = {
        currency0: token0Address,
        currency1: token1Address,
        fee: V4_DEFAULT_FEE,
        tickSpacing: V4_DEFAULT_TICK_SPACING,
        hooks: '0x121f94835dAB08ebaF084809a97e525B69e400Cc',
      };

      // Get quote from V4 Quoter
      const quoterAddress = getUniswapV4QuoterAddress(this.network);
      const quoterContract = new Contract(quoterAddress, IV4QuoterABI, this.provider);

      const hookData = '0x00'; // Empty for no hooks
      const exactAmount = BigNumber.from(amount.quotient.toString());

      let amountOut: BigNumber;
      let gasEstimate: BigNumber;
      let amountIn: CurrencyAmount<Currency>;
      let amountOutCurrency: CurrencyAmount<Currency>;
      console.log('tradeType', tradeType);
      if (tradeType === TradeType.EXACT_INPUT) {
        try {
          // V4 Quoter uses struct parameter (IV4Quoter.QuoteExactSingleParams) and returns (amountOut, gasEstimate)
          // The struct contains: poolKey, zeroForOne, exactAmount, hookData
          const quoteParams = {
            poolKey: {
              currency0: poolKey.currency0,
              currency1: poolKey.currency1,
              fee: poolKey.fee,
              tickSpacing: poolKey.tickSpacing,
              hooks: poolKey.hooks,
            },
            zeroForOne,
            exactAmount,
            hookData,
          };
          const quoteResult = await quoterContract.callStatic.quoteExactInputSingle(quoteParams);

          amountOut = quoteResult.amountOut;
          gasEstimate = quoteResult.gasEstimate;
          logger.info(
            `[UniversalRouter] V4 quote successful: ${amountOut.toString()} out, gas: ${gasEstimate.toString()}`,
          );
        } catch (error) {
          logger.warn(`[UniversalRouter] V4 quote failed: ${error.message}`);
          if (error.error && error.error.data) {
            logger.warn(`[UniversalRouter] V4 quote error data: ${error.error.data}`);
          }
          return null;
        }

        // Calculate amounts based on trade type

        amountIn = amount;
        amountOutCurrency = CurrencyAmount.fromRawAmount(tokenOut, amountOut.toString());
      } else {
        try {
          const quoteParams = {
            poolKey: {
              currency0: poolKey.currency0,
              currency1: poolKey.currency1,
              fee: poolKey.fee,
              tickSpacing: poolKey.tickSpacing,
              hooks: poolKey.hooks,
            },
            zeroForOne,
            exactAmount,
            hookData,
          };
          const quoteResult = await quoterContract.callStatic.quoteExactOutputSingle(quoteParams);
          amountOut = quoteResult.amountIn;
          gasEstimate = quoteResult.gasEstimate;
          amountOutCurrency = amount;
          // For exact output, we'd need to reverse quote - for now, use the quoted amount
          // In production, you'd call quoteExactOutputSingle
          amountIn = CurrencyAmount.fromRawAmount(tokenIn, amountOut.toString());
        } catch (error) {
          logger.warn(`[UniversalRouter] V4 quote failed: ${error.message}`);
          if (error.error && error.error.data) {
            logger.warn(`[UniversalRouter] V4 quote error data: ${error.error.data}`);
          }
          return null;
        }
      }
      // Calculate simple price impact (can be improved)
      const priceImpact = 0; // V4 price impact calculation would require more complex logic

      return {
        poolKey,
        zeroForOne,
        amountIn,
        amountOut: amountOutCurrency,
        priceImpact,
      };
    } catch (error) {
      logger.warn(`[UniversalRouter] V4 route finding error: ${error.message}`);
      return null;
    }
  }

  /**
   * Build V4 swap calldata for Universal Router
   */
  private async buildV4SwapCalldata(
    v4Quote: V4QuoteResult,
    _tokenIn: Token,
    _tokenOut: Token,
    _amount: CurrencyAmount<Currency>,
    _tradeType: TradeType,
    options: {
      slippageTolerance: Percent;
      deadline: number;
      recipient: string;
    },
  ): Promise<{ calldata: string; value: string }> {
    const { utils } = await import('ethers');
    const { defaultAbiCoder, solidityPack } = utils;

    const poolKey = v4Quote.poolKey;
    const zeroForOne = v4Quote.zeroForOne;

    // Determine hook data
    let hookData = '0x';
    if (poolKey.hooks === '0x0000000000000000000000000000000000000000') {
      hookData = '0x';
    } else {
      // Encode user address for hooks that require it
      hookData = defaultAbiCoder.encode(['address'], [options.recipient]);
    }

    // Calculate amounts with slippage
    const slippageBps = Math.floor(parseFloat(options.slippageTolerance.toSignificant(6)) * 100);
    const multiplier = 10000 - slippageBps;
    // Convert JSBI to BigNumber for calculation
    let inputs = [];
    if (_tradeType === TradeType.EXACT_INPUT) {
      const amountOutBN = BigNumber.from(v4Quote.amountOut.quotient.toString());
      const amountOutMinimum = amountOutBN.mul(BigNumber.from(multiplier)).div(10000);

      const inputAmount = BigNumber.from(v4Quote.amountIn.quotient.toString());

      // Encode V4Router actions
      const actions = solidityPack(
        ['uint8', 'uint8', 'uint8'],
        [V4_ACTIONS.SWAP_EXACT_IN_SINGLE, V4_ACTIONS.SETTLE_ALL, V4_ACTIONS.TAKE_ALL],
      );

      // Prepare parameters array for the three actions
      const params = [
        // SWAP_EXACT_IN_SINGLE parameters
        defaultAbiCoder.encode(
          [
            `tuple(
            tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey,
            bool zeroForOne,
            uint128 amountIn,
            uint128 amountOutMinimum,
            bytes hookData
          )`,
          ],
          [
            {
              poolKey: poolKey,
              zeroForOne: zeroForOne,
              amountIn: inputAmount,
              amountOutMinimum: amountOutMinimum,
              hookData: hookData,
            },
          ],
        ),
        // SETTLE_ALL parameters (currency0, amountIn)
        defaultAbiCoder.encode(
          ['address', 'uint256'],
          [zeroForOne ? poolKey.currency0 : poolKey.currency1, inputAmount],
        ),
        // TAKE_ALL parameters (currency1, minAmountOut)
        defaultAbiCoder.encode(
          ['address', 'uint256'],
          [zeroForOne ? poolKey.currency1 : poolKey.currency0, amountOutMinimum],
        ),
      ];

      // Create inputs array for Universal Router
      inputs = [defaultAbiCoder.encode(['bytes', 'bytes[]'], [actions, params])];
    } else {
      const amountInBN = BigNumber.from(v4Quote.amountIn.quotient.toString());
      const multiplier = 10000 + slippageBps;
      const amountInMaximum = amountInBN.mul(BigNumber.from(multiplier)).div(10000);

      const outputAmount = BigNumber.from(v4Quote.amountOut.quotient.toString());

      const params = [
        // SWAP_EXACT_OUT_SINGLE parameters
        defaultAbiCoder.encode(
          [
            `tuple(
            tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey,
            bool zeroForOne,
            uint128 amountOut,
            uint128 amountInMaximum,
            bytes hookData
          )`,
          ],
          [
            {
              poolKey: poolKey,
              zeroForOne: zeroForOne,
              amountOut: outputAmount, // The exact output amount you want
              amountInMaximum: amountInMaximum, // Maximum input you're willing to pay
              hookData: hookData,
            },
          ],
        ),
        // SETTLE_ALL parameters (currency0, amountInMaximum)
        defaultAbiCoder.encode(
          ['address', 'uint256'],
          [zeroForOne ? poolKey.currency0 : poolKey.currency1, amountInMaximum],
        ),
        // TAKE_ALL parameters (currency1, exactAmountOut)
        defaultAbiCoder.encode(
          ['address', 'uint256'],
          [zeroForOne ? poolKey.currency1 : poolKey.currency0, outputAmount],
        ),
      ];
      // Encode V4Router actions
      const actions = solidityPack(
        ['uint8', 'uint8', 'uint8'],
        [V4_ACTIONS.SWAP_EXACT_OUT_SINGLE, V4_ACTIONS.SETTLE_ALL, V4_ACTIONS.TAKE_ALL],
      );
      inputs = [defaultAbiCoder.encode(['bytes', 'bytes[]'], [actions, params])];
    }
    // Build Universal Router execute call
    const universalRouterABI = [
      'function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable',
    ];
    const universalRouterAddress = UNIVERSAL_ROUTER_ADDRESS(UniversalRouterVersion.V2_0, this.chainId);
    const universalRouterContract = new Contract(universalRouterAddress, universalRouterABI, this.provider);
    const deadline = options.deadline || Math.floor(Date.now() / 1000) + 60 * 20; // 20 minutes default
    const populatedTx = await universalRouterContract.populateTransaction.execute(
      V4_COMMANDS.V4_SWAP,
      inputs,
      deadline,
    );

    return {
      calldata: populatedTx.data || '0x',
      value: populatedTx.value?.toString() || '0',
    };
  }

  /**
   * Extract route path from a trade
   */
  private extractRoutePath(trade: RouterTrade<Currency, Currency, TradeType>): string[] {
    const path: string[] = [];

    if (trade.swaps.length > 0) {
      const firstSwap = trade.swaps[0];
      const route = firstSwap.route;

      path.push(route.input.symbol || (route.input as Token).address);
      path.push(route.output.symbol || (route.output as Token).address);
    }

    return path;
  }

  /**
   * Estimate gas for the swap
   */
  private async estimateGas(calldata: string, value: string, from: string): Promise<BigNumber> {
    const ethereum = await this.getEthereum();
    const routerAddress = UNIVERSAL_ROUTER_ADDRESS(UniversalRouterVersion.V2_0, this.chainId);

    logger.info(`[UniversalRouter] Estimating gas...`);
    logger.info(`[UniversalRouter] From: ${from}`);
    logger.info(`[UniversalRouter] To: ${routerAddress}`);
    logger.info(`[UniversalRouter] Value: ${value}`);
    logger.info(`[UniversalRouter] Calldata length: ${calldata.length}`);

    try {
      // Get gas options from Ethereum
      const gasOptions = await ethereum.prepareGasOptions(undefined, 500000);
      logger.info(`[UniversalRouter] Gas options: ${JSON.stringify(gasOptions)}`);

      const gasEstimate = await this.provider.estimateGas({
        to: routerAddress,
        data: calldata,
        value,
        from,
        gasLimit: BigNumber.from(600000), // Increase gas limit for estimation
        ...gasOptions, // Include gas price options
      });

      logger.info(`[UniversalRouter] Gas estimation successful: ${gasEstimate.toString()}`);
      return gasEstimate;
    } catch (error) {
      // Check if this is a Permit2 AllowanceExpired error (0xd81b2f2e)
      const isPermit2Error = error.error && error.error.data && error.error.data.startsWith('0xd81b2f2e');

      if (isPermit2Error) {
        // This is expected if user hasn't approved tokens to Permit2 yet
        logger.info(`[UniversalRouter] Gas estimation skipped - Permit2 approval needed`);
        logger.debug(`[UniversalRouter] User needs to approve tokens to Permit2 before executing swap`);
      } else {
        // Log other errors as actual errors
        logger.error(`[UniversalRouter] Gas estimation failed:`, error);
        logger.error(`[UniversalRouter] Error message: ${error.message}`);
        if (error.error && error.error.data) {
          logger.error(`[UniversalRouter] Error data: ${error.error.data}`);
        }
        if (error.reason) {
          logger.error(`[UniversalRouter] Error reason: ${error.reason}`);
        }
      }

      // Use a higher default gas limit
      const defaultGas = BigNumber.from(500000);
      logger.info(`[UniversalRouter] Using default gas estimate: ${defaultGas.toString()}`);
      return defaultGas;
    }
  }
}
