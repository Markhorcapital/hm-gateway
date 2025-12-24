// V3 (CLMM) imports - QuickSwap uses Algebra V3, not standard Uniswap V3
import { Token, CurrencyAmount, Percent, TradeType } from '@uniswap/sdk-core';
import { AlphaRouter } from '@uniswap/smart-order-router';
import { Pair as V2Pair, Route as V2Route, Trade as V2Trade } from '@uniswap/v2-sdk';
import { FeeAmount, Pool as V3Pool } from '@uniswap/v3-sdk';
import { Contract, constants, providers } from 'ethers';
import { getAddress } from 'ethers/lib/utils';
import JSBI from 'jsbi';

import { Ethereum, TokenInfo } from '../../chains/ethereum/ethereum';
import { logger } from '../../services/logger';
import { isValidV2Pool, isValidV3Pool } from '../uniswap/uniswap.utils';

import { QuickSwapConfig } from './quickswap.config';
import {
  IUniswapV2PairABI,
  IUniswapV2FactoryABI,
  IUniswapV2Router02ABI,
  IAlgebraV3FactoryABI,
  IAlgebraV3QuoterABI,
  IAlgebraV3PositionManagerABI,
  getQuickSwapV2RouterAddress,
  getQuickSwapV2FactoryAddress,
  getQuickSwapV3NftManagerAddress,
  getQuickSwapV3QuoterV2ContractAddress,
  getQuickSwapV3FactoryAddress,
} from './quickswap.contracts';

export class QuickSwap {
  private static _instances: { [name: string]: QuickSwap };

  // Ethereum chain instance (QuickSwap runs on Ethereum-compatible chains)
  private ethereum: Ethereum;

  // Configuration
  public config: QuickSwapConfig.RootConfig;

  // Common properties
  private chainId: number;
  private _ready: boolean = false;

  // V2 (AMM) properties
  private v2Factory: Contract;
  private v2Router: Contract;

  // V3 (CLMM) properties - only available on some networks
  private _alphaRouter: AlphaRouter | null;
  private v3Factory: Contract | null;
  private v3NFTManager: Contract | null;
  private v3Quoter: Contract | null;

  // Network information
  private networkName: string;

  private constructor(network: string) {
    this.networkName = network;
    this.config = QuickSwapConfig.config;
  }

  public static async getInstance(network: string): Promise<QuickSwap> {
    if (QuickSwap._instances === undefined) {
      QuickSwap._instances = {};
    }

    if (!(network in QuickSwap._instances)) {
      QuickSwap._instances[network] = new QuickSwap(network);
      await QuickSwap._instances[network].init();
    }

    return QuickSwap._instances[network];
  }

  /**
   * Initialize the QuickSwap instance
   */
  public async init() {
    try {
      // Initialize the Ethereum chain instance
      this.ethereum = await Ethereum.getInstance(this.networkName);
      this.chainId = this.ethereum.chainId;

      // Initialize V2 (AMM) contracts - always available
      this.v2Factory = new Contract(
        getQuickSwapV2FactoryAddress(this.networkName),
        IUniswapV2FactoryABI.abi,
        this.ethereum.provider,
      );

      this.v2Router = new Contract(
        getQuickSwapV2RouterAddress(this.networkName),
        IUniswapV2Router02ABI.abi,
        this.ethereum.provider,
      );

      // Initialize V3 (CLMM) contracts - only on supported networks
      try {
        this.v3Factory = new Contract(
          getQuickSwapV3FactoryAddress(this.networkName),
          IAlgebraV3FactoryABI,
          this.ethereum.provider,
        );

        this.v3NFTManager = new Contract(
          getQuickSwapV3NftManagerAddress(this.networkName),
          IAlgebraV3PositionManagerABI,
          this.ethereum.provider,
        );

        this.v3Quoter = new Contract(
          getQuickSwapV3QuoterV2ContractAddress(this.networkName),
          IAlgebraV3QuoterABI,
          this.ethereum.provider,
        );

        // Initialize AlphaRouter for V3 swap routing
        this._alphaRouter = new AlphaRouter({
          chainId: this.chainId,
          provider: this.ethereum.provider,
        });

        logger.info(`QuickSwap V3 contracts initialized for network: ${this.networkName}`);
      } catch (error) {
        // V3 contracts not available on this network
        logger.info(`QuickSwap V3 contracts not available for network: ${this.networkName}`);
        this.v3Factory = null;
        this.v3NFTManager = null;
        this.v3Quoter = null;
        this._alphaRouter = null;
      }

      // Ensure ethereum is initialized
      if (!this.ethereum.ready()) {
        await this.ethereum.init();
      }

      this._ready = true;
      logger.info(`QuickSwap connector initialized for network: ${this.networkName}`);
    } catch (error) {
      logger.error(`Error initializing QuickSwap: ${error.message}`);
      throw error;
    }
  }

  /**
   * Check if the QuickSwap instance is ready
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
  public getQuickSwapToken(tokenInfo: TokenInfo): Token {
    return new Token(this.ethereum.chainId, tokenInfo.address, tokenInfo.decimals, tokenInfo.symbol, tokenInfo.name);
  }

  /**
   * Get a V2 pool (pair) by its address or by token symbols
   */
  public async getV2Pool(tokenA: Token | string, tokenB: Token | string, poolAddress?: string): Promise<V2Pair | null> {
    try {
      // Resolve pool address if provided
      let pairAddress = poolAddress;

      // If tokenA and tokenB are strings, assume they are symbols
      const tokenAObj = typeof tokenA === 'string' ? this.getTokenBySymbol(tokenA) : tokenA;

      const tokenBObj = typeof tokenB === 'string' ? this.getTokenBySymbol(tokenB) : tokenB;

      if (!tokenAObj || !tokenBObj) {
        throw new Error(`Invalid tokens: ${tokenA}, ${tokenB}`);
      }

      // Find pool address if not provided
      if (!pairAddress) {
        // Try to get it from the factory
        pairAddress = await this.v2Factory.getPair(tokenAObj.address, tokenBObj.address);
      }

      // If no pair exists or invalid address, return null
      if (!pairAddress || pairAddress === constants.AddressZero) {
        return null;
      }

      // Check if pool is valid
      const isValid = await isValidV2Pool(pairAddress);
      if (!isValid) {
        return null;
      }

      // Get pair data from the contract
      const pairContract = new Contract(pairAddress, IUniswapV2PairABI.abi, this.ethereum.provider);

      const [reserves, token0Address] = await Promise.all([pairContract.getReserves(), pairContract.token0()]);

      const [reserve0, reserve1] = reserves;
      const token0 = getAddress(token0Address) === getAddress(tokenAObj.address) ? tokenAObj : tokenBObj;
      const token1 = token0.address === tokenAObj.address ? tokenBObj : tokenAObj;

      return new V2Pair(
        CurrencyAmount.fromRawAmount(token0, reserve0.toString()),
        CurrencyAmount.fromRawAmount(token1, reserve1.toString()),
      );
    } catch (error) {
      logger.error(`Error getting V2 pool: ${error.message}`);
      return null;
    }
  }

  /**
   * Get a V3 pool by its address or by token symbols (Algebra V3 uses poolByPair, no fee parameter)
   */
  public async getV3Pool(tokenA: Token | string, tokenB: Token | string, poolAddress?: string): Promise<V3Pool | null> {
    try {
      // Resolve pool address if provided
      let poolAddr = poolAddress;

      // If tokenA and tokenB are strings, assume they are symbols
      const tokenAObj = typeof tokenA === 'string' ? this.getTokenBySymbol(tokenA) : tokenA;

      const tokenBObj = typeof tokenB === 'string' ? this.getTokenBySymbol(tokenB) : tokenB;

      if (!tokenAObj || !tokenBObj) {
        throw new Error(`Invalid tokens: ${tokenA}, ${tokenB}`);
      }

      // Find pool address if not provided - QuickSwap Algebra V3 uses poolByPair (no fee parameter)
      if (!poolAddr && this.v3Factory) {
        poolAddr = await this.v3Factory.poolByPair(tokenAObj.address, tokenBObj.address);
      }

      // If no pool exists or invalid address, return null
      if (!poolAddr || poolAddr === constants.AddressZero) {
        return null;
      }

      // Check if pool is valid
      const isValid = await isValidV3Pool(poolAddr);
      if (!isValid) {
        return null;
      }

      // Get pool data from the contract - Algebra V3 pool structure
      const { abi: IUniswapV3PoolABI } = await import(
        '@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json'
      );
      const poolContract = new Contract(poolAddr, IUniswapV3PoolABI, this.ethereum.provider);

      const [liquidity, slot0] = await Promise.all([poolContract.liquidity(), poolContract.slot0()]);

      // For Algebra V3, try to get fee from the pool contract
      // Algebra pools may use different methods, try standard fee() first
      let feeData: any;
      try {
        feeData = await poolContract.fee();
      } catch (error) {
        // If fee() doesn't exist, try globalState() for Algebra
        try {
          const globalState = await poolContract.globalState();
          feeData = globalState.fee || globalState.fee_;
        } catch (e) {
          // Default fee if we can't determine
          feeData = 3000; // 0.3% default
          logger.warn(`Could not determine fee for pool ${poolAddr}, using default 3000`);
        }
      }

      const [sqrtPriceX96, tick] = slot0;

      // Create the pool with a tick data provider to avoid 'No tick data provider' error
      return new V3Pool(
        tokenAObj,
        tokenBObj,
        feeData,
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
          async nextInitializedTickWithinOneWord(tick, lte, tickSpacing) {
            const nextTick = lte ? tick - tickSpacing : tick + tickSpacing;
            return [nextTick, false];
          },
        },
      );
    } catch (error) {
      logger.error(`Error getting V3 pool: ${error.message}`);
      return null;
    }
  }

  /**
   * Find a default pool for a token pair in either AMM or CLMM
   */
  public async findDefaultPool(
    baseToken: string,
    quoteToken: string,
    poolType: 'amm' | 'clmm',
  ): Promise<string | null> {
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
        'quickswap',
        this.networkName,
        poolType,
        baseTokenInfo.symbol,
        quoteTokenInfo.symbol,
      );

      if (!pool) {
        // Fallback: Try to find pool dynamically
        if (poolType === 'amm' && this.v2Factory) {
          const pairAddress = await this.v2Factory.getPair(baseTokenInfo.address, quoteTokenInfo.address);
          if (pairAddress && pairAddress !== constants.AddressZero) {
            logger.info(`Found V2 pair: ${pairAddress} for ${baseTokenInfo.symbol}-${quoteTokenInfo.symbol}`);
            return pairAddress;
          }
        } else if (poolType === 'clmm' && this.v3Factory) {
          // QuickSwap Algebra V3: Use poolByPair (no fee parameter - dynamic fees)
          const poolAddress = await this.v3Factory.poolByPair(baseTokenInfo.address, quoteTokenInfo.address);
          if (poolAddress && poolAddress !== constants.AddressZero) {
            logger.info(`Found Algebra V3 pool: ${poolAddress} for ${baseTokenInfo.symbol}-${quoteTokenInfo.symbol}`);
            return poolAddress;
          }
        }

        logger.warn(
          `No ${poolType} pool found for ${baseTokenInfo.symbol}-${quoteTokenInfo.symbol} on QuickSwap network ${this.networkName}`,
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
   * Check if V3 is supported on this network
   */
  public get supportsV3(): boolean {
    return this.v3Factory !== null && this.v3NFTManager !== null && this.v3Quoter !== null;
  }

  /**
   * Get V2 factory contract
   */
  public get factoryV2(): Contract {
    return this.v2Factory;
  }

  /**
   * Get V2 router contract
   */
  public get routerV2(): Contract {
    return this.v2Router;
  }

  /**
   * Get V3 factory contract (may be null)
   */
  public get factoryV3(): Contract | null {
    return this.v3Factory;
  }

  /**
   * Get V3 NFT manager contract (may be null)
   */
  public get nftManagerV3(): Contract | null {
    return this.v3NFTManager;
  }

  /**
   * Get V3 quoter contract (may be null)
   */
  public get quoterV3(): Contract | null {
    return this.v3Quoter;
  }

  /**
   * Get ethereum provider
   */
  public get provider(): providers.StaticJsonRpcProvider {
    return this.ethereum.provider;
  }

  /**
   * Get AlphaRouter instance (may be null)
   */
  public get alphaRouter(): AlphaRouter | null {
    return this._alphaRouter;
  }

  /**
   * Get allowed slippage as Percent
   */
  public get allowedSlippage(): Percent {
    const slippagePercent = this.config.slippagePct || 0.5;
    return new Percent(Math.floor(slippagePercent * 100), 10000);
  }

  /**
   * Get gas limit estimate for the current network
   */
  public get gasLimitEstimate(): number {
    // Default gas limit for most operations
    return 300000;
  }

  /**
   * Get the first available wallet address from Ethereum
   */
  public async getFirstWalletAddress(): Promise<string | null> {
    try {
      return await Ethereum.getFirstWalletAddress();
    } catch (error) {
      logger.error(`Error getting first wallet address: ${error.message}`);
      return null;
    }
  }

  /**
   * Check NFT ownership for QuickSwap V3 positions
   * @param positionId The NFT position ID
   * @param walletAddress The wallet address to check ownership for
   * @throws Error if position is not owned by wallet or position ID is invalid
   */
  public async checkNFTOwnership(positionId: string, walletAddress: string): Promise<void> {
    if (!this.v3NFTManager) {
      throw new Error('V3 NFT Manager not available on this network');
    }

    const nftContract = new Contract(
      getQuickSwapV3NftManagerAddress(this.networkName),
      [
        {
          inputs: [{ internalType: 'uint256', name: 'tokenId', type: 'uint256' }],
          name: 'ownerOf',
          outputs: [{ internalType: 'address', name: '', type: 'address' }],
          stateMutability: 'view',
          type: 'function',
        },
      ],
      this.ethereum.provider,
    );

    try {
      const owner = await nftContract.ownerOf(positionId);
      if (owner.toLowerCase() !== walletAddress.toLowerCase()) {
        throw new Error(`Position ${positionId} is not owned by wallet ${walletAddress}`);
      }
    } catch (error: any) {
      if (error.message.includes('is not owned by')) {
        throw error;
      }
      throw new Error(`Invalid position ID ${positionId}`);
    }
  }

  /**
   * Check NFT approval for QuickSwap V3 positions
   * @param positionId The NFT position ID
   * @param walletAddress The wallet address that owns the NFT
   * @param operatorAddress The address that needs approval (usually the position manager itself)
   * @throws Error if NFT is not approved
   */
  public async checkNFTApproval(positionId: string, walletAddress: string, operatorAddress: string): Promise<void> {
    if (!this.v3NFTManager) {
      throw new Error('V3 NFT Manager not available on this network');
    }

    const nftContract = new Contract(
      getQuickSwapV3NftManagerAddress(this.networkName),
      [
        {
          inputs: [{ internalType: 'uint256', name: 'tokenId', type: 'uint256' }],
          name: 'getApproved',
          outputs: [{ internalType: 'address', name: '', type: 'address' }],
          stateMutability: 'view',
          type: 'function',
        },
        {
          inputs: [
            { internalType: 'address', name: 'owner', type: 'address' },
            { internalType: 'address', name: 'operator', type: 'address' },
          ],
          name: 'isApprovedForAll',
          outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
          stateMutability: 'view',
          type: 'function',
        },
      ],
      this.ethereum.provider,
    );

    // Check if the position manager itself is approved (it should be the operator)
    const approvedAddress = await nftContract.getApproved(positionId);
    const isApprovedForAll = await nftContract.isApprovedForAll(walletAddress, operatorAddress);

    if (approvedAddress.toLowerCase() !== operatorAddress.toLowerCase() && !isApprovedForAll) {
      throw new Error(
        `Insufficient NFT approval. Please approve the position NFT (${positionId}) for the QuickSwap Position Manager (${operatorAddress})`,
      );
    }
  }

  /**
   * Close the QuickSwap instance and clean up resources
   */
  public async close() {
    // Clean up resources
    if (this.networkName in QuickSwap._instances) {
      delete QuickSwap._instances[this.networkName];
    }
  }
}
