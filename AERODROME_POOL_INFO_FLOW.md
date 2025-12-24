# Aerodrome Pool Info and Address Flow

## Overview
This document explains where pool information and addresses are fetched from in the Aerodrome connector.

## Pool Address Sources

### 1. **User-Provided Pool Addresses** (Primary Source)
When adding a pool via `POST /pools` API:
- **User must provide**: Pool contract address (e.g., `0x1234...`)
- **Where to find**: 
  - Aerodrome website: https://aerodrome.finance
  - Base blockchain explorers (Basescan)
  - Aerodrome factory contract queries
  - DEX aggregators showing pool addresses

### 2. **Stored Pool Addresses** (Secondary Source)
Once added, pools are stored in:
- **File**: `gateway/conf/pools/aerodrome.json`
- **Format**: JSON array of pool objects
- **Example**:
```json
[
  {
    "type": "clmm",
    "network": "base",
    "baseSymbol": "WETH",
    "quoteSymbol": "USDC",
    "baseTokenAddress": "0x4200000000000000000000000000000000000006",
    "quoteTokenAddress": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "feePct": 0.05,
    "address": "0x<POOL_ADDRESS>"
  }
]
```

## Pool Info Fetching (On-Chain)

### When Adding a Pool via API
The system fetches pool info **on-chain** from the pool contract:

**Location**: `gateway/src/pools/pool-info-helpers.ts` (lines 105-139)

**Process**:
1. User provides pool address
2. System creates a contract instance using the pool address
3. Calls contract methods to fetch:
   - `token0()` → First token address
   - `token1()` → Second token address  
   - `fee()` → Fee in basis points (converted to percentage)

**Code Flow**:
```typescript
// 1. Create contract instance
const poolContract = new Contract(poolAddress, IUniswapV3PoolABI, ethereum.provider);

// 2. Fetch on-chain data
const [token0, token1, fee] = await Promise.all([
  poolContract.token0(),  // On-chain call
  poolContract.token1(),   // On-chain call
  poolContract.fee(),      // On-chain call
]);

// 3. Convert fee from basis points to percentage
const feePct = fee / 10000;
```

### When Looking Up Existing Pools
**Location**: `gateway/src/services/pool-service.ts`

**Process**:
1. Reads from `conf/pools/aerodrome.json` file
2. Searches for matching token pair (baseSymbol-quoteSymbol)
3. Returns stored pool address

**Code Flow**:
```typescript
// 1. Load pools from JSON file
const pools = await this.loadPoolList('aerodrome'); // Reads aerodrome.json

// 2. Find pool by token symbols
const pool = pools.find(
  (p) =>
    (p.baseSymbol === baseSymbol && p.quoteSymbol === quoteSymbol) ||
    (p.baseSymbol === quoteSymbol && p.quoteSymbol === baseSymbol)
);
```

## Token Symbol Resolution

**Location**: `gateway/src/pools/pool-info-helpers.ts` (lines 157-183)

**Process**:
1. Uses token addresses to look up symbols
2. Queries Ethereum chain's token registry
3. Returns token symbols (e.g., "WETH", "USDC")

**Code Flow**:
```typescript
// 1. Get Ethereum instance
const chain = await Ethereum.getInstance(network);

// 2. Get token info from chain's token registry
const baseToken = await chain.getToken(baseTokenAddress);  // On-chain call
const quoteToken = await chain.getToken(quoteTokenAddress); // On-chain call

// 3. Return symbols
return {
  baseSymbol: baseToken.symbol,   // e.g., "WETH"
  quoteSymbol: quoteToken.symbol, // e.g., "USDC"
};
```

## Complete Flow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    Adding a Pool (API)                       │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
        ┌───────────────────────────────────┐
        │  User provides: pool address      │
        │  + token addresses (optional)      │
        └───────────────────────────────────┘
                            │
                            ▼
        ┌───────────────────────────────────┐
        │  fetchPoolInfo()                  │
        │  - Reads pool contract on-chain   │
        │  - Gets: token0, token1, fee       │
        └───────────────────────────────────┘
                            │
                            ▼
        ┌───────────────────────────────────┐
        │  resolveTokenSymbols()            │
        │  - Queries Ethereum token registry│
        │  - Gets: "WETH", "USDC"           │
        └───────────────────────────────────┘
                            │
                            ▼
        ┌───────────────────────────────────┐
        │  Save to aerodrome.json           │
        │  (conf/pools/aerodrome.json)      │
        └───────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│              Looking Up a Pool (Swap Request)               │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
        ┌───────────────────────────────────┐
        │  findDefaultPool()                │
        │  - Called with: "WETH", "USDC"    │
        └───────────────────────────────────┘
                            │
                            ▼
        ┌───────────────────────────────────┐
        │  PoolService.getPool()            │
        │  - Reads aerodrome.json file      │
        │  - Searches by token symbols      │
        └───────────────────────────────────┘
                            │
                            ▼
        ┌───────────────────────────────────┐
        │  Returns: pool address            │
        │  (e.g., "0x1234...")              │
        └───────────────────────────────────┘
```

## Key Points

1. **Pool addresses are NOT auto-discovered** - They must be:
   - Provided by user when adding pools
   - Found from external sources (Aerodrome website, explorers)

2. **Pool info is fetched on-chain** - When adding a pool:
   - Token addresses come from pool contract (`token0()`, `token1()`)
   - Fee comes from pool contract (`fee()`)

3. **Token symbols are resolved from chain** - Using Ethereum's token registry

4. **Stored pools are looked up from file** - `conf/pools/aerodrome.json`

5. **No factory contract queries** - Currently, Aerodrome doesn't query the factory to find pools automatically. Pool addresses must be known beforehand.

## Finding Pool Addresses

To find Aerodrome pool addresses:

1. **Aerodrome Website**:
   - Visit https://aerodrome.finance
   - Navigate to pools
   - Click on a pool (e.g., WETH/USDC)
   - View pool contract address

2. **Base Explorer**:
   - Visit https://basescan.org
   - Search for Aerodrome factory contract
   - Query `getPool(token0, token1, tickSpacing)`

3. **Aerodrome Factory Contract**:
   - Address: `0x420DD381b31aEf6683db6B902084cB0FFECe40Da` (Base)
   - Call `getPool(token0, token1, tickSpacing)` to get pool address

## Current Limitations

- **No automatic pool discovery** - Must manually add pool addresses
- **Factory queries not implemented** - Cannot automatically find pools by token pair
- **Requires known pool addresses** - User must provide pool address when adding

