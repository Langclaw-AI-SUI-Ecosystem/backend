export type ProductChainId = "sui-testnet" | "sui-mainnet";

export type ProductChainConfig = {
  aliases: string[];
  alchemyNetwork?: string;
  billingCurrency: {
    decimals: number;
    feeCurrencyAddress?: `0x${string}`;
    name: string;
    symbol: string;
    tokenAddress?: `0x${string}`;
  };
  chainId: number;
  dexScreenerId: string;
  envPrefix: "SUI";
  erc8004?: {
    identityRegistryAddress?: `0x${string}`;
    reputationRegistryAddress?: `0x${string}`;
    selfAgentRegistryAddress?: `0x${string}`;
    selfHumanProofProviderAddress?: `0x${string}`;
    selfReputationRegistryAddress?: `0x${string}`;
    selfValidationRegistryAddress?: `0x${string}`;
  };
  explorerUrl: string;
  etherscanId?: number;
  goPlusId?: number;
  id: ProductChainId;
  name: string;
  nativeCurrency: {
    decimals: number;
    name: string;
    symbol: string;
  };
  /**
   * Sui RPC fullnode network slug ("testnet" | "mainnet"). Mirrors the network
   * tag used by the frontend `@mysten/dapp-kit` config and `sui-registry.ts`.
   */
  suiNetwork: "testnet" | "mainnet";
  proofSignalFallback: string;
  rpcUrl: string;
};

export const productChainIds = ["sui-mainnet", "sui-testnet"] as const;

export const productChains: Record<ProductChainId, ProductChainConfig> = {
  "sui-testnet": {
    aliases: ["sui testnet", "sui-testnet"],
    billingCurrency: {
      decimals: 9,
      name: "Sui",
      symbol: "SUI",
    },
    // Sui has no EVM-style numeric chain id. We keep a stable numeric tag so the
    // (ported) usage ledger / UI selectors that key on a number keep working.
    // Matches the frontend `frontend/lib/chains.ts` tags (testnet 1 / mainnet 0).
    chainId: 1,
    dexScreenerId: "sui",
    envPrefix: "SUI",
    explorerUrl: "https://testnet.suivision.xyz",
    id: "sui-testnet",
    name: "Sui Testnet",
    nativeCurrency: {
      decimals: 9,
      name: "Sui",
      symbol: "SUI",
    },
    suiNetwork: "testnet",
    proofSignalFallback: "sui-alpha",
    rpcUrl: "https://fullnode.testnet.sui.io:443",
  },
  "sui-mainnet": {
    aliases: ["sui mainnet", "sui-mainnet"],
    billingCurrency: {
      decimals: 9,
      name: "Sui",
      symbol: "SUI",
    },
    chainId: 0,
    dexScreenerId: "sui",
    envPrefix: "SUI",
    explorerUrl: "https://suivision.xyz",
    id: "sui-mainnet",
    name: "Sui Mainnet",
    nativeCurrency: {
      decimals: 9,
      name: "Sui",
      symbol: "SUI",
    },
    suiNetwork: "mainnet",
    proofSignalFallback: "sui-alpha",
    rpcUrl: "https://fullnode.mainnet.sui.io:443",
  },
};

export const defaultProductChain: ProductChainId = "sui-mainnet";

export function isProductChainId(value: unknown): value is ProductChainId {
  return typeof value === "string" && value in productChains;
}

export function resolveProductChain(
  input: unknown,
  fallback: ProductChainId = defaultProductChain
): ProductChainConfig {
  const normalized = typeof input === "string" ? input.trim().toLowerCase() : "";

  if (isProductChainId(normalized)) {
    return productChains[normalized];
  }

  for (const chain of Object.values(productChains)) {
    if (chain.aliases.includes(normalized)) {
      return chain;
    }
  }

  return productChains[fallback];
}

export function getProductChain(id: ProductChainId) {
  return productChains[id];
}

export function readProductChainId(
  input: unknown,
  fallback: ProductChainId = defaultProductChain
): ProductChainId {
  return resolveProductChain(input, fallback).id;
}

export function envKeyForChain(
  chain: ProductChainConfig,
  suffix: string
) {
  return `${chain.envPrefix}_${suffix}`;
}

export function readChainEnv(
  chain: ProductChainConfig,
  suffix: string,
  fallback?: string
) {
  const value = process.env[envKeyForChain(chain, suffix)]?.trim();

  if (value) {
    return value;
  }

  const bridged = readSuiEnvBridge(suffix);

  if (bridged) {
    return bridged;
  }

  return fallback;
}

/**
 * The Sui stack already ships a few un-prefixed env vars (e.g. `SUI_RPC_URL`
 * consumed by `sui-registry.ts` / `seal.ts`). Bridge them so the product-chain
 * helpers that ask for `SUI_CHAIN_RPC_URL` keep working without duplicate config.
 */
function readSuiEnvBridge(suffix: string) {
  if (suffix === "CHAIN_RPC_URL" || suffix === "RPC_URL") {
    return process.env.SUI_RPC_URL?.trim();
  }

  return undefined;
}
