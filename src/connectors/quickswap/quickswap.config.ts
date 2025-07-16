import { ConfigManagerV2 } from '../../services/config-manager-v2';

import {
    getQuickSwapV2RouterAddress,
    getQuickSwapV2FactoryAddress,
    getQuickSwapV3SmartOrderRouterAddress,
    getQuickSwapV3NftManagerAddress,
    getQuickSwapV3QuoterV2ContractAddress,
    getQuickSwapV3FactoryAddress,
} from './quickswap.contracts';

interface AvailableNetworks {
    chain: string;
    networks: Array<string>;
}

// Networks are fetched directly from configuration
// QuickSwap primarily supports Polygon and other chains
export namespace QuickSwapConfig {
    export interface NetworkConfig {
        // Pool configurations
        amm: { [pairName: string]: string };
        clmm?: { [pairName: string]: string }; // Optional for networks without V3
    }

    export interface NetworkPoolsConfig {
        // Dictionary of predefined pool addresses and settings by network
        [network: string]: NetworkConfig;
    }

    export interface RootConfig {
        // Global configuration
        allowedSlippage: string;
        maximumHops: number;

        // Network-specific configurations
        networks: NetworkPoolsConfig;

        // Available networks
        availableNetworks: Array<AvailableNetworks>;

        // Exported contract address helper methods
        quickswapV2RouterAddress: (network: string) => string;
        quickswapV2FactoryAddress: (network: string) => string;
        quickswapV3SmartOrderRouterAddress: (network: string) => string;
        quickswapV3NftManagerAddress: (network: string) => string;
        quoterContractAddress: (network: string) => string;
        quickswapV3FactoryAddress: (network: string) => string;
    }

    // Supported chains for QuickSwap
    export const chain = 'ethereum'; // QuickSwap runs on Ethereum-compatible chains

    // Get available networks from QuickSwap configuration
    export const networks: string[] = Object.keys(
        ConfigManagerV2.getInstance().get('quickswap.networks') || {
            polygon: {},
            mumbai: {},
            dogechain: {},
            'polygon-zkevm': {},
            manta: {},
        },
    );

    export const config: RootConfig = {
        // Global configuration
        allowedSlippage: ConfigManagerV2.getInstance().get(
            'quickswap.allowedSlippage',
        ) || '2/100', // Default 2% slippage
        maximumHops: ConfigManagerV2.getInstance().get('quickswap.maximumHops') || 4,

        // Network-specific pools
        networks: ConfigManagerV2.getInstance().get('quickswap.networks') || {},

        availableNetworks: [
            {
                chain: 'ethereum',
                networks: [
                    'polygon',
                    'mumbai',
                    'dogechain',
                    'polygon-zkevm',
                    'manta',
                ],
            },
        ],

        // Contract address getter methods
        quickswapV2RouterAddress: getQuickSwapV2RouterAddress,
        quickswapV2FactoryAddress: getQuickSwapV2FactoryAddress,
        quickswapV3SmartOrderRouterAddress: getQuickSwapV3SmartOrderRouterAddress,
        quickswapV3NftManagerAddress: getQuickSwapV3NftManagerAddress,
        quoterContractAddress: getQuickSwapV3QuoterV2ContractAddress,
        quickswapV3FactoryAddress: getQuickSwapV3FactoryAddress,
    };
} 