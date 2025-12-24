import { getAvailableEthereumNetworks } from '../../chains/ethereum/ethereum.utils';
import { AvailableNetworks } from '../../services/base';
import { ConfigManagerV2 } from '../../services/config-manager-v2';

export namespace QuickSwapConfig {
  // Supported networks for QuickSwap
  // See https://docs.quickswap.exchange/overview/contracts-and-addresses
  export const chain = 'ethereum';
  export const networks = getAvailableEthereumNetworks().filter((network) =>
    ['polygon', 'mumbai', 'dogechain', 'manta'].includes(network),
  );
  export type Network = string;

  // Supported trading types
  export const tradingTypes = ['amm', 'clmm'] as const;

  export interface RootConfig {
    // Global configuration
    slippagePct: number;
    maximumHops: number;

    // Available networks
    availableNetworks: Array<AvailableNetworks>;
  }

  export const config: RootConfig = {
    slippagePct: ConfigManagerV2.getInstance().get('quickswap.slippagePct') || 0.5,
    maximumHops: ConfigManagerV2.getInstance().get('quickswap.maximumHops') || 4,

    availableNetworks: [
      {
        chain,
        networks: networks,
      },
    ],
  };
}
