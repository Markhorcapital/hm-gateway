import { getAvailableEthereumNetworks } from '../../chains/ethereum/ethereum.utils';
import { AvailableNetworks } from '../../services/base';
import { ConfigManagerV2 } from '../../services/config-manager-v2';

export namespace AerodromeConfig {
  // Supported networks for Aerodrome
  // Aerodrome is primarily on Base network
  export const chain = 'ethereum';
  export const networks = getAvailableEthereumNetworks().filter((network) => ['base'].includes(network));
  export type Network = string;

  // Supported trading types
  export const tradingTypes = ['clmm'] as const;

  export interface RootConfig {
    // Global configuration
    slippagePct: number;
    maximumHops: number;

    // Available networks
    availableNetworks: Array<AvailableNetworks>;
  }

  export const config: RootConfig = {
    slippagePct: ConfigManagerV2.getInstance().get('aerodrome.slippagePct') || 0.5,
    maximumHops: ConfigManagerV2.getInstance().get('aerodrome.maximumHops') || 4,

    availableNetworks: [
      {
        chain,
        networks: networks,
      },
    ],
  };
}
