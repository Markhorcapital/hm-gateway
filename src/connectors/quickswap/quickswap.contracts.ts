/**
 * QuickSwap contract addresses for various networks
 * This file contains the contract addresses for QuickSwap V2 and V3 contracts
 * on different networks. These are not meant to be edited by users.
 *
 * Last updated: January 2025
 * Source: https://docs.quickswap.exchange/overview/contracts-and-addresses
 */

export interface QuickSwapContractAddresses {
    // V2 contracts (AMM)
    quickswapV2RouterAddress: string;
    quickswapV2FactoryAddress: string;

    // V3 contracts (CLMM) - Algebra or Uni implementation
    quickswapV3SmartOrderRouterAddress?: string;
    quickswapV3NftManagerAddress?: string;
    quickswapV3QuoterV2ContractAddress?: string;
    quickswapV3FactoryAddress?: string;
}

export interface NetworkContractAddresses {
    [network: string]: QuickSwapContractAddresses;
}

export const contractAddresses: NetworkContractAddresses = {
    // Polygon mainnet - Main QuickSwap network
    polygon: {
        // V2 contracts
        quickswapV2RouterAddress: '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff',
        quickswapV2FactoryAddress: '0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32',

        // V3 contracts (Algebra implementation)
        quickswapV3SmartOrderRouterAddress: '0xf5b509bB0909a69B1c207E495f687a596C168E12',
        quickswapV3NftManagerAddress: '0x8eF88E4c7CfbbaC1C163f7eddd4B578792201de6',
        quickswapV3QuoterV2ContractAddress: '0xa15F0D7377B2A0C0c10db057f641beD21028FC89',
        quickswapV3FactoryAddress: '0x411b0fAcC3489691f28ad58c47006AF5E3Ab3A28',
    },

    // Mumbai testnet
    mumbai: {
        // V2 contracts
        quickswapV2RouterAddress: '0x8954AfA98594b838bda56FE4C12a09D7739D179b',
        quickswapV2FactoryAddress: '0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32',
    },

    // Dogechain
    dogechain: {
        // V2 contracts
        quickswapV2RouterAddress: '0xAF96E63f965374dB6514e8CF595fB0a3f4d7763c',
        quickswapV2FactoryAddress: '0xC3550497E591Ac6ed7a7E03ffC711CfB7412E57F',

        // V3 contracts (Algebra implementation)
        quickswapV3SmartOrderRouterAddress: '0x4aE2bD0666c76C7f39311b9B3e39b53C8D7C43Ea',
        quickswapV3NftManagerAddress: '0xd8E1E7009802c914b0d39B31Fc1759A865b727B1',
        quickswapV3QuoterV2ContractAddress: '0xd8E1E7009802c914b0d39B31Fc1759A865b727B1',
        quickswapV3FactoryAddress: '0xd2480162Aa7F02Ead7BF4C127465446150D58452',
    },

    // Polygon zkEVM (Algebra implementation)
    'polygon-zkevm': {
        // V2 contracts
        quickswapV2RouterAddress: '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff',
        quickswapV2FactoryAddress: '0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32',

        // V3 contracts (Algebra implementation)
        quickswapV3SmartOrderRouterAddress: '0xF6Ad3CcF71Abb3E12beCf6b3D2a74C963859ADCd',
        quickswapV3NftManagerAddress: '0xd8E1E7009802c914b0d39B31Fc1759A865b727B1',
        quickswapV3QuoterV2ContractAddress: '0x55BeE1bD3Eb9986f6d2d963278de09eE92a3eF1D',
        quickswapV3FactoryAddress: '0x4B9f4d2435Ef65559567e5DbFC1BbB37abC43B57',
    },

    // Manta Pacific (Uni implementation)
    manta: {
        // V2 contracts - Using router address from official docs
        quickswapV2RouterAddress: '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff',
        quickswapV2FactoryAddress: '0x56c2162254b0E4417288786eE402c2B41d4e181e',

        // V3 contracts (Uni implementation)
        quickswapV3SmartOrderRouterAddress: '0xfdE3eaC61C5Ad5Ed617eB1451cc7C3a0AC197564',
        quickswapV3NftManagerAddress: '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff',
        quickswapV3QuoterV2ContractAddress: '0x3005827fB92A0cb7D0f65738D6D645d98A4Ad96b',
        quickswapV3FactoryAddress: '0x56c2162254b0E4417288786eE402c2B41d4e181e',
    },
};

// Helper functions to get contract addresses
export const getQuickSwapV2RouterAddress = (network: string): string => {
    const addresses = contractAddresses[network];
    if (!addresses) {
        throw new Error(`QuickSwap V2 router address not found for network: ${network}`);
    }
    return addresses.quickswapV2RouterAddress;
};

export const getQuickSwapV2FactoryAddress = (network: string): string => {
    const addresses = contractAddresses[network];
    if (!addresses) {
        throw new Error(`QuickSwap V2 factory address not found for network: ${network}`);
    }
    return addresses.quickswapV2FactoryAddress;
};

export const getQuickSwapV3SmartOrderRouterAddress = (network: string): string => {
    const addresses = contractAddresses[network];
    if (!addresses || !addresses.quickswapV3SmartOrderRouterAddress) {
        throw new Error(`QuickSwap V3 smart order router address not found for network: ${network}`);
    }
    return addresses.quickswapV3SmartOrderRouterAddress;
};

export const getQuickSwapV3NftManagerAddress = (network: string): string => {
    const addresses = contractAddresses[network];
    if (!addresses || !addresses.quickswapV3NftManagerAddress) {
        throw new Error(`QuickSwap V3 NFT manager address not found for network: ${network}`);
    }
    return addresses.quickswapV3NftManagerAddress;
};

export const getQuickSwapV3QuoterV2ContractAddress = (network: string): string => {
    const addresses = contractAddresses[network];
    if (!addresses || !addresses.quickswapV3QuoterV2ContractAddress) {
        throw new Error(`QuickSwap V3 quoter address not found for network: ${network}`);
    }
    return addresses.quickswapV3QuoterV2ContractAddress;
};

export const getQuickSwapV3FactoryAddress = (network: string): string => {
    const addresses = contractAddresses[network];
    if (!addresses || !addresses.quickswapV3FactoryAddress) {
        throw new Error(`QuickSwap V3 factory address not found for network: ${network}`);
    }
    return addresses.quickswapV3FactoryAddress;
};

// Re-export Uniswap ABIs since QuickSwap uses the same interfaces
export {
    IUniswapV2PairABI,
    IUniswapV2FactoryABI,
    IUniswapV2Router02ABI
} from '../uniswap/uniswap.contracts';

/**
 * QuickSwap Algebra V3 ABIs
 * These are different from standard Uniswap V3 due to Algebra implementation
 */

/**
 * QuickSwap Algebra V3 Factory ABI
 * Key difference: poolByPair(tokenA, tokenB) instead of getPool(tokenA, tokenB, fee)
 */
export const IAlgebraV3FactoryABI = [
    {
        inputs: [
            { internalType: 'address', name: 'tokenA', type: 'address' },
            { internalType: 'address', name: 'tokenB', type: 'address' }
        ],
        name: 'poolByPair',
        outputs: [{ internalType: 'address', name: '', type: 'address' }],
        stateMutability: 'view',
        type: 'function'
    },
    {
        inputs: [
            { internalType: 'address', name: 'tokenA', type: 'address' },
            { internalType: 'address', name: 'tokenB', type: 'address' }
        ],
        name: 'createPool',
        outputs: [{ internalType: 'address', name: 'pool', type: 'address' }],
        stateMutability: 'nonpayable',
        type: 'function'
    }
];

/**
 * QuickSwap Algebra V3 Quoter ABI
 * Key difference: Returns dynamic fee, no fee parameter in input
 */
export const IAlgebraV3QuoterABI = [
    {
        inputs: [
            { internalType: 'address', name: 'tokenIn', type: 'address' },
            { internalType: 'address', name: 'tokenOut', type: 'address' },
            { internalType: 'uint256', name: 'amountIn', type: 'uint256' },
            { internalType: 'uint160', name: 'limitSqrtPrice', type: 'uint160' }
        ],
        name: 'quoteExactInputSingle',
        outputs: [
            { internalType: 'uint256', name: 'amountOut', type: 'uint256' },
            { internalType: 'uint16', name: 'fee', type: 'uint16' }
        ],
        stateMutability: 'view',
        type: 'function'
    },
    {
        inputs: [
            { internalType: 'address', name: 'tokenIn', type: 'address' },
            { internalType: 'address', name: 'tokenOut', type: 'address' },
            { internalType: 'uint256', name: 'amountOut', type: 'uint256' },
            { internalType: 'uint160', name: 'limitSqrtPrice', type: 'uint160' }
        ],
        name: 'quoteExactOutputSingle',
        outputs: [
            { internalType: 'uint256', name: 'amountIn', type: 'uint256' },
            { internalType: 'uint16', name: 'fee', type: 'uint16' }
        ],
        stateMutability: 'view',
        type: 'function'
    },
    {
        inputs: [
            { internalType: 'bytes', name: 'path', type: 'bytes' },
            { internalType: 'uint256', name: 'amountIn', type: 'uint256' }
        ],
        name: 'quoteExactInput',
        outputs: [
            { internalType: 'uint256', name: 'amountOut', type: 'uint256' },
            { internalType: 'uint16[]', name: 'fees', type: 'uint16[]' }
        ],
        stateMutability: 'view',
        type: 'function'
    }
];

/**
 * QuickSwap Algebra V3 Router ABI
 * Key difference: No fee parameter in ExactInputSingleParams - dynamic fees
 */
export const IAlgebraV3RouterABI = [
    {
        inputs: [
            {
                components: [
                    { internalType: 'address', name: 'tokenIn', type: 'address' },
                    { internalType: 'address', name: 'tokenOut', type: 'address' },
                    { internalType: 'address', name: 'recipient', type: 'address' },
                    { internalType: 'uint256', name: 'deadline', type: 'uint256' },
                    { internalType: 'uint256', name: 'amountIn', type: 'uint256' },
                    { internalType: 'uint256', name: 'amountOutMinimum', type: 'uint256' },
                    { internalType: 'uint160', name: 'limitSqrtPrice', type: 'uint160' }
                ],
                internalType: 'struct ISwapRouter.ExactInputSingleParams',
                name: 'params',
                type: 'tuple'
            }
        ],
        name: 'exactInputSingle',
        outputs: [{ internalType: 'uint256', name: 'amountOut', type: 'uint256' }],
        stateMutability: 'payable',
        type: 'function'
    },
    {
        inputs: [
            {
                components: [
                    { internalType: 'address', name: 'tokenIn', type: 'address' },
                    { internalType: 'address', name: 'tokenOut', type: 'address' },
                    { internalType: 'uint24', name: 'fee', type: 'uint24' },
                    { internalType: 'address', name: 'recipient', type: 'address' },
                    { internalType: 'uint256', name: 'deadline', type: 'uint256' },
                    { internalType: 'uint256', name: 'amountOut', type: 'uint256' },
                    { internalType: 'uint256', name: 'amountInMaximum', type: 'uint256' },
                    { internalType: 'uint160', name: 'limitSqrtPrice', type: 'uint160' }
                ],
                internalType: 'struct ISwapRouter.ExactOutputSingleParams',
                name: 'params',
                type: 'tuple'
            }
        ],
        name: 'exactOutputSingle',
        outputs: [{ internalType: 'uint256', name: 'amountIn', type: 'uint256' }],
        stateMutability: 'payable',
        type: 'function'
    }
]; 