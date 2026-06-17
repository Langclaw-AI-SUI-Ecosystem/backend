import type {
  JsonSchema,
  OnChainCommand,
  OnChainDomain,
  OnChainExecutorId,
  OnChainFallbackStep,
  OnChainProvider,
  OnChainRiskLevel,
} from "./types";
import { onChainDomains } from "./types";

type CommandSeed = {
  description: string;
  docsUrl?: string;
  executor: OnChainExecutorId;
  fallback?: OnChainFallbackStep[];
  id: string;
  provider: OnChainProvider;
  required?: string[];
  riskLevel?: OnChainRiskLevel;
  scope?: OnChainCommand["scope"];
  title: string;
};

type DomainPack = {
  domain: OnChainDomain;
  commands: CommandSeed[];
};

const docs = {
  alchemy: "https://www.alchemy.com/docs/data/token-api/token-api-endpoints/alchemy-get-token-balances",
  blockvision: "https://docs.blockvision.org/reference/retrieve-coin-holders",
  coingecko: "https://docs.coingecko.com/reference/search-data",
  defillama: "https://api-docs.defillama.com/",
  dexscreener: "https://docs.dexscreener.com/api/reference",
  dune: "https://docs.dune.com/api-reference/executions/execution-object",
  elfa: "https://docs.elfa.ai/api/rest/elfa-api/",
  etherscan: "https://docs.etherscan.io/introduction",
  geckoterminal: "https://docs.coingecko.com/reference/networks-list",
  goplus: "https://docs.gopluslabs.io/docs/getting-started",
  nansen: "https://docs.nansen.ai/api/smart-money",
  surf: "https://agents.asksurf.ai/",
};

const commonProperties: JsonSchema["properties"] = {
  chain: {
    description: "Target product chain slug: sui-testnet or sui-mainnet.",
    type: "string",
  },
  limit: {
    description: "Maximum number of records to inspect.",
    type: "number",
  },
  pairAddress: {
    description: "DEX pair address when the command targets a specific pool.",
    type: "string",
  },
  query: {
    description: "Natural language search query or token symbol.",
    type: "string",
  },
  queryId: {
    description: "Dune saved query id.",
    type: "string",
  },
  tokenAddress: {
    description: "Token contract address.",
    type: "string",
  },
  walletAddress: {
    description: "Wallet or account address.",
    type: "string",
  },
};

const packs: DomainPack[] = [
  {
    domain: "token_discovery",
    commands: [
      seed(
        "surf_discovery_search",
        "Surf discovery search",
        "Search broad crypto market context and ecosystem narratives through Surf.",
        "surf.web_search",
        "surf",
        ["query"],
        "medium",
        [
          {
            executor: "dexscreener.search_pairs",
            provider: "dexscreener",
          },
        ],
        "sui-premium"
      ),
      seed("trending_boosted_tokens", "Trending boosted tokens", "Find tokens with the most active DEX Screener boosts.", "dexscreener.top_boosts", "dexscreener"),
      seed("coingecko_search_coin", "CoinGecko coin search", "Resolve a likely CoinGecko coin id before using aggregated market endpoints.", "coingecko.search_coin", "coingecko", ["query"]),
      seed("geckoterminal_trending_pools", "GeckoTerminal trending pools", "Fetch trending pools for the inferred analysis chain through GeckoTerminal.", "geckoterminal.network_trending_pools", "geckoterminal"),
      seed("geckoterminal_new_pools", "GeckoTerminal new pools", "Fetch newly created pools for the inferred analysis chain through GeckoTerminal.", "geckoterminal.network_new_pools", "geckoterminal"),
      seed("latest_token_profiles", "Latest token profiles", "Read newly published DEX Screener token profiles.", "dexscreener.latest_profiles", "dexscreener"),
      seed("latest_boosts", "Latest token boosts", "Fetch the latest DEX Screener token boost feed.", "dexscreener.latest_boosts", "dexscreener"),
      seed("pair_search", "Pair search", "Search DEX pairs by symbol, address, or narrative query.", "dexscreener.search_pairs", "dexscreener", ["query"]),
      seed("dune_trending_watchlist", "Dune trending watchlist", "Fetch a configured Dune watchlist query for discovery.", "dune.latest_result", "dune", ["queryId"], "medium"),
      seed("discovery_signal_synthesis", "Discovery signal synthesis", "Summarize token discovery signals from prior tool results.", "local.signal_synthesis", "local"),
    ],
  },
  {
    domain: "market_data",
    commands: [
      seed(
        "surf_market_search",
        "Surf market search",
        "Search market context, web coverage, and broad crypto signal summaries through Surf.",
        "surf.web_search",
        "surf",
        ["query"],
        "medium",
        [
          {
            executor: "dexscreener.search_pairs",
            provider: "dexscreener",
          },
        ],
        "sui-premium"
      ),
      seed("coingecko_coin_markets", "CoinGecko coin markets", "Fetch aggregated price, market cap, and volume after resolving a CoinGecko coin id.", "coingecko.coin_markets", "coingecko", ["query"]),
      seed("geckoterminal_token_data", "GeckoTerminal token data", "Fetch token-level on-chain market data by token contract address.", "geckoterminal.token_data", "geckoterminal", ["tokenAddress"]),
      seed("token_market_snapshot", "Token market snapshot", "Fetch token price, volume, liquidity, FDV, and market cap.", "dexscreener.token_snapshot", "dexscreener", ["tokenAddress"]),
      seed("pair_price_snapshot", "Pair price snapshot", "Fetch price and volume for a specific DEX pair.", "dexscreener.pair_snapshot", "dexscreener", ["pairAddress"]),
      seed("market_pair_search", "Market pair search", "Search market pairs by token symbol or phrase.", "dexscreener.search_pairs", "dexscreener", ["query"]),
      seed("token_metadata", "Token metadata", "Fetch token symbol, name, logo, and decimals through Alchemy.", "alchemy.token_metadata", "alchemy", ["tokenAddress"]),
      seed("market_dune_snapshot", "Dune market snapshot", "Fetch a configured Dune market analytics query.", "dune.latest_result", "dune", ["queryId"], "medium"),
      seed("market_signal_synthesis", "Market signal synthesis", "Summarize market trend, liquidity, and volume signals.", "local.signal_synthesis", "local"),
    ],
  },
  {
    domain: "pair_liquidity",
    commands: [
      seed("geckoterminal_network_trending_pools", "GeckoTerminal trending pools", "Inspect the chain's trending pools before drilling into a specific pair.", "geckoterminal.network_trending_pools", "geckoterminal"),
      seed("geckoterminal_network_new_pools", "GeckoTerminal new pools", "Inspect newly created pools on the analysis chain for early liquidity anomalies.", "geckoterminal.network_new_pools", "geckoterminal"),
      seed("geckoterminal_pool_data", "GeckoTerminal pool data", "Fetch pair-level liquidity and activity for a specific pool address.", "geckoterminal.pool_data", "geckoterminal", ["pairAddress"]),
      seed("token_pools", "Token pools", "Fetch liquidity pools for a token address.", "dexscreener.token_pairs", "dexscreener", ["tokenAddress"]),
      seed("pair_details", "Pair details", "Fetch pair-level liquidity and transaction metrics.", "dexscreener.pair_snapshot", "dexscreener", ["pairAddress"]),
      seed("paid_order_check", "Paid order check", "Check DEX Screener paid-order status for token promotion context.", "dexscreener.orders", "dexscreener", ["tokenAddress"]),
      seed("liquidity_pair_search", "Liquidity pair search", "Search liquidity pools from a query.", "dexscreener.search_pairs", "dexscreener", ["query"]),
      seed("pool_age_signal", "Pool age signal", "Summarize pair age and liquidity signals.", "local.signal_synthesis", "local"),
      seed("liquidity_risk_synthesis", "Liquidity risk synthesis", "Summarize liquidity depth, boost, and concentration risk.", "local.signal_synthesis", "local"),
    ],
  },
  {
    domain: "wallet_portfolio",
    commands: [
      seed("wallet_native_balance", "Wallet native balance", "Fetch native coin balance through Etherscan V2.", "etherscan.account_balance", "etherscan", ["walletAddress"]),
      seed("wallet_token_balances", "Wallet token balances", "Fetch ERC-20 balances through Alchemy.", "alchemy.token_balances", "alchemy", ["walletAddress"]),
      seed("wallet_recent_transfers", "Wallet recent transfers", "Fetch recent inbound ERC-20 and native transfers through Alchemy.", "alchemy.asset_transfers", "alchemy", ["walletAddress"]),
      seed("wallet_token_activity", "Wallet token activity", "Fetch token transfer history through Etherscan V2.", "etherscan.token_transfers", "etherscan", ["walletAddress"]),
      seed("wallet_security_check", "Wallet security check", "Check wallet risk flags through GoPlus.", "goplus.address_security", "goplus", ["walletAddress"], "medium"),
      seed("portfolio_signal_synthesis", "Portfolio signal synthesis", "Summarize wallet portfolio exposure and activity.", "local.signal_synthesis", "local"),
    ],
  },
  {
    domain: "wallet_pnl",
    commands: [
      seed("wallet_transfer_history", "Wallet transfer history", "Fetch normal transaction history for wallet activity proxy analysis.", "etherscan.txlist", "etherscan", ["walletAddress"]),
      seed("wallet_token_transfer_history", "Wallet token transfer history", "Fetch ERC-20 transfer history for realized activity clues.", "etherscan.token_transfers", "etherscan", ["walletAddress"]),
      seed("wallet_asset_flow", "Wallet asset flow", "Fetch recent transfer flow through Alchemy.", "alchemy.asset_transfers", "alchemy", ["walletAddress"]),
      seed("token_balance_context", "Token balance context", "Fetch wallet balance for a specific token when supplied.", "etherscan.token_balance", "etherscan", ["walletAddress", "tokenAddress"]),
      seed("wallet_pnl_dune", "Wallet PnL Dune query", "Fetch a configured Dune wallet PnL query.", "dune.latest_result", "dune", ["queryId"], "medium"),
      seed("pnl_signal_synthesis", "PnL signal synthesis", "Summarize possible PnL signals without claiming exact realized profit.", "local.signal_synthesis", "local"),
    ],
  },
  {
    domain: "smart_money",
    commands: [
      seed(
        "sui_smart_money_holders",
        "Sui smart-money holders",
        "Fetch the ranked top holders of a Sui coin (with CEX/whale labels) through the BlockVision Sui indexer — the Sui-native accumulation table. Resolves a coin type or $SYMBOL from the query, else a representative liquid Sui asset.",
        "blockvision.coin_holders",
        "blockvision",
        [],
        "medium",
        undefined,
        "sui-premium"
      ),
      seed(
        "sui_dune_accumulation",
        "Sui DEX accumulation flow",
        "Rank Sui wallets by net USD deployed on Sui DEXes (Dune dex_sui.trades) over a recent window — the flow complement to the BlockVision holder snapshot. Resolves a $SYMBOL from the query, else all Sui DEX trades.",
        "dune.sui_accumulation_flow",
        "dune",
        [],
        "medium",
        undefined,
        "sui-premium"
      ),
      seed(
        "surf_smart_money_research",
        "Surf smart-money ability research",
        "Use the Surf backend skill through Chat Completions with EVM on-chain, market-analysis, search, and calculate abilities to retrieve candidate smart-money wallet-flow rows.",
        "surf.chat_completions",
        "surf",
        ["query"],
        "medium",
        [
          {
            executor: "dune.smart_money_sql",
            provider: "dune",
          },
          {
            executor: "nansen.smart_money_netflow",
            provider: "nansen",
          },
        ],
        "sui-premium"
      ),
      seed(
        "smart_money_dune",
        "Smart-money flow scan",
        "Execute a generated Dune smart-money SQL query from safe chain and token parameters.",
        "dune.smart_money_sql",
        "dune",
        ["query"],
        "medium",
        [
          {
            executor: "nansen.smart_money_netflow",
            provider: "nansen",
          },
        ]
      ),
      seed(
        "nansen_smart_money_netflow",
        "Smart money netflow",
        "Read aggregated smart-money accumulation and distribution on Mantle through Nansen.",
        "nansen.smart_money_netflow",
        "nansen",
        ["query"],
        "medium",
        [
          {
            executor: "dune.smart_money_sql",
            provider: "dune",
          },
        ],
        "sui-premium"
      ),
      seed("smart_wallet_balances", "Smart wallet balances", "Fetch token balances for a suspected smart-money wallet.", "alchemy.token_balances", "alchemy", ["walletAddress"]),
      seed("smart_wallet_transfers", "Smart wallet transfers", "Fetch recent transfer flow for accumulation or exit clues.", "alchemy.asset_transfers", "alchemy", ["walletAddress"]),
      seed("token_whale_transfers", "Token whale transfers", "Fetch recent token transfers for holder movement analysis.", "etherscan.token_transfers", "etherscan", ["tokenAddress"]),
      seed("wallet_risk_screen", "Wallet risk screen", "Screen the tracked wallet for GoPlus risk flags.", "goplus.address_security", "goplus", ["walletAddress"], "medium"),
      seed("smart_money_signal_synthesis", "Smart money signal synthesis", "Summarize accumulation, exit, and risk clues.", "local.signal_synthesis", "local"),
    ],
  },
  {
    domain: "defi_tvl",
    commands: [
      seed("defillama_protocols", "DeFi protocols TVL", "Fetch protocol-level TVL list from DeFiLlama.", "defillama.protocols", "defillama"),
      seed("defillama_chains", "Chain TVL", "Fetch chain-level TVL list from DeFiLlama.", "defillama.chains", "defillama"),
      seed("defillama_protocol_detail", "Protocol TVL detail", "Fetch a specific DeFiLlama protocol detail when query includes a slug.", "defillama.protocol", "defillama", ["query"]),
      seed("stablecoin_supply", "Stablecoin supply", "Fetch stablecoin supply data from DeFiLlama.", "defillama.stablecoins", "defillama"),
      seed("tvl_dune_query", "TVL Dune query", "Fetch a configured Dune TVL query.", "dune.latest_result", "dune", ["queryId"], "medium"),
      seed("tvl_signal_synthesis", "TVL signal synthesis", "Summarize chain and protocol TVL signals.", "local.signal_synthesis", "local"),
    ],
  },
  {
    domain: "yield_pools",
    commands: [
      seed("yield_pool_list", "Yield pool list", "Fetch DeFiLlama yield pools for the selected chain.", "defillama.yield_pools", "defillama"),
      seed("stablecoin_yields", "Stablecoin yields", "Fetch yield pool data and focus on stablecoin opportunities.", "defillama.yield_pools", "defillama"),
      seed("chain_yield_scan", "Chain yield scan", "Scan yields for the selected chain.", "defillama.yield_pools", "defillama"),
      seed("protocol_yield_context", "Protocol yield context", "Fetch protocol context to compare yield against TVL.", "defillama.protocol", "defillama", ["query"]),
      seed("yield_dune_query", "Yield Dune query", "Fetch a configured Dune yield query.", "dune.latest_result", "dune", ["queryId"], "medium"),
      seed("yield_signal_synthesis", "Yield signal synthesis", "Summarize APY, TVL, reward, and risk tradeoffs.", "local.signal_synthesis", "local"),
    ],
  },
  {
    domain: "token_security",
    commands: [
      seed("geckoterminal_token_info", "GeckoTerminal token info", "Fetch token metadata, sites, socials, and security-oriented context from GeckoTerminal.", "geckoterminal.token_info", "geckoterminal", ["tokenAddress"], "medium"),
      seed("geckoterminal_top_holders", "GeckoTerminal top holders", "Fetch the token holder concentration snapshot from GeckoTerminal when available.", "geckoterminal.token_top_holders", "geckoterminal", ["tokenAddress"], "medium"),
      seed("goplus_token_security", "GoPlus token security", "Fetch token risk fields from GoPlus.", "goplus.token_security", "goplus", ["tokenAddress"], "high"),
      seed("contract_code_check", "Contract code check", "Check whether bytecode exists through Etherscan V2.", "etherscan.get_code", "etherscan", ["tokenAddress"], "medium"),
      seed("token_liquidity_context", "Token liquidity context", "Fetch DEX liquidity context for security review.", "dexscreener.token_pairs", "dexscreener", ["tokenAddress"]),
      seed("token_metadata_security", "Token metadata security", "Fetch token metadata to catch symbol and decimal inconsistencies.", "alchemy.token_metadata", "alchemy", ["tokenAddress"]),
      seed("security_dune_query", "Security Dune query", "Fetch a configured Dune token risk query.", "dune.latest_result", "dune", ["queryId"], "medium"),
      seed("security_signal_synthesis", "Security signal synthesis", "Summarize token risk flags and source gaps.", "local.signal_synthesis", "local"),
    ],
  },
  {
    domain: "honeypot_detection",
    commands: [
      seed("honeypot_flag_check", "Honeypot flag check", "Inspect GoPlus honeypot and tax flags.", "goplus.token_security", "goplus", ["tokenAddress"], "high"),
      seed("sell_tax_check", "Sell tax check", "Inspect sell-tax related GoPlus fields.", "goplus.token_security", "goplus", ["tokenAddress"], "high"),
      seed("buy_tax_check", "Buy tax check", "Inspect buy-tax related GoPlus fields.", "goplus.token_security", "goplus", ["tokenAddress"], "high"),
      seed("transfer_restriction_check", "Transfer restriction check", "Inspect transfer restriction and blacklist fields.", "goplus.token_security", "goplus", ["tokenAddress"], "high"),
      seed("honeypot_liquidity_context", "Honeypot liquidity context", "Fetch pool and liquidity context around a suspected honeypot.", "dexscreener.token_pairs", "dexscreener", ["tokenAddress"], "medium"),
      seed("honeypot_signal_synthesis", "Honeypot signal synthesis", "Summarize honeypot, tax, and transfer risk signals.", "local.signal_synthesis", "local"),
    ],
  },
  {
    domain: "address_approval_risk",
    commands: [
      seed("address_risk_check", "Address risk check", "Screen an address through GoPlus malicious address intelligence.", "goplus.address_security", "goplus", ["walletAddress"], "high"),
      seed("wallet_flow_risk", "Wallet flow risk", "Fetch recent transfers for risky flow clues.", "alchemy.asset_transfers", "alchemy", ["walletAddress"], "medium"),
      seed("wallet_native_risk_context", "Wallet native risk context", "Fetch native balance context through Etherscan.", "etherscan.account_balance", "etherscan", ["walletAddress"]),
      seed("approval_token_balance", "Approval token balance context", "Fetch token balance context for approval-risk review.", "etherscan.token_balance", "etherscan", ["walletAddress", "tokenAddress"]),
      seed("approval_dune_query", "Approval Dune query", "Fetch a configured Dune approval-risk query.", "dune.latest_result", "dune", ["queryId"], "medium"),
      seed("approval_signal_synthesis", "Approval signal synthesis", "Summarize address, approval, and flow risk.", "local.signal_synthesis", "local"),
    ],
  },
  {
    domain: "social_sentiment",
    commands: [
      seed(
        "elfa_trending_narratives",
        "Elfa trending narratives",
        "Read real-time narrative momentum and social attention through Elfa.",
        "elfa.trending_narratives",
        "elfa",
        [],
        "medium",
        [
          {
            executor: "dexscreener.top_boosts",
            provider: "dexscreener",
          },
        ],
        "sui-premium"
      ),
      seed("token_profile_socials", "Token profile socials", "Inspect DEX Screener profile links and socials.", "dexscreener.latest_profiles", "dexscreener"),
      seed("pair_social_context", "Pair social context", "Search pair data and social metadata by query.", "dexscreener.search_pairs", "dexscreener", ["query"]),
      seed("boost_sentiment_proxy", "Boost sentiment proxy", "Use token boosts as a lightweight attention proxy.", "dexscreener.top_boosts", "dexscreener"),
      seed("latest_boost_attention", "Latest boost attention", "Fetch latest boosts for real-time attention context.", "dexscreener.latest_boosts", "dexscreener"),
      seed("sentiment_dune_query", "Sentiment Dune query", "Fetch a configured Dune sentiment query.", "dune.latest_result", "dune", ["queryId"], "medium"),
      seed("sentiment_signal_synthesis", "Sentiment signal synthesis", "Summarize attention, links, and sentiment proxies.", "local.signal_synthesis", "local"),
    ],
  },
  {
    domain: "raw_onchain_query",
    commands: [
      seed("raw_account_balance", "Raw account balance", "Query native account balance through Etherscan V2.", "etherscan.account_balance", "etherscan", ["walletAddress"]),
      seed("raw_transactions", "Raw transactions", "Query normal transaction list through Etherscan V2.", "etherscan.txlist", "etherscan", ["walletAddress"]),
      seed("raw_token_transfers", "Raw token transfers", "Query token transfer list through Etherscan V2.", "etherscan.token_transfers", "etherscan"),
      seed("raw_contract_code", "Raw contract code", "Query contract bytecode through Etherscan proxy endpoint.", "etherscan.get_code", "etherscan", ["tokenAddress"]),
      seed("raw_dune_result", "Raw Dune result", "Fetch latest JSON result for a Dune query id.", "dune.latest_result", "dune", ["queryId"], "medium"),
      seed("raw_query_synthesis", "Raw query synthesis", "Summarize raw on-chain query results.", "local.signal_synthesis", "local"),
    ],
  },
  {
    domain: "trading_signal_analysis",
    commands: [
      seed("coingecko_market_context", "CoinGecko market context", "Fetch aggregated market context for a named asset before ranking trading signals.", "coingecko.coin_markets", "coingecko", ["query"], "medium"),
      seed("geckoterminal_trending_pool_signal", "GeckoTerminal trending pool signal", "Inspect trending pools on the analysis chain for liquidity and turnover anomalies.", "geckoterminal.network_trending_pools", "geckoterminal", [], "medium"),
      seed("price_liquidity_signal", "Price and liquidity signal", "Read price, volume, and liquidity from DEX Screener.", "dexscreener.token_snapshot", "dexscreener", ["tokenAddress"], "medium"),
      seed("security_signal", "Security signal", "Read security flags that affect signal quality.", "goplus.token_security", "goplus", ["tokenAddress"], "high"),
      seed("market_attention_signal", "Market attention signal", "Read boost and profile attention proxies.", "dexscreener.top_boosts", "dexscreener"),
      seed("holder_flow_signal", "Holder flow signal", "Read token transfers for flow clues.", "etherscan.token_transfers", "etherscan", ["tokenAddress"], "medium"),
      seed("signal_dune_query", "Signal Dune query", "Fetch a configured Dune trading-signal query.", "dune.latest_result", "dune", ["queryId"], "medium"),
      seed("trading_signal_synthesis", "Trading signal synthesis", "Synthesize non-execution trading signal analysis from available evidence.", "local.signal_synthesis", "local", [], "medium"),
    ],
  },
];

export const onChainCommands = packs.flatMap((pack) =>
  pack.commands.map((command) => createCommand(pack.domain, command))
);

export const onChainCommandById = new Map(
  onChainCommands.map((command) => [command.id, command])
);

export const onChainDomainLabels: Record<OnChainDomain, string> = {
  address_approval_risk: "Address and approval risk",
  defi_tvl: "DeFi TVL",
  honeypot_detection: "Honeypot detection",
  market_data: "Market data",
  pair_liquidity: "Pair and liquidity",
  raw_onchain_query: "Raw on-chain query",
  smart_money: "Smart money tracking",
  social_sentiment: "Social sentiment",
  token_discovery: "Token discovery",
  token_security: "Token security",
  trading_signal_analysis: "Trading signal analysis",
  wallet_pnl: "Wallet PnL",
  wallet_portfolio: "Wallet portfolio",
  yield_pools: "Yield and pools",
};

export function getCommandsByDomain(domain: OnChainDomain) {
  return onChainCommands.filter((command) => command.domain === domain);
}

function seed(
  id: string,
  title: string,
  description: string,
  executor: OnChainExecutorId,
  provider: OnChainProvider,
  required: string[] = [],
  riskLevel: OnChainRiskLevel = "low",
  fallback?: OnChainFallbackStep[],
  scope?: OnChainCommand["scope"]
): CommandSeed {
  return {
    description,
    docsUrl: provider === "local" ? undefined : docs[provider],
    executor,
    fallback,
    id,
    provider,
    required,
    riskLevel,
    scope,
    title,
  };
}

function createCommand(domain: OnChainDomain, seedValue: CommandSeed): OnChainCommand {
  return {
    cacheTtlSeconds: cacheTtlFor(seedValue.provider),
    description: seedValue.description,
    docsUrl: seedValue.docsUrl,
    domain,
    executor: seedValue.executor,
    fallback: seedValue.fallback,
    id: `${domain}.${seedValue.id}`,
    paramsSchema: {
      properties: commonProperties,
      required: seedValue.required,
      type: "object",
    },
    provider: seedValue.provider,
    riskLevel: seedValue.riskLevel ?? "low",
    scope: seedValue.scope,
    title: seedValue.title,
  };
}

function cacheTtlFor(provider: OnChainProvider) {
  if (provider === "dexscreener") {
    return 30;
  }

  if (provider === "defillama") {
    return 300;
  }

  if (provider === "local") {
    return 0;
  }

  return 60;
}

export function assertRegistryShape() {
  const domains = new Set(onChainCommands.map((command) => command.domain));

  return {
    commandCount: onChainCommands.length,
    domainCount: domains.size,
    expectedDomainCount: onChainDomains.length,
  };
}
