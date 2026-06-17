import {
  getChainLookupTerms,
  inferAnalysisChain,
  isProviderSupportedForChain,
  resolveChain,
} from "./chains";
import { buildChainResearchCapabilities } from "./capabilities";
import { normalizeProtocolSlug } from "./providers/defillama";
import { resolveProductChain } from "../chain-config";
import { readPremiumProviderConfig } from "../premium-providers";
import {
  getCommandsByDomain,
  onChainCommandById,
  onChainCommands,
  onChainDomainLabels,
} from "./registry";
import type {
  OnChainCommand,
  OnChainContextMessage,
  ChainResearchCapabilities,
  OnChainDomain,
  OnChainPlan,
  OnChainPlannedCommand,
} from "./types";
import { onChainDomains } from "./types";

const evmAddressPattern = /\b0x[a-fA-F0-9]{40}\b/;
const solanaAddressPattern = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/;

export function planOnChainTools({
  chain: requestedChain,
  context,
  message,
}: {
  chain?: string;
  context: OnChainContextMessage[];
  message: string;
}): OnChainPlan {
  const text = buildPlanningText(message, context);
  const productChain = resolveProductChain(requestedChain);
  const chainResolution = inferAnalysisChain(message, productChain.id);
  const chain = chainResolution.chain;
  const messageAddresses = extractAddresses(message);
  const addresses = messageAddresses.length ? messageAddresses : extractAddresses(text);
  const addressInferenceText = messageAddresses.length ? message : text;
  const messageIntent = classifyIntent(message);
  const intent = messageIntent === "token-discovery" ? classifyIntent(text) : messageIntent;
  const domains = selectDomains(
    messageIntent === "token-discovery" ? text : message,
    intent
  );
  const rawQuery = buildRawQuery(message, addresses);
  const focusedQuery = buildFocusedQuery(rawQuery, chain.id);
  const tokenAddress = inferTokenAddress(addressInferenceText, addresses);
  const walletAddress = inferWalletAddress(addressInferenceText, addresses, tokenAddress);
  const pairFocused = isPairFocused(addressInferenceText);
  const query = isGenericLiquidityAnomalyRequest({
    intent,
    pairFocused,
    focusedQuery,
    tokenAddress,
    walletAddress,
  })
    ? chain.name
    : focusedQuery ?? rawQuery;
  const planned = selectCommands({
    chain: chain.id,
    domains,
    intent,
    pairFocused,
    focusedQuery,
    rawQuery,
    query,
    tokenAddress,
    walletAddress,
  });
  const capabilities = buildChainResearchCapabilities({
    chain: chain.id,
    domains,
    intent,
    query,
    rawQuery,
    tokenAddress,
  });

  return {
    chain: chain.id as OnChainPlan["chain"],
    chainId: chain.etherscanId ?? 0,
    chainName: chain.name,
    analysisSource: chainResolution.source,
    capabilities,
    commands: planned,
    domainCount: onChainDomains.length,
    intent,
    nativeSymbol: chain.nativeSymbol ?? "ETH",
    providerGaps: buildProviderGaps(chain.id, domains, capabilities),
    providerTrace: buildPlanProviderTrace(chain.id),
    productChain: productChain.id,
    productChainId: productChain.chainId,
    productChainName: productChain.name,
    rawQuery,
    query,
    registryCommandCount: onChainCommands.length,
    tokenAddress,
    walletAddress,
  };
}

export function summarizePlan(plan: OnChainPlan) {
  return {
    ...plan,
    commands: plan.commands.map(({ command, reason }) => ({
      commandId: command.id,
      domain: command.domain,
      provider: command.provider,
      reason,
      title: command.title,
    })),
  };
}

function selectDomains(text: string, intent: string): OnChainDomain[] {
  const normalized = text.toLowerCase();
  const domains = new Set<OnChainDomain>();

  if (/\b(trending|boost|new token|gem|discover|narrative|hot)\b/i.test(normalized)) {
    domains.add("token_discovery");
    domains.add("market_data");
    domains.add("social_sentiment");
  }

  if (/\b(price|market|volume|fdv|mcap|market cap|liquidity|pool|pair)\b/i.test(normalized)) {
    domains.add("pair_liquidity");
    domains.add("market_data");
  }

  if (hasWalletDomainIntent(normalized)) {
    domains.add("wallet_portfolio");
    domains.add("address_approval_risk");
  }

  if (/\b(pnl|profit|loss|realized|unrealized)\b/i.test(normalized)) {
    domains.add("wallet_pnl");
  }

  if (/\b(smart[-\s]money|whale|accumulat\w*|holder|flow)\b/i.test(normalized)) {
    domains.add("smart_money");
  }

  if (/\b(tvl|defi|protocol)\b/i.test(normalized)) {
    domains.add("defi_tvl");
  }

  if (/\b(yield|apy|pool|stablecoin|farm)\b/i.test(normalized)) {
    domains.add("yield_pools");
  }

  if (/\b(security|audit|risk|rug|owner|mint|proxy)\b/i.test(normalized)) {
    domains.add("token_security");
  }

  if (/\b(honeypot|sell tax|buy tax|blacklist|cannot sell)\b/i.test(normalized)) {
    domains.add("honeypot_detection");
  }

  if (/\b(raw|tx|transaction|transfer|contract code|bytecode)\b/i.test(normalized)) {
    domains.add("raw_onchain_query");
  }

  if (/\b(signal|entry|exit|trade|trading|bullish|bearish)\b/i.test(normalized)) {
    domains.add("trading_signal_analysis");
  }

  if (!domains.size) {
    if (intent === "wallet") {
      domains.add("wallet_portfolio");
      domains.add("smart_money");
    } else if (intent === "smart-money") {
      domains.add("smart_money");
      domains.add("market_data");
    } else {
      domains.add("token_discovery");
      domains.add("market_data");
      domains.add("token_security");
    }
  }

  return Array.from(domains).slice(0, 4);
}

function selectCommands({
  chain,
  domains,
  intent,
  pairFocused,
  focusedQuery,
  rawQuery,
  query,
  tokenAddress,
  walletAddress,
}: {
  chain: string;
  domains: OnChainDomain[];
  intent: string;
  pairFocused: boolean;
  focusedQuery?: string;
  rawQuery?: string;
  query?: string;
  tokenAddress?: string;
  walletAddress?: string;
}) {
  if (pairFocused && tokenAddress) {
    return pickCommands(
      [
        "pair_liquidity.geckoterminal_pool_data",
        "pair_liquidity.pair_details",
        "pair_liquidity.token_pools",
        "pair_liquidity.liquidity_risk_synthesis",
        "trading_signal_analysis.trading_signal_synthesis",
      ],
      intent
    );
  }

  if (
    isGenericLiquidityAnomalyRequest({
      intent,
      pairFocused,
      focusedQuery,
      tokenAddress,
      walletAddress,
    })
  ) {
    return pickCommands(
      [
        "pair_liquidity.geckoterminal_network_trending_pools",
        "pair_liquidity.geckoterminal_network_new_pools",
        "pair_liquidity.liquidity_pair_search",
        "token_discovery.latest_boosts",
        "trading_signal_analysis.trading_signal_synthesis",
      ],
      intent
    );
  }

  const candidates = domains.flatMap((domain) => getCommandsByDomain(domain));
  const selected: OnChainPlannedCommand[] = [];

  for (const command of candidates) {
    if (
      intent === "smart-money" &&
      selected.some(
        (item) => isPrimarySmartMoneyProviderCommand(item.command.id)
      ) &&
      isPrimarySmartMoneyProviderCommand(command.id)
    ) {
      continue;
    }

    if (
      !canRun(command, {
        chain,
        pairFocused,
        rawQuery,
        query,
        tokenAddress,
        walletAddress,
      })
    ) {
      continue;
    }

    selected.push({
      command,
      reason: reasonFor(command, intent),
    });

    if (selected.length >= 5) {
      break;
    }
  }

  const synthesis = onChainCommands.find(
    (command) => command.id === "trading_signal_analysis.trading_signal_synthesis"
  );

  if (synthesis && !selected.some((item) => item.command.id === synthesis.id)) {
    selected.push({
      command: synthesis,
      reason: "Synthesize the on-chain tool results into an analysis-only answer.",
    });
  }

  return selected.length ? selected : fallbackCommands(intent);
}

function fallbackCommands(intent: string) {
  const ids =
    intent === "wallet"
      ? [
          "wallet_portfolio.wallet_token_balances",
          "wallet_portfolio.wallet_recent_transfers",
          "wallet_portfolio.portfolio_signal_synthesis",
        ]
      : intent === "smart-money"
        ? [
            "smart_money.surf_smart_money_research",
            "smart_money.smart_money_dune",
            "smart_money.nansen_smart_money_netflow",
            "smart_money.smart_money_signal_synthesis",
          ]
      : [
          "token_discovery.trending_boosted_tokens",
          "token_discovery.latest_token_profiles",
          "trading_signal_analysis.trading_signal_synthesis",
        ];

  return ids
    .map((id) => onChainCommands.find((command) => command.id === id))
    .filter((command): command is OnChainCommand => Boolean(command))
    .map((command) => ({
      command,
      reason: reasonFor(command, intent),
    }));
}

function isPrimarySmartMoneyProviderCommand(commandId: string) {
  return (
    commandId === "smart_money.smart_money_dune" ||
    commandId === "smart_money.surf_smart_money_research" ||
    commandId === "smart_money.nansen_smart_money_netflow"
  );
}

function canRun(
  command: OnChainCommand,
  values: {
    chain: string;
    pairFocused?: boolean;
    rawQuery?: string;
    query?: string;
    tokenAddress?: string;
    walletAddress?: string;
  }
) {
  const required = command.paramsSchema.required ?? [];

  // The Sui-native Dune executor queries the `dex_sui.trades` spellbook directly,
  // so it bypasses the EVM-only `dune` provider gate but stays Sui-only.
  if (command.executor === "dune.sui_accumulation_flow") {
    if (resolveChain(values.chain).id !== "sui") {
      return false;
    }
  } else if (command.provider === "blockvision") {
    if (resolveChain(values.chain).id !== "sui") {
      return false;
    }

    return (
      process.env.SUI_BLOCKVISION_ENABLED?.trim().toLowerCase() === "true" &&
      Boolean(process.env.SUI_BLOCKVISION_API_KEY?.trim())
    );
  } else if (!isProviderSupportedForChain(values.chain, command.provider)) {
    return false;
  }

  if (isPremiumProvider(command.provider) && !readPremiumProviderConfig(command.provider).enabled) {
    return false;
  }

  if (
    values.pairFocused &&
    required.includes("tokenAddress") &&
    !required.includes("pairAddress")
  ) {
    return false;
  }

  if (command.executor === "defillama.protocol") {
    return Boolean(normalizeProtocolSlug(values.query));
  }

  return required.every((field) => {
    if (field === "query") {
      return Boolean(values.query);
    }

    if (field === "tokenAddress" || field === "pairAddress") {
      return Boolean(values.tokenAddress);
    }

    if (field === "walletAddress") {
      return Boolean(values.walletAddress);
    }

    if (field === "queryId") {
      return (
        /\bquery\s+\d{3,12}\b/i.test(values.rawQuery ?? values.query ?? "") ||
        Boolean(process.env.DUNE_DEFAULT_QUERY_ID)
      );
    }

    return true;
  });
}

function buildPlanProviderTrace(chain: string) {
  if (chain === "sui") {
    const missing = (["surf", "elfa"] as const)
      .filter((provider) => !readPremiumProviderConfig(provider).enabled)
      .map((provider) => ({
        message: `${provider.toUpperCase()} is not configured for this backend.`,
        provider,
        scope: "sui-premium" as const,
        status: "skipped" as const,
      }));

    return [
      ...missing,
      skippedPremiumTrace(
        "nansen",
        "Nansen direct smart-money netflow has no Sui coverage in this workflow."
      ),
    ];
  }

  return [
    ...(readPremiumProviderConfig("surf").enabled
      ? []
      : [
          skippedPremiumTrace(
            "surf",
            "Surf is not configured for this backend."
          ),
        ]),
    skippedPremiumTrace(
      "nansen",
      "Nansen direct smart-money netflow has no Sui coverage in this workflow."
    ),
    skippedPremiumTrace(
      "elfa",
      "Premium narrative coverage is reserved for the Sui product chain."
    ),
  ];
}

function skippedPremiumTrace(
  provider: "surf" | "nansen" | "elfa",
  message: string
) {
  return {
    message,
    provider,
    scope: "out-of-scope" as const,
    status: "skipped" as const,
  };
}

function isPremiumProvider(provider: string): provider is "nansen" | "surf" | "elfa" {
  return provider === "nansen" || provider === "surf" || provider === "elfa";
}

function buildProviderGaps(
  chain: string,
  domains: OnChainDomain[],
  capabilities: ChainResearchCapabilities
) {
  const gaps: string[] = [];

  const goplusWouldHaveRun = domains
    .flatMap((domain) => getCommandsByDomain(domain))
    .some((command) => command.provider === "goplus");

  if (!isProviderSupportedForChain(chain, "goplus") && goplusWouldHaveRun) {
    gaps.push(
      `GoPlus security checks are not available for ${capabilities.chainName} in this workflow, so those commands were skipped.`
    );
  }

  if (domains.includes("smart_money")) {
    gaps.push(...capabilities.smartMoney.limitations);
  }

  return Array.from(new Set(gaps));
}

function reasonFor(command: OnChainCommand, intent: string) {
  const domain = onChainDomainLabels[command.domain];

  return `${domain} is relevant to the detected ${intent} intent.`;
}

function classifyIntent(text: string) {
  if (
    /\b(smart[-\s]money|whale|accumulat\w*|holder(?:\s+flow)?|netflow|token flow)\b/i.test(
      text
    )
  ) {
    return "smart-money";
  }

  if (/\b(wallet|portfolio|balance|address|pnl)\b/i.test(text)) {
    return "wallet";
  }

  if (/\b(tvl|yield|defi|stablecoin|protocol)\b/i.test(text)) {
    return "defi";
  }

  if (/\b(security|honeypot|audit|rug|risk|tax)\b/i.test(text)) {
    return "security";
  }

  if (/\b(signal|trade|trading|entry|exit)\b/i.test(text)) {
    return "trading-signal";
  }

  if (/\b(price|market|volume|liquidity|pool|pair|anomal)\b/i.test(text)) {
    return "trading-signal";
  }

  return "token-discovery";
}

function hasWalletDomainIntent(text: string) {
  const addressIntent =
    /\baddress\b/i.test(text) && !/\btoken[-\s]?address\b/i.test(text);

  return (
    /\b(portfolio|balance)\b/i.test(text) ||
    addressIntent ||
    /\bwallet\b(?![-\s]?flow\b)/i.test(text)
  );
}

function isPairFocused(text: string) {
  return /\b(pair|pool|liquidity|anomal)\b/i.test(text);
}

function buildPlanningText(message: string, context: OnChainContextMessage[]) {
  const prior = [...context]
    .reverse()
    .slice(0, 4)
    .map((item) => item.content)
    .join(" ");

  return `${prior} ${message}`;
}

function extractAddresses(text: string) {
  const evm = Array.from(text.matchAll(new RegExp(evmAddressPattern, "g"))).map(
    (match) => match[0]
  );
  const solana = Array.from(text.matchAll(new RegExp(solanaAddressPattern, "g")))
    .map((match) => match[0])
    .filter((value) => !evm.includes(value));

  return [...evm, ...solana];
}

function inferTokenAddress(
  text: string,
  addresses: string[]
): string | undefined {
  if (!addresses.length) {
    return undefined;
  }

  if (/\b(wallet|portfolio|my address|smart money wallet)\b/i.test(text)) {
    return addresses[1];
  }

  return addresses[0];
}

function inferWalletAddress(
  text: string,
  addresses: string[],
  tokenAddress: string | undefined
): string | undefined {
  if (!addresses.length) {
    return undefined;
  }

  if (/\b(wallet|portfolio|my address|smart money wallet|pnl|balance)\b/i.test(text)) {
    return addresses[0];
  }

  return addresses.find((address) => address !== tokenAddress);
}

function buildRawQuery(message: string, addresses: string[]) {
  let query = message.trim();

  for (const address of addresses) {
    query = query.replace(address, " ");
  }

  query = query.replace(/\s+/g, " ").trim();

  return query || undefined;
}

function buildFocusedQuery(
  rawQuery: string | undefined,
  chain: string
) {
  if (!rawQuery) {
    return undefined;
  }

  const uppercaseTicker = Array.from(
    rawQuery.matchAll(/\b[A-Z][A-Z0-9]{1,9}\b/g)
  )
    .map((match) => match[0])
    .find((value) => !genericTickerStopwords.has(value));

  if (uppercaseTicker) {
    return uppercaseTicker;
  }

  let cleaned = rawQuery;

  for (const term of getChainLookupTerms(chain)) {
    cleaned = cleaned.replace(
      new RegExp(`\\b${escapeRegExp(term)}\\b`, "ig"),
      " "
    );
  }

  cleaned = cleaned
    .replace(/\bquery\s+\d{3,12}\b/gi, " ")
    .replace(/\b(find|show|detect|analy[sz]e?|check|screen|rank|compare|track|watch|scan|read|review|inspect)\b/gi, " ")
    .replace(/\b(smart[-\s]?money|accumulat\w*|liquidity|anomal(?:y|ies)|dex|pair|pairs|pool|pools|token|tokens|price|market|volume|yield|momentum|trend(?:ing)?|new|holders?|security|risk|signal|signals|trade|trading|entry|exit|flow|flows|protocol|protocols|detail|details|tvl|wallet)\b/gi, " ")
    .replace(/\b(at|by|for|from|in|into|of|on|to|and|with|the|my|a|an)\b/gi, " ")
    .replace(/[.,:;()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned || focusedQueryConnectorStopwords.has(cleaned.toLowerCase())) {
    return undefined;
  }

  return cleaned;
}

function isGenericLiquidityAnomalyRequest({
  intent,
  pairFocused,
  focusedQuery,
  tokenAddress,
  walletAddress,
}: {
  intent: string;
  pairFocused: boolean;
  focusedQuery?: string;
  tokenAddress?: string;
  walletAddress?: string;
}) {
  return (
    intent === "trading-signal" &&
    pairFocused &&
    !tokenAddress &&
    !walletAddress &&
    !focusedQuery
  );
}

function pickCommands(ids: string[], intent: string) {
  return ids
    .map((id) => onChainCommandById.get(id))
    .filter((command): command is OnChainCommand => Boolean(command))
    .map((command) => ({
      command,
      reason: reasonFor(command, intent),
    }));
}

const genericTickerStopwords = new Set([
  "APY",
  "DEX",
  "ETH",
  "EVM",
  "TVL",
  "USD",
]);

const focusedQueryConnectorStopwords = new Set([
  "and",
  "at",
  "by",
  "for",
  "from",
  "in",
  "into",
  "of",
  "on",
  "the",
  "to",
  "with",
]);

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
