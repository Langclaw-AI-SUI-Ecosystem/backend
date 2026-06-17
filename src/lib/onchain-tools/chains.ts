import { resolveProductChain } from "../chain-config";

type ChainConfig = {
  aliases: string[];
  alchemyNetwork?: string;
  chainId?: number;
  dexScreenerId: string;
  etherscanId?: number;
  goPlusId?: number;
  name: string;
  nativeSymbol?: string;
  product?: boolean;
};

export type ResolvedChainConfig = ChainConfig & {
  id: string;
};

export type AnalysisChainSource = "product-fallback" | "prompt";

export type UnsupportedChainHint = {
  id: string;
  name: string;
};

export type AnalysisChainResolution = {
  chain: ResolvedChainConfig;
  source: AnalysisChainSource;
  unsupportedChain?: UnsupportedChainHint;
};

// Analysis-registry default, keyed by the bare analysis id ("sui") — not the
// product chain id ("sui-testnet"/"sui-mainnet").
export const defaultChain = "sui";

const chains: Record<string, ChainConfig> = {
  arbitrum: {
    aliases: ["arb", "arbitrum one"],
    alchemyNetwork: "arb-mainnet",
    dexScreenerId: "arbitrum",
    etherscanId: 42161,
    goPlusId: 42161,
    name: "Arbitrum",
  },
  avalanche: {
    aliases: ["avax", "avalanche c-chain"],
    alchemyNetwork: "avax-mainnet",
    dexScreenerId: "avalanche",
    etherscanId: 43114,
    goPlusId: 43114,
    name: "Avalanche",
  },
  base: {
    aliases: ["base mainnet"],
    alchemyNetwork: "base-mainnet",
    dexScreenerId: "base",
    etherscanId: 8453,
    goPlusId: 8453,
    name: "Base",
  },
  bnb: {
    aliases: ["bsc", "binance", "binance smart chain"],
    dexScreenerId: "bsc",
    etherscanId: 56,
    goPlusId: 56,
    name: "BNB Smart Chain",
  },
  ethereum: {
    aliases: ["eth", "ethereum mainnet"],
    alchemyNetwork: "eth-mainnet",
    dexScreenerId: "ethereum",
    etherscanId: 1,
    goPlusId: 1,
    name: "Ethereum",
  },
  sui: {
    aliases: ["sui-testnet", "sui-mainnet", "sui mainnet", "sui testnet"],
    dexScreenerId: "sui",
    name: "Sui",
    nativeSymbol: "SUI",
    product: true,
    // No etherscanId / alchemyNetwork / goPlusId: the EVM-only providers
    // auto-gate off for Sui via isProviderSupportedForChain.
  },
  // Celo and Mantle are kept as plain EVM *analysis* chains (the agent can still
  // research them); they are no longer product chains — billing/proof/identity
  // live on Sui only.
  mantle: {
    aliases: ["mnt", "mantle mainnet", "mantle network"],
    alchemyNetwork: "mantle-mainnet",
    chainId: 5000,
    dexScreenerId: "mantle",
    etherscanId: 5000,
    goPlusId: 5000,
    name: "Mantle",
    nativeSymbol: "MNT",
  },
  celo: {
    aliases: ["cello", "celo mainnet", "celo network", "minipay"],
    alchemyNetwork: "celo-mainnet",
    chainId: 42220,
    dexScreenerId: "celo",
    etherscanId: 42220,
    name: "Celo",
    nativeSymbol: "CELO",
  },
  optimism: {
    aliases: ["op", "optimistic ethereum"],
    alchemyNetwork: "opt-mainnet",
    dexScreenerId: "optimism",
    etherscanId: 10,
    goPlusId: 10,
    name: "Optimism",
  },
  polygon: {
    aliases: ["matic", "polygon pos"],
    alchemyNetwork: "polygon-mainnet",
    dexScreenerId: "polygon",
    etherscanId: 137,
    goPlusId: 137,
    name: "Polygon",
  },
  solana: {
    aliases: ["sol"],
    dexScreenerId: "solana",
    etherscanId: 1,
    goPlusId: 501,
    name: "Solana",
  },
};

const knownUnsupportedChains: Record<string, string> = {
  aptos: "Aptos",
  berachain: "Berachain",
  monad: "Monad",
  near: "NEAR",
  sei: "Sei",
};

export function resolveChain(input: string | undefined): ResolvedChainConfig {
  const normalized = input?.trim().toLowerCase() || defaultChain;

  for (const [key, value] of Object.entries(chains)) {
    if (key === normalized || value.aliases.includes(normalized)) {
      return {
        id: key,
        ...value,
      };
    }
  }

  return {
    id: defaultChain,
    ...chains[defaultChain],
  };
}

export function detectChain(text: string) {
  return detectChainWithFallback(text, defaultChain);
}

export function detectChainWithFallback(
  text: string,
  fallback: string | undefined
) {
  return inferAnalysisChain(text, fallback).chain;
}

export function detectUnsupportedOnChainChain(text: string) {
  return inferAnalysisChain(text, defaultChain).unsupportedChain ?? null;
}

export function isSupportedProductChain(chain: string) {
  return resolveChain(chain).product === true;
}

export function inferAnalysisChain(
  text: string,
  fallback: string | undefined
): AnalysisChainResolution {
  const resolvedFallback = resolveProductChain(fallback).id;
  const explicitChain = detectExplicitChain(text);

  if (explicitChain) {
    return {
      chain: explicitChain,
      source: "prompt",
    };
  }

  return {
    chain: resolveChain(resolvedFallback),
    source: "product-fallback",
    unsupportedChain: detectPotentialUnsupportedChain(text),
  };
}

export function isProviderSupportedForChain(
  chain: string,
  provider: string
) {
  const resolved = resolveChain(chain);
  const isSui = resolved.id === "sui";

  // EVM-only providers -> honest gaps on Sui.
  if (provider === "surf") {
    return !isSui;
  }

  // The generic Dune smart-money SQL uses EVM spellbooks
  // (dex.trades / cex.flows / labels.addresses), so it stays off for Sui.
  // The Sui-specific dune.sui_accumulation_flow executor bypasses this gate.
  if (provider === "dune") {
    return !isSui;
  }

  if (provider === "nansen") {
    // Nansen smart-money coverage in this workflow is Mantle-only; no Sui coverage.
    return resolved.id === "mantle";
  }

  if (provider === "etherscan") {
    return Boolean(resolved.etherscanId);
  }

  if (provider === "alchemy") {
    return Boolean(resolved.alchemyNetwork);
  }

  if (provider === "goplus") {
    return Boolean(resolved.goPlusId);
  }

  if (provider === "elfa") {
    return resolved.product === true;
  }

  // BlockVision is a Sui-native indexer -> supported only on Sui.
  if (provider === "blockvision") {
    return isSui;
  }

  // dexscreener, coingecko, defillama, geckoterminal -> Sui + EVM.
  return true;
}

export function getAlchemyNetwork(chain: string) {
  return resolveChain(chain).alchemyNetwork;
}

export function getDexScreenerChainId(chain: string) {
  return resolveChain(chain).dexScreenerId;
}

export function getEtherscanChainId(chain: string) {
  return resolveChain(chain).etherscanId;
}

export function getGoPlusChainId(chain: string) {
  const id = resolveChain(chain).goPlusId;

  if (!id) {
    throw new Error(`GoPlus is not configured for ${chain}.`);
  }

  return id;
}

export function getChainLookupTerms(chain: string) {
  const resolved = resolveChain(chain);

  return [resolved.id, resolved.name, ...resolved.aliases]
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function detectExplicitChain(text: string) {
  const normalized = text.toLowerCase();
  const candidates: Array<{ id: string; index: number; term: string }> = [];

  for (const [key, value] of Object.entries(chains)) {
    const keyMatch = matchChainTerm(normalized, key);

    if (keyMatch && !isNegatedChainMention(normalized, keyMatch.index)) {
      candidates.push({
        id: key,
        index: keyMatch.index,
        term: key,
      });
    }
  }

  for (const [key, value] of Object.entries(chains)) {
    for (const alias of value.aliases) {
      const aliasMatch = matchChainTerm(normalized, alias);

      if (aliasMatch && !isNegatedChainMention(normalized, aliasMatch.index)) {
        candidates.push({
          id: key,
          index: aliasMatch.index,
          term: alias,
        });
      }
    }
  }

  const earliest = candidates.sort((left, right) => {
    if (left.index !== right.index) {
      return left.index - right.index;
    }

    return right.term.length - left.term.length;
  })[0];

  return earliest ? resolveChain(earliest.id) : undefined;
}

function matchChainTerm(text: string, term: string) {
  const match = new RegExp(`\\b${escapeRegExp(term)}\\b`, "i").exec(text);

  return match ? { index: match.index } : undefined;
}

function isNegatedChainMention(text: string, index: number) {
  const lookback = text.slice(Math.max(0, index - 42), index);

  return /(?:\bdo\s+not|\bdon't|\bdont|\bnever|\bwithout|\bexclude|\bexcluding|\bavoid|\bignore|\bnot|\bno)\s+(?:use\s+|using\s+|include\s+|including\s+|route\s+to\s+|fallback\s+to\s+|from\s+|on\s+|the\s+)?$/i.test(
    lookback
  );
}

function detectPotentialUnsupportedChain(
  text: string
): UnsupportedChainHint | undefined {
  const named = detectNamedUnsupportedChain(text);

  if (named) {
    return named;
  }

  const patterns = [
    /\bon\s+([a-z][a-z0-9\s-]{1,30}?)\s+(?:dex|pairs?|pools?|tokens?|protocols?|chain|network)\b/i,
    /\b([a-z][a-z0-9\s-]{1,30}?)\s+(?:chain|network)\b/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const candidate = normalizeUnsupportedChainCandidate(match?.[1]);

    if (!candidate || isKnownChain(candidate)) {
      continue;
    }

    return {
      id: candidate.replace(/\s+/g, "-"),
      name: toTitleCase(candidate),
    };
  }

  return undefined;
}

function detectNamedUnsupportedChain(text: string) {
  for (const [id, name] of Object.entries(knownUnsupportedChains)) {
    const term = escapeRegExp(id);
    const relationPattern = new RegExp(
      `\\b(?:on|for|from|in|into)\\s+${term}(?:\\s+(?:chain|network|mainnet))?\\b`,
      "i"
    );
    const chainPattern = new RegExp(
      `\\b${term}\\s+(?:chain|network|mainnet)\\b`,
      "i"
    );

    if (relationPattern.test(text) || chainPattern.test(text)) {
      return {
        id,
        name,
      };
    }
  }

  return undefined;
}

function isKnownChain(candidate: string) {
  const normalized = candidate.trim().toLowerCase();

  return Object.entries(chains).some(
    ([key, value]) => key === normalized || value.aliases.includes(normalized)
  );
}

function normalizeUnsupportedChainCandidate(value: string | undefined) {
  const candidate = value?.trim().toLowerCase().replace(/\s+/g, " ");

  if (!candidate) {
    return undefined;
  }

  if (candidate.split(" ").length > 3) {
    return undefined;
  }

  const stopwords = new Set([
    "a",
    "all",
    "alpha",
    "current",
    "dex",
    "latest",
    "selected",
    "supported",
    "that",
    "the",
    "this",
    "tokens",
    "without",
  ]);

  if (stopwords.has(candidate)) {
    return undefined;
  }

  return candidate;
}

function toTitleCase(value: string) {
  return value
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}
