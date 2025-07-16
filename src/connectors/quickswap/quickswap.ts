import { QuickSwapConfig } from './quickswap.config';
import {
    findPoolAddress,
    isValidV2Pool,
    isValidV3Pool,
    isFractionString,
} from '../uniswap/uniswap.utils'; // Reuse Uniswap utilities since QuickSwap uses same interfaces
import {
    IUniswapV2PairABI,
    IUniswapV2FactoryABI,
    IUniswapV2Router02ABI,
    IAlgebraV3FactoryABI,
    IAlgebraV3QuoterABI,
    IAlgebraV3RouterABI
} from './quickswap.contracts';

// V3 (CLMM) imports - QuickSwap uses Algebra V3, not standard Uniswap V3
import { Token, CurrencyAmount, Percent } from '@uniswap/sdk-core';
import { AlphaRouter } from '@uniswap/smart-order-router';
import { Pair as V2Pair } from '@uniswap/v2-sdk';
// Note: QuickSwap uses Algebra V3, so we use our custom ABIs instead of Uniswap
import { abi as IUniswapV3PoolABI } from '@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json';
import { FeeAmount, Pool as V3Pool } from '@uniswap/v3-sdk';
import { Contract, constants } from 'ethers';
import { getAddress } from 'ethers/lib/utils';
import JSBI from 'jsbi';

import { Ethereum } from '../../chains/ethereum/ethereum';
import { percentRegexp } from '../../services/config-manager-v2';
import { logger } from '../../services/logger';

export class QuickSwap {
    private static _instances: { [name: string]: QuickSwap };

    // Ethereum chain instance (QuickSwap runs on Ethereum-compatible chains)
    private ethereum: Ethereum;

    // Configuration
    public config: QuickSwapConfig.RootConfig;

    // Common properties
    private chainId: number;
    private tokenList: Record<string, Token> = {};
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
                this.config.quickswapV2FactoryAddress(this.networkName),
                IUniswapV2FactoryABI.abi,
                this.ethereum.provider,
            );

            this.v2Router = new Contract(
                this.config.quickswapV2RouterAddress(this.networkName),
                IUniswapV2Router02ABI.abi,
                this.ethereum.provider,
            );

            // Initialize V3 (CLMM) contracts - only on supported networks
            try {
                this.v3Factory = new Contract(
                    this.config.quickswapV3FactoryAddress(this.networkName),
                    IAlgebraV3FactoryABI,
                    this.ethereum.provider,
                );

                this.v3NFTManager = new Contract(
                    this.config.quickswapV3NftManagerAddress(this.networkName),
                    // Use standard Uniswap V3 ABI since QuickSwap implements same interface
                    require('@uniswap/v3-periphery/artifacts/contracts/interfaces/INonfungiblePositionManager.sol/INonfungiblePositionManager.json').abi,
                    this.ethereum.provider,
                );

                this.v3Quoter = new Contract(
                    this.config.quoterContractAddress(this.networkName),
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

            // Load token list
            await this.loadTokens();

            this._ready = true;
            logger.info(`QuickSwap connector initialized for network: ${this.networkName}`);
        } catch (error) {
            logger.error(`Failed to initialize QuickSwap: ${error}`);
            throw error;
        }
    }

    /**
     * Load tokens for the current network
     */
    private async loadTokens() {
        try {
            const tokens = this.ethereum.storedTokenList;

            for (const token of tokens) {
                this.tokenList[token.symbol] = new Token(
                    this.chainId,
                    token.address,
                    token.decimals,
                    token.symbol,
                    token.name,
                );
            }

            logger.info(`Loaded ${Object.keys(this.tokenList).length} tokens for QuickSwap`);
        } catch (error) {
            logger.error(`Failed to load tokens for QuickSwap: ${error}`);
        }
    }

    /**
     * Check if the connector is ready
     */
    public get ready(): boolean {
        return this._ready;
    }

    /**
     * Get the network name
     */
    public get network(): string {
        return this.networkName;
    }

    /**
     * Get the chain ID
     */
    public get chain(): number {
        return this.chainId;
    }

    /**
     * Get a token by symbol
     */
    public getTokenBySymbol(symbol: string): Token | undefined {
        return this.tokenList[symbol];
    }

    /**
     * Get a token by address
     */
    public getTokenByAddress(address: string): Token | undefined {
        const tokens = Object.values(this.tokenList);
        return tokens.find(token => token.address.toLowerCase() === address.toLowerCase());
    }

    /**
     * Get all available tokens
     */
    public get storedTokenList(): Token[] {
        return Object.values(this.tokenList);
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
     * Get AlphaRouter instance (may be null)
     */
    public get alphaRouter(): AlphaRouter | null {
        return this._alphaRouter;
    }

    /**
     * Get allowed slippage as Percent
     */
    public get allowedSlippage(): Percent {
        if (isFractionString(this.config.allowedSlippage)) {
            const fractionSplit = this.config.allowedSlippage.split('/');
            return new Percent(fractionSplit[0], fractionSplit[1]);
        }

        const slippagePercent = parseFloat(this.config.allowedSlippage);
        return new Percent(Math.floor(slippagePercent * 100), 10000);
    }

    /**
     * Get gas limit override for the current network
     */
    public get gasLimitEstimate(): number {
        return this.ethereum.gasLimitTransaction;
    }

    /**
     * Get the default pools for a given connector type
     */
    public getDefaultPools(connectorType: 'amm' | 'clmm'): Record<string, string> {
        const networkConfig = this.config.networks[this.networkName];
        if (!networkConfig) {
            return {};
        }

        if (connectorType === 'amm') {
            return networkConfig.amm || {};
        } else if (connectorType === 'clmm' && networkConfig.clmm) {
            return networkConfig.clmm;
        }

        return {};
    }

    /**
     * Check if V3 is supported on this network
     */
    public get supportsV3(): boolean {
        return this.v3Factory !== null && this.v3NFTManager !== null && this.v3Quoter !== null;
    }

    /**
     * Find default pool address for a token pair
     */
    public async findDefaultPool(
        baseToken: string,
        quoteToken: string,
        connectorType: 'amm' | 'clmm'
    ): Promise<string | null> {
        try {
            const pools = this.getDefaultPools(connectorType);

            // Check if pool exists in configuration
            const poolKey = `${baseToken}-${quoteToken}`;
            const reversePoolKey = `${quoteToken}-${baseToken}`;

            if (pools[poolKey]) {
                return pools[poolKey];
            }

            if (pools[reversePoolKey]) {
                return pools[reversePoolKey];
            }

            // If not in config, try to find pool dynamically
            const baseTokenObj = this.getTokenBySymbol(baseToken);
            const quoteTokenObj = this.getTokenBySymbol(quoteToken);

            if (!baseTokenObj || !quoteTokenObj) {
                logger.warn(`Tokens not found: ${baseToken} or ${quoteToken}`);
                return null;
            }

            if (connectorType === 'amm' && this.v2Factory) {
                // Try to get V2 pair address
                const pairAddress = await this.v2Factory.getPair(
                    baseTokenObj.address,
                    quoteTokenObj.address
                );

                if (pairAddress && pairAddress !== '0x0000000000000000000000000000000000000000') {
                    logger.info(`Found V2 pair: ${pairAddress} for ${baseToken}-${quoteToken}`);
                    return pairAddress;
                }
            } else if (connectorType === 'clmm' && this.v3Factory) {
                // QuickSwap Algebra V3: Use poolByPair (no fee parameter - dynamic fees)
                const poolAddress = await this.v3Factory.poolByPair(
                    baseTokenObj.address,
                    quoteTokenObj.address
                );

                if (poolAddress && poolAddress !== '0x0000000000000000000000000000000000000000') {
                    logger.info(`Found Algebra V3 pool: ${poolAddress} for ${baseToken}-${quoteToken}`);
                    return poolAddress;
                }
            }

            logger.warn(`No pool found for ${baseToken}-${quoteToken} on ${connectorType}`);
            return null;
        } catch (error) {
            logger.error(`Error finding default pool: ${error.message}`);
            return null;
        }
    }
} 