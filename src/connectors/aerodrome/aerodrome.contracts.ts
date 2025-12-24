/**
 * Aerodrome V3 contract addresses and ABIs
 * Aerodrome is a Uniswap V3 fork on Base network with tickSpacing instead of fee
 */

export interface AerodromeContractAddresses {
  // V3 contracts
  aerodromeV3SwapRouterAddress: string;
  aerodromeV3QuoterAddress: string;
  aerodromeV3FactoryAddress: string;
}

export interface NetworkContractAddresses {
  [network: string]: AerodromeContractAddresses;
}

export const contractAddresses: NetworkContractAddresses = {
  base: {
    aerodromeV3SwapRouterAddress: '0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5',
    aerodromeV3QuoterAddress: '0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0',
    aerodromeV3FactoryAddress: '0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A', // Standard V3 factory address on Base
  },
};

/**
 * Helper functions to get contract addresses
 */
export function getAerodromeV3SwapRouterAddress(network: string): string {
  const address = contractAddresses[network]?.aerodromeV3SwapRouterAddress;

  if (!address) {
    throw new Error(`Aerodrome V3 Swap Router address not configured for network: ${network}`);
  }

  return address;
}

export function getAerodromeV3QuoterAddress(network: string): string {
  const address = contractAddresses[network]?.aerodromeV3QuoterAddress;

  if (!address) {
    throw new Error(`Aerodrome V3 Quoter address not configured for network: ${network}`);
  }

  return address;
}

export function getAerodromeV3FactoryAddress(network: string): string {
  console.log('getAerodromeV3FactoryAddress', network);
  const address = contractAddresses[network]?.aerodromeV3FactoryAddress;
  console.log('address', address);

  if (!address) {
    throw new Error(`Aerodrome V3 Factory address not configured for network: ${network}`);
  }

  return address;
}

/**
 * Aerodrome V3 Quoter ABI - uses tickSpacing instead of fee
 * Uses struct parameters as per actual Aerodrome contract
 * Based on quoterAbi.json
 */
export const IAerodromeQuoterABI = [
  {
    inputs: [
      {
        components: [
          { internalType: 'address', name: 'tokenIn', type: 'address' },
          { internalType: 'address', name: 'tokenOut', type: 'address' },
          { internalType: 'uint256', name: 'amountIn', type: 'uint256' },
          { internalType: 'int24', name: 'tickSpacing', type: 'int24' },
          { internalType: 'uint160', name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
        internalType: 'struct IQuoterV2.QuoteExactInputSingleParams',
        name: 'params',
        type: 'tuple',
      },
    ],
    name: 'quoteExactInputSingle',
    outputs: [
      { internalType: 'uint256', name: 'amountOut', type: 'uint256' },
      { internalType: 'uint160', name: 'sqrtPriceX96After', type: 'uint160' },
      {
        internalType: 'uint32',
        name: 'initializedTicksCrossed',
        type: 'uint32',
      },
      { internalType: 'uint256', name: 'gasEstimate', type: 'uint256' },
    ],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        components: [
          { internalType: 'address', name: 'tokenIn', type: 'address' },
          { internalType: 'address', name: 'tokenOut', type: 'address' },
          { internalType: 'uint256', name: 'amount', type: 'uint256' },
          { internalType: 'int24', name: 'tickSpacing', type: 'int24' },
          { internalType: 'uint160', name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
        internalType: 'struct IQuoterV2.QuoteExactOutputSingleParams',
        name: 'params',
        type: 'tuple',
      },
    ],
    name: 'quoteExactOutputSingle',
    outputs: [
      { internalType: 'uint256', name: 'amountIn', type: 'uint256' },
      { internalType: 'uint160', name: 'sqrtPriceX96After', type: 'uint160' },
      {
        internalType: 'uint32',
        name: 'initializedTicksCrossed',
        type: 'uint32',
      },
      { internalType: 'uint256', name: 'gasEstimate', type: 'uint256' },
    ],
    stateMutability: 'nonpayable',
    type: 'function',
  },
];

/**
 * Aerodrome V3 SwapRouter ABI - uses tickSpacing instead of fee
 * Uses struct parameters as per actual Aerodrome contract
 * Based on routerAbi.json
 */
export const IAerodromeSwapRouterABI = [
  {
    inputs: [
      {
        components: [
          { internalType: 'address', name: 'tokenIn', type: 'address' },
          { internalType: 'address', name: 'tokenOut', type: 'address' },
          { internalType: 'int24', name: 'tickSpacing', type: 'int24' },
          { internalType: 'address', name: 'recipient', type: 'address' },
          { internalType: 'uint256', name: 'deadline', type: 'uint256' },
          { internalType: 'uint256', name: 'amountIn', type: 'uint256' },
          {
            internalType: 'uint256',
            name: 'amountOutMinimum',
            type: 'uint256',
          },
          {
            internalType: 'uint160',
            name: 'sqrtPriceLimitX96',
            type: 'uint160',
          },
        ],
        internalType: 'struct ISwapRouter.ExactInputSingleParams',
        name: 'params',
        type: 'tuple',
      },
    ],
    name: 'exactInputSingle',
    outputs: [{ internalType: 'uint256', name: 'amountOut', type: 'uint256' }],
    stateMutability: 'payable',
    type: 'function',
  },
  {
    inputs: [
      {
        components: [
          { internalType: 'address', name: 'tokenIn', type: 'address' },
          { internalType: 'address', name: 'tokenOut', type: 'address' },
          { internalType: 'int24', name: 'tickSpacing', type: 'int24' },
          { internalType: 'address', name: 'recipient', type: 'address' },
          { internalType: 'uint256', name: 'deadline', type: 'uint256' },
          { internalType: 'uint256', name: 'amountOut', type: 'uint256' },
          { internalType: 'uint256', name: 'amountInMaximum', type: 'uint256' },
          {
            internalType: 'uint160',
            name: 'sqrtPriceLimitX96',
            type: 'uint160',
          },
        ],
        internalType: 'struct ISwapRouter.ExactOutputSingleParams',
        name: 'params',
        type: 'tuple',
      },
    ],
    name: 'exactOutputSingle',
    outputs: [{ internalType: 'uint256', name: 'amountIn', type: 'uint256' }],
    stateMutability: 'payable',
    type: 'function',
  },
];

// Aerodrome V3 Pool ABI - Different from Uniswap V3
// Aerodrome's slot0() returns 6 values instead of Uniswap's 2
export const IAerodromeV3PoolABI = [
  {
    inputs: [],
    name: 'slot0',
    outputs: [
      { internalType: 'uint160', name: 'sqrtPriceX96', type: 'uint160' },
      { internalType: 'int24', name: 'tick', type: 'int24' },
      { internalType: 'uint16', name: 'observationIndex', type: 'uint16' },
      { internalType: 'uint16', name: 'observationCardinality', type: 'uint16' },
      { internalType: 'uint16', name: 'observationCardinalityNext', type: 'uint16' },
      { internalType: 'bool', name: 'unlocked', type: 'bool' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'liquidity',
    outputs: [{ internalType: 'uint128', name: '', type: 'uint128' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'tickSpacing',
    outputs: [{ internalType: 'int24', name: '', type: 'int24' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'fee',
    outputs: [{ internalType: 'uint24', name: '', type: 'uint24' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'token0',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'token1',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
];

// Re-export Uniswap V3 Factory ABI (same as Uniswap)
export { abi as IUniswapV3FactoryABI } from '@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Factory.sol/IUniswapV3Factory.json';
