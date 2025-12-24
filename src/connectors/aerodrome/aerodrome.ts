// V3 (CLMM) imports
import { Token } from '@uniswap/sdk-core';
import { abi as IUniswapV3FactoryABI } from '@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Factory.sol/IUniswapV3Factory.json';
import { abi as IUniswapV3PoolABI } from '@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json';
import { Pool as V3Pool } from '@uniswap/v3-sdk';
import { Contract, constants, providers } from 'ethers';
import { getAddress } from 'ethers/lib/utils';
import JSBI from 'jsbi';

import { Ethereum, TokenInfo } from '../../chains/ethereum/ethereum';
import { logger } from '../../services/logger';
import { isValidV3Pool } from '../uniswap/uniswap.utils';

import { AerodromeConfig } from './aerodrome.config';
import {
  getAerodromeV3FactoryAddress,
  getAerodromeV3QuoterAddress,
  IAerodromeV3PoolABI as AerodromePoolABI,
} from './aerodrome.contracts';

export class Aerodrome {
  private static _instances: { [name: string]: Aerodrome };

  // Ethereum chain instance
  private ethereum: Ethereum;

  // Configuration
  public config: AerodromeConfig.RootConfig;

  // Common properties
  private chainId: number;
  private _ready: boolean = false;

  // V3 (CLMM) properties
  private v3Factory: Contract;
  private v3Quoter: Contract;

  // Network information
  private networkName: string;

  private constructor(network: string) {
    this.networkName = network;
    this.config = AerodromeConfig.config;
  }

  public static async getInstance(network: string): Promise<Aerodrome> {
    if (Aerodrome._instances === undefined) {
      Aerodrome._instances = {};
    }

    if (!(network in Aerodrome._instances)) {
      Aerodrome._instances[network] = new Aerodrome(network);
      await Aerodrome._instances[network].init();
    }

    return Aerodrome._instances[network];
  }

  /**
   * Initialize the Aerodrome instance
   */
  public async init() {
    try {
      // Initialize the Ethereum chain instance
      this.ethereum = await Ethereum.getInstance(this.networkName);
      this.chainId = this.ethereum.chainId;

      // Initialize V3 (CLMM) contracts
      this.v3Factory = new Contract(
        getAerodromeV3FactoryAddress(this.networkName),
        IUniswapV3FactoryABI,
        this.ethereum.provider,
      );

      // Initialize Quoter
      this.v3Quoter = new Contract(
        getAerodromeV3QuoterAddress(this.networkName),
        [
          {
            inputs: [
              { internalType: 'address', name: 'tokenIn', type: 'address' },
              { internalType: 'address', name: 'tokenOut', type: 'address' },
              { internalType: 'int24', name: 'tickSpacing', type: 'int24' },
              { internalType: 'uint256', name: 'amountIn', type: 'uint256' },
              { internalType: 'uint160', name: 'sqrtPriceLimitX96', type: 'uint160' },
            ],
            name: 'quoteExactInputSingle',
            outputs: [
              { internalType: 'uint256', name: 'amountOut', type: 'uint256' },
              { internalType: 'uint160', name: 'sqrtPriceX96After', type: 'uint160' },
              { internalType: 'uint32', name: 'initializedTicksCrossed', type: 'uint32' },
              { internalType: 'uint256', name: 'gasEstimate', type: 'uint256' },
            ],
            stateMutability: 'nonpayable',
            type: 'function',
          },
        ],
        this.ethereum.provider,
      );

      // Ensure ethereum is initialized
      if (!this.ethereum.ready()) {
        await this.ethereum.init();
      }

      this._ready = true;
      logger.info(`Aerodrome connector initialized for network: ${this.networkName}`);
    } catch (error) {
      logger.error(`Error initializing Aerodrome: ${error.message}`);
      throw error;
    }
  }

  /**
   * Check if the Aerodrome instance is ready
   */
  public ready(): boolean {
    return this._ready;
  }

  /**
   * Given a token's address, return the connector's native representation of the token.
   */
  public getTokenByAddress(address: string): Token | null {
    const tokenInfo = this.ethereum.getToken(address);
    if (!tokenInfo) return null;

    // Create Uniswap SDK Token instance
    return new Token(tokenInfo.chainId, tokenInfo.address, tokenInfo.decimals, tokenInfo.symbol, tokenInfo.name);
  }

  /**
   * Given a token's symbol, return the connector's native representation of the token.
   */
  public getTokenBySymbol(symbol: string): Token | null {
    // Just use getTokenByAddress since ethereum.getToken handles both symbols and addresses
    return this.getTokenByAddress(symbol);
  }

  /**
   * Create a Uniswap SDK Token object from token info
   * @param tokenInfo Token information from Ethereum
   * @returns Uniswap SDK Token object
   */
  public getAerodromeToken(tokenInfo: TokenInfo): Token {
    return new Token(this.ethereum.chainId, tokenInfo.address, tokenInfo.decimals, tokenInfo.symbol, tokenInfo.name);
  }

  /**
   * Get tickSpacing from a pool contract
   * @param poolAddress The pool address
   * @returns The tickSpacing value
   */
  public async getPoolTickSpacing(poolAddress: string): Promise<number> {
    try {
      const poolContract = new Contract(poolAddress, AerodromePoolABI, this.ethereum.provider);
      const tickSpacing = await poolContract.tickSpacing();
      return tickSpacing;
    } catch (error) {
      logger.error(`Error getting tickSpacing from pool ${poolAddress}: ${error.message}`);
      // Default to 60 if we can't get it
      return 60;
    }
  }

  /**
   * Get a V3 pool by its address or by token symbols
   * For Aerodrome, we use tickSpacing instead of fee
   */
  public async getV3Pool(
    tokenA: Token | string,
    tokenB: Token | string,
    poolAddress?: string,
  ): Promise<{ pool: V3Pool | null; tickSpacing: number }> {
    try {
      // Resolve pool address if provided
      const poolAddr = poolAddress;

      // If tokenA and tokenB are strings, assume they are symbols
      const tokenAObj = typeof tokenA === 'string' ? this.getTokenBySymbol(tokenA) : tokenA;
      const tokenBObj = typeof tokenB === 'string' ? this.getTokenBySymbol(tokenB) : tokenB;
      if (!tokenAObj || !tokenBObj) {
        throw new Error(`Invalid tokens: ${tokenA}, ${tokenB}`);
      }

      // Find pool address if not provided
      // Note: Aerodrome uses a different factory method, but for now we'll require poolAddress
      if (!poolAddr) {
        throw new Error('Pool address is required for Aerodrome pools');
      }

      // If no pool exists or invalid address, return null
      if (!poolAddr || poolAddr === constants.AddressZero) {
        return { pool: null, tickSpacing: 60 };
      }

      // Check if pool is valid
      const isValid = await isValidV3Pool(poolAddr);
      if (!isValid) {
        return { pool: null, tickSpacing: 60 };
      }

      // Get pool data from the contract
      const poolContract = new Contract(poolAddr, AerodromePoolABI, this.ethereum.provider);

      const [liquidity, slot0, tickSpacing, fee] = await Promise.all([
        poolContract.liquidity(),
        poolContract.slot0(),
        poolContract.tickSpacing(),
        poolContract.fee(), // Aerodrome pools still have fee, but we use tickSpacing for routing
      ]);

      // Aerodrome's slot0() returns 6 values: [sqrtPriceX96, tick, observationIndex, observationCardinality, observationCardinalityNext, unlocked]
      // We only need the first two for pool creation
      const [sqrtPriceX96, tick] = slot0;

      // Create the pool with a tick data provider to avoid 'No tick data provider' error
      // Note: We use fee for the V3Pool constructor (required by SDK), but tickSpacing for routing
      const pool = new V3Pool(
        tokenAObj,
        tokenBObj,
        fee, // SDK requires fee, but we'll use tickSpacing for actual swaps
        sqrtPriceX96.toString(),
        liquidity.toString(),
        tick,
        // Add a tick data provider to make SDK operations work
        {
          async getTick(index) {
            return {
              index,
              liquidityNet: JSBI.BigInt(0),
              liquidityGross: JSBI.BigInt(0),
            };
          },
          async nextInitializedTickWithinOneWord(tick, lte, spacing) {
            // Always return a valid result to prevent errors
            // Use the direction parameter (lte) to determine which way to go
            const nextTick = lte ? tick - spacing : tick + spacing;
            return [nextTick, false];
          },
        },
      );
      return { pool, tickSpacing: Number(tickSpacing) };
    } catch (error) {
      logger.error(`Error getting V3 pool: ${error.message}`);
      return { pool: null, tickSpacing: 60 };
    }
  }

  /**
   * Find a default pool for a token pair in CLMM
   */
  public async findDefaultPool(baseToken: string, quoteToken: string, poolType: 'clmm'): Promise<string | null> {
    try {
      logger.info(`Finding ${poolType} pool for ${baseToken}-${quoteToken} on ${this.networkName}`);

      // Resolve token symbols if addresses are provided
      const baseTokenInfo = this.getTokenBySymbol(baseToken) || this.getTokenByAddress(baseToken);
      const quoteTokenInfo = this.getTokenBySymbol(quoteToken) || this.getTokenByAddress(quoteToken);

      if (!baseTokenInfo || !quoteTokenInfo) {
        logger.warn(`Token not found: ${!baseTokenInfo ? baseToken : quoteToken}`);
        return null;
      }

      logger.info(
        `Resolved tokens: ${baseTokenInfo.symbol} (${baseTokenInfo.address}), ${quoteTokenInfo.symbol} (${quoteTokenInfo.address})`,
      );

      // Use PoolService to find pool by token pair
      const { PoolService } = await import('../../services/pool-service');
      const poolService = PoolService.getInstance();

      const pool = await poolService.getPool(
        'aerodrome',
        this.networkName,
        poolType,
        baseTokenInfo.symbol,
        quoteTokenInfo.symbol,
      );

      if (!pool) {
        logger.warn(
          `No ${poolType} pool found for ${baseTokenInfo.symbol}-${quoteTokenInfo.symbol} on Aerodrome network ${this.networkName}`,
        );
        return null;
      }

      logger.info(`Found ${poolType} pool at ${pool.address}`);
      return pool.address;
    } catch (error) {
      logger.error(`Error finding default pool: ${error.message}`);
      if (error.stack) {
        logger.debug(`Stack trace: ${error.stack}`);
      }
      return null;
    }
  }

  /**
   * Get the Ethereum provider
   */
  public get provider(): providers.StaticJsonRpcProvider {
    return this.ethereum.provider;
  }

  /**
   * Get the chain ID
   */
  public get chainIdValue(): number {
    return this.chainId;
  }

  /**
   * Get the network name
   */
  public get networkNameValue(): string {
    return this.networkName;
  }
}
