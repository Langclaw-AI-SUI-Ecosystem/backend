import type {
  ModelUsageReceipt,
  ProviderTraceEntry,
  ProviderTraceScope,
  ResearchReport,
  ZeroGProof,
} from "../langclaw/types";

export const onChainDomains = [
  "token_discovery",
  "market_data",
  "pair_liquidity",
  "wallet_portfolio",
  "wallet_pnl",
  "smart_money",
  "defi_tvl",
  "yield_pools",
  "token_security",
  "honeypot_detection",
  "address_approval_risk",
  "social_sentiment",
  "raw_onchain_query",
  "trading_signal_analysis",
] as const;

export type OnChainDomain = (typeof onChainDomains)[number];

export type OnChainProvider =
  | "alchemy"
  | "blockvision"
  | "coingecko"
  | "defillama"
  | "dexscreener"
  | "dune"
  | "elfa"
  | "etherscan"
  | "geckoterminal"
  | "goplus"
  | "local"
  | "nansen"
  | "surf";

export type ProductChainId = "sui-testnet" | "sui-mainnet";

export type OnChainRiskLevel = "low" | "medium" | "high";

export type OnChainExecutorId =
  | "alchemy.asset_transfers"
  | "blockvision.coin_holders"
  | "alchemy.token_balances"
  | "alchemy.token_metadata"
  | "coingecko.coin_markets"
  | "coingecko.search_coin"
  | "defillama.chains"
  | "defillama.protocol"
  | "defillama.protocols"
  | "defillama.stablecoins"
  | "defillama.yield_pools"
  | "dexscreener.latest_boosts"
  | "dexscreener.latest_profiles"
  | "dexscreener.orders"
  | "dexscreener.pair_snapshot"
  | "dexscreener.search_pairs"
  | "dexscreener.token_pairs"
  | "dexscreener.token_snapshot"
  | "dexscreener.top_boosts"
  | "dune.latest_result"
  | "dune.smart_money_sql"
  | "dune.sui_accumulation_flow"
  | "elfa.trending_narratives"
  | "etherscan.account_balance"
  | "etherscan.get_code"
  | "etherscan.token_balance"
  | "etherscan.token_transfers"
  | "etherscan.txlist"
  | "geckoterminal.network_new_pools"
  | "geckoterminal.network_trending_pools"
  | "geckoterminal.pool_data"
  | "geckoterminal.token_data"
  | "geckoterminal.token_info"
  | "geckoterminal.token_top_holders"
  | "goplus.address_security"
  | "goplus.token_security"
  | "local.signal_synthesis"
  | "nansen.smart_money_netflow"
  | "surf.chat_completions"
  | "surf.web_search";

export type OnChainFallbackStep = {
  executor: OnChainExecutorId;
  provider: OnChainProvider;
};

export type JsonSchema = {
  type: "object";
  properties: Record<
    string,
    {
      description?: string;
      enum?: string[];
      type: "array" | "boolean" | "number" | "object" | "string";
    }
  >;
  required?: string[];
};

export type OnChainCommand = {
  id: string;
  domain: OnChainDomain;
  title: string;
  description: string;
  docsUrl?: string;
  executor: OnChainExecutorId;
  fallback?: OnChainFallbackStep[];
  provider: OnChainProvider;
  riskLevel: OnChainRiskLevel;
  cacheTtlSeconds: number;
  paramsSchema: JsonSchema;
  scope?: ProviderTraceScope;
};

export type OnChainContextMessage = {
  role: "assistant" | "user";
  content: string;
};

export type OnChainToolMode = "chat" | "onchain" | "research";

export type ChainCapabilityStatus = "available" | "partial" | "unavailable";

export type SmartMoneyCapabilityMode =
  | "candidate-ranking"
  | "dynamic-ability"
  | "directional-only"
  | "coverage-gap";

export type ChainCapabilityProvider = {
  configured: boolean;
  coverage: string;
  provider: OnChainProvider;
  status: ChainCapabilityStatus;
};

export type ChainSmartMoneyCapability = {
  limitations: string[];
  mode: SmartMoneyCapabilityMode;
  providers: ChainCapabilityProvider[];
  status: ChainCapabilityStatus;
};

export type ChainResearchCapabilities = {
  chain: string;
  chainName: string;
  marketData: {
    providers: ChainCapabilityProvider[];
    status: ChainCapabilityStatus;
  };
  notes: string[];
  security: {
    providers: ChainCapabilityProvider[];
    status: ChainCapabilityStatus;
  };
  smartMoney: ChainSmartMoneyCapability;
  structuredOnChain: ChainCapabilityStatus;
};

export type OnChainPlan = {
  intent: string;
  chain: string;
  chainId: number;
  chainName: string;
  analysisSource: "product-fallback" | "prompt";
  capabilities?: ChainResearchCapabilities;
  commands: OnChainPlannedCommand[];
  domainCount: number;
  nativeSymbol: string;
  providerGaps?: string[];
  providerTrace?: ProviderTraceEntry[];
  productChain: ProductChainId;
  productChainId: number;
  productChainName: string;
  rawQuery?: string;
  query?: string;
  registryCommandCount: number;
  tokenAddress?: string;
  walletAddress?: string;
};

export type OnChainPlannedCommand = {
  command: OnChainCommand;
  reason: string;
};

export type OnChainToolCallEvent = {
  commandId: string;
  domain: OnChainDomain;
  provider: OnChainProvider;
  reason: string;
  title: string;
};

export type OnChainToolStatus = "failed" | "skipped" | "success";

export type OnChainToolResult = {
  attemptedProviders?: OnChainProvider[];
  commandId: string;
  data?: unknown;
  domain: OnChainDomain;
  error?: string;
  fallbackReason?: string;
  latencyMs: number;
  provider: OnChainProvider;
  scope?: ProviderTraceScope;
  sourceUrl?: string;
  status: OnChainToolStatus;
  summary: string;
  title: string;
};

export type OnChainToolFinalPayload = {
  answer: string;
  bullets: string[];
  caveat: string;
  generatedAt: string;
  plan: OnChainPlanSummary;
  providerTrace?: ProviderTraceEntry[];
  report?: ResearchReport;
  recommendation: string;
  title: string;
  tools: OnChainToolResult[];
  proof?: ZeroGProof;
  usage?: ModelUsageReceipt;
};

export type OnChainPlanSummary = Omit<OnChainPlan, "commands"> & {
  commands: Array<{
    commandId: string;
    domain: OnChainDomain;
    provider: OnChainProvider;
    reason: string;
    title: string;
  }>;
};

export type OnChainProviderResponse = {
  data: unknown;
  sourceUrl?: string;
  summary?: string;
};

export type OnChainExecuteInput = {
  chain: string;
  chainId: number;
  command: OnChainCommand;
  previousResults: OnChainToolResult[];
  rawQuery?: string;
  query?: string;
  signal?: AbortSignal;
  tokenAddress?: string;
  walletAddress?: string;
};
