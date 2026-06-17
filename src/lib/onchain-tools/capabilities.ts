import { readPremiumProviderConfig } from "../premium-providers";
import {
  getAlchemyNetwork,
  getGoPlusChainId,
  isProviderSupportedForChain,
  resolveChain,
} from "./chains";
import { getSurfSmartMoneyCoverage } from "./providers/surf";
import type {
  ChainCapabilityProvider,
  ChainCapabilityStatus,
  ChainResearchCapabilities,
  ChainSmartMoneyCapability,
  OnChainDomain,
} from "./types";

type ChainResearchCapabilityInput = {
  chain: string;
  domains: OnChainDomain[];
  intent: string;
  query?: string;
  rawQuery?: string;
  tokenAddress?: string;
};

export function buildChainResearchCapabilities({
  chain,
  domains,
  intent,
  query,
  rawQuery,
  tokenAddress,
}: ChainResearchCapabilityInput): ChainResearchCapabilities {
  const resolved = resolveChain(chain);
  const smartMoney = buildSmartMoneyCapability({
    chain: resolved.id,
    intent,
    query: rawQuery ?? query,
    tokenAddress,
  });
  const marketData = buildMarketDataCapability(resolved.id);
  const security = buildSecurityCapability(resolved.id);
  const structuredOnChain = combineStatus([
    smartMoney.status,
    marketData.status,
    security.status,
  ]);
  const notes = buildCapabilityNotes({
    domains,
    marketDataStatus: marketData.status,
    securityStatus: security.status,
    smartMoney,
  });

  return {
    chain: resolved.id,
    chainName: resolved.name,
    marketData,
    notes,
    security,
    smartMoney,
    structuredOnChain,
  };
}

function buildSmartMoneyCapability({
  chain,
  intent,
  query,
  tokenAddress,
}: {
  chain: string;
  intent: string;
  query?: string;
  tokenAddress?: string;
}): ChainSmartMoneyCapability {
  const surfCoverage = getSurfSmartMoneyCoverage({
    chain,
    query,
    tokenAddress,
  });
  const surfEnabled = readPremiumProviderConfig("surf").enabled;
  const nansenSupported = isProviderSupportedForChain(chain, "nansen");
  const nansenEnabled = readPremiumProviderConfig("nansen").enabled;
  const duneConfigured = Boolean(process.env.DUNE_API_KEY?.trim());
  const isSui = chain === "sui";
  const providers: ChainCapabilityProvider[] = [
    providerCapability({
      configured: surfEnabled,
      coverage: surfCoverage.hasSqlFallback
        ? `Surf skill ability plus SQL fallback on ${surfCoverage.chainName}${
            surfCoverage.symbol ? ` for ${surfCoverage.symbol}` : ""
          }.`
        : "Surf skill ability can attempt dynamic smart-money research, but no SQL DEX trade table fallback is mapped for this chain.",
      provider: "surf",
      status: surfEnabled
        ? surfCoverage.hasSqlFallback
          ? "available"
          : "partial"
        : "partial",
    }),
    providerCapability({
      configured: duneConfigured,
      coverage: isSui
        ? "Dune can rank Sui DEX accumulation rows through dex_sui.trades, with sui.events Cetus swap fallback when spellbook rows are unavailable."
        : "Dune can execute generated smart-money DEX and CEX flow SQL from safe chain, token, timeframe, and threshold parameters.",
      provider: "dune",
      status: duneConfigured ? "available" : "unavailable",
    }),
    ...(nansenSupported
      ? [
          providerCapability({
            configured: nansenEnabled,
            coverage:
              "Nansen direct smart-money netflow is available only for Mantle scope in this workflow.",
            provider: "nansen",
            status: nansenEnabled ? "available" : "partial",
          }),
        ]
      : []),
  ];
  const availableProviders = providers.filter(
    (provider) => provider.status === "available"
  );
  const partialProviders = providers.filter(
    (provider) => provider.status === "partial"
  );
  const limitations = buildSmartMoneyLimitations({
    intent,
    nansenSupported,
    providers,
    surfEnabled,
    surfHasSql: surfCoverage.hasSqlFallback,
  });
  const status: ChainCapabilityStatus = availableProviders.length
    ? "available"
    : partialProviders.length
      ? "partial"
      : "unavailable";
  const mode = status === "available"
    ? "candidate-ranking"
    : surfEnabled
      ? "dynamic-ability"
      : partialProviders.length
        ? "directional-only"
        : "coverage-gap";

  return {
    limitations,
    mode,
    providers,
    status,
  };
}

function buildMarketDataCapability(chain: string) {
  const providers: ChainCapabilityProvider[] = [
    providerCapability({
      configured: true,
      coverage: "DEX Screener chain-filtered pair and token market data.",
      provider: "dexscreener",
      status: "available",
    }),
    providerCapability({
      configured: true,
      coverage: "GeckoTerminal pool discovery and token data where the network is indexed.",
      provider: "geckoterminal",
      status: "partial",
    }),
    providerCapability({
      configured: true,
      coverage: "DeFiLlama protocol, TVL, stablecoin, and yield data where available.",
      provider: "defillama",
      status: "partial",
    }),
    providerCapability({
      configured: Boolean(getAlchemyNetwork(chain)),
      coverage: "Alchemy balance, transfer, and token metadata calls for configured networks.",
      provider: "alchemy",
      status: getAlchemyNetwork(chain) ? "available" : "unavailable",
    }),
  ];

  return {
    providers,
    status: combineStatus(providers.map((provider) => provider.status)),
  };
}

function buildSecurityCapability(chain: string) {
  const goPlusConfigured = hasGoPlusChain(chain);
  const providers: ChainCapabilityProvider[] = [
    providerCapability({
      configured: goPlusConfigured,
      coverage: "GoPlus token and address risk screens for supported chains.",
      provider: "goplus",
      status: goPlusConfigured ? "available" : "unavailable",
    }),
    providerCapability({
      configured: true,
      coverage: "Explorer account, transaction, token transfer, and contract-code reads.",
      provider: "etherscan",
      status: "available",
    }),
  ];

  return {
    providers,
    status: combineStatus(providers.map((provider) => provider.status)),
  };
}

function buildSmartMoneyLimitations({
  intent,
  nansenSupported,
  providers,
  surfEnabled,
  surfHasSql,
}: {
  intent: string;
  nansenSupported: boolean;
  providers: ChainCapabilityProvider[];
  surfEnabled: boolean;
  surfHasSql: boolean;
}) {
  if (intent !== "smart-money") {
    return [];
  }

  const limitations: string[] = [];
  const hasConfiguredRows = providers.some(
    (provider) => provider.configured && provider.status === "available"
  );

  if (!surfEnabled) {
    limitations.push(
      "Surf skill ability is not configured, so broad smart-money research falls back to other providers or local synthesis."
    );
  } else if (!surfHasSql) {
    limitations.push(
      "Surf skill ability can try dynamic research, but row-level SQL fallback is not mapped for this chain."
    );
  }

  if (!nansenSupported) {
    limitations.push(
      "Nansen row-level smart-money wallet coverage is not enabled for this chain in the current workflow; fallback data may be aggregate token netflow only."
    );
  }

  if (!hasConfiguredRows) {
    limitations.push(
      "Confirmed smart-money labels, retention, sell pressure, wallet net worth, and second-source validation may be unavailable."
    );
  }

  return limitations;
}

function buildCapabilityNotes({
  domains,
  marketDataStatus,
  securityStatus,
  smartMoney,
}: {
  domains: OnChainDomain[];
  marketDataStatus: ChainCapabilityStatus;
  securityStatus: ChainCapabilityStatus;
  smartMoney: ChainSmartMoneyCapability;
}) {
  const notes: string[] = [];

  if (domains.includes("smart_money")) {
    notes.push(
      smartMoney.status === "available"
        ? "Smart-money research can attempt candidate ranking from configured row-level sources."
        : "Smart-money research should stay directional unless provider rows return usable wallet-flow evidence."
    );
  }

  if (marketDataStatus !== "available") {
    notes.push(
      "Market data coverage is partial, so rankings should cite provider coverage limits."
    );
  }

  if (domains.includes("token_security") && securityStatus !== "available") {
    notes.push(
      "Security coverage is partial for this chain, so clean risk output is not final proof."
    );
  }

  return notes;
}

function providerCapability(input: ChainCapabilityProvider) {
  return input;
}

function combineStatus(statuses: ChainCapabilityStatus[]): ChainCapabilityStatus {
  if (statuses.some((status) => status === "available")) {
    return "available";
  }

  if (statuses.some((status) => status === "partial")) {
    return "partial";
  }

  return "unavailable";
}

function hasGoPlusChain(chain: string) {
  try {
    getGoPlusChainId(chain);

    return true;
  } catch {
    return false;
  }
}
