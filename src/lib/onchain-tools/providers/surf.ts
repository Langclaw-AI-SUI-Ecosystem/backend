import { spawn } from "node:child_process";

import type { OnChainProviderResponse } from "../types";
import { compactText, fetchJson, requireEnv } from "./http";

type SurfOptions = {
  chain?: string;
  query?: string;
  signal?: AbortSignal;
  tokenAddress?: string;
  walletAddress?: string;
};

type SurfChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  id?: string;
  model?: string;
  usage?: unknown;
};

type SurfSqlResponse = {
  data?: unknown[];
  meta?: unknown;
};

type SurfSqlTransport = "api" | "cli";

type SurfDexTableConfig = {
  chainName: string;
  priceTable: string;
  table: string;
};

type SmartMoneyTarget = {
  chain: string;
  chainName: string;
  externalTokenSignal?: boolean;
  id: string;
  projectName: string;
  requestedChain?: string;
  requestedChainName?: string;
  resolution:
    | "broad-chain"
    | "chain-default"
    | "explicit-address"
    | "explicit-symbol"
    | "external-token-signal";
  sqlPriceTable?: string;
  sqlTable?: string;
  symbol?: string;
  tokenAddress?: string;
  tokenAddressChainName?: string;
};

export type SurfSmartMoneyCoverage = {
  chain: string;
  chainName: string;
  hasSqlFallback: boolean;
  mode: "ability-only" | SmartMoneyTarget["resolution"];
  priceTable?: string;
  sqlTable?: string;
  symbol?: string;
  tokenAddress?: string;
  tokenAddressChainName?: string;
};

type SmartMoneyTokenCategory =
  | "non-stable-token-accumulation"
  | "stablecoin-dry-powder-flow"
  | "wrapped-major-asset-flow"
  | "excluded-infrastructure-flow";

type SmartMoneyStatus =
  | "confirmed_smart_money"
  | "candidate_smart_money"
  | "large_flow_watchlist"
  | "excluded_address";

const MANTLE_MNT_ETHEREUM_ADDRESS =
  "0x3c3a81e81dc49A522A592e7622A7E711c06bf354";

const ARBITRUM_ARB_ADDRESS = "0x912CE59144191C1204E64559FE8253a0e49E6548";
const CELO_TOKEN_ADDRESS = "0x471EcE3750Da237f93B8E339c536989b8978a438";

export const surfBackendSkill = {
  abilities: ["evm_onchain", "market_analysis", "search", "calculate"],
  docsUrl: "https://agents.asksurf.ai/",
  name: "surf",
  surfaces: ["chat_completions", "onchain_sql", "web_search"],
  version: "0.0.3",
} as const;

const surfDexTables: Record<string, SurfDexTableConfig> = {
  arbitrum: {
    chainName: "Arbitrum",
    priceTable: "arbitrum_prices_day",
    table: "arbitrum_dex_trades",
  },
  base: {
    chainName: "Base",
    priceTable: "base_prices_day",
    table: "base_dex_trades",
  },
  bnb: {
    chainName: "BNB Smart Chain",
    priceTable: "bsc_prices_day",
    table: "bsc_dex_trades",
  },
  bsc: {
    chainName: "BNB Smart Chain",
    priceTable: "bsc_prices_day",
    table: "bsc_dex_trades",
  },
  ethereum: {
    chainName: "Ethereum",
    priceTable: "ethereum_prices_day",
    table: "ethereum_dex_trades",
  },
  hyperevm: {
    chainName: "HyperEVM",
    priceTable: "hyperevm_prices_day",
    table: "hyperevm_dex_trades",
  },
  tron: {
    chainName: "Tron",
    priceTable: "tron_prices_day",
    table: "tron_dex_trades",
  },
};

const stablecoinSymbols = new Set([
  "BUSD",
  "DAI",
  "FDUSD",
  "FRAX",
  "GHO",
  "LUSD",
  "PYUSD",
  "SUSDE",
  "TUSD",
  "USDC",
  "USDD",
  "USDE",
  "USDS",
  "USDT",
]);

const wrappedMajorSymbols = new Set([
  "CBETH",
  "EZETH",
  "RETH",
  "STETH",
  "WBTC",
  "WETH",
  "WSTETH",
]);

const defaultSmartMoneyTargets: Record<
  string,
  {
    projectName: string;
    sqlChain: string;
    symbol: string;
    tokenAddress: string;
    tokenAddressChainName?: string;
  }
> = {
  arbitrum: {
    projectName: "Arbitrum",
    sqlChain: "arbitrum",
    symbol: "ARB",
    tokenAddress: ARBITRUM_ARB_ADDRESS,
    tokenAddressChainName: "Arbitrum",
  },
  mantle: {
    projectName: "Mantle",
    sqlChain: "ethereum",
    symbol: "MNT",
    tokenAddress: MANTLE_MNT_ETHEREUM_ADDRESS,
    tokenAddressChainName: "Ethereum mainnet",
  },
  celo: {
    projectName: "Celo",
    sqlChain: "celo",
    symbol: "CELO",
    tokenAddress: CELO_TOKEN_ADDRESS,
    tokenAddressChainName: "Celo mainnet",
  },
};

export async function getSurfWebSearch(
  options: SurfOptions
): Promise<OnChainProviderResponse> {
  const query = (options.query || "Sui crypto market signal").trim();
  const url = new URL("https://api.asksurf.ai/gateway/v1/search/web");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "3");

  let data: unknown;

  try {
    data = await fetchJson(url.toString(), {
      headers: {
        Authorization: `Bearer ${requireEnv("SURF_API_KEY")}`,
      },
      signal: options.signal,
      timeoutMs: readTimeout("SURF_TIMEOUT_MS"),
    });
  } catch (error) {
    if (!shouldTrySurfCliFallback(error)) {
      throw error;
    }

    data = await runSurfCliJson({
      args: ["search-web", "--q", query, "--limit", "3"],
      signal: options.signal,
      timeoutMs: readTimeout("SURF_CLI_TIMEOUT_MS", 60000),
    });
  }

  return {
    data,
    sourceUrl: url.toString(),
    summary: `Fetched Surf web market context for "${query}". ${compactText(data)}`,
  };
}

export async function getSurfSmartMoneyResearch(
  options: SurfOptions
): Promise<OnChainProviderResponse> {
  const query = (options.query || "Find smart-money accumulation on Sui").trim();
  const target = resolveSmartMoneyTarget(options, query);
  let data: SurfChatCompletionResponse;

  try {
    data = (await fetchJson("https://api.asksurf.ai/gateway/v1/chat/completions", {
      body: JSON.stringify({
        ability: [...surfBackendSkill.abilities],
        citation: ["source"],
        messages: [
          {
            content: buildSmartMoneySystemPrompt(),
            role: "system",
          },
          {
            content: buildSmartMoneyUserPrompt(options, query, target),
            role: "user",
          },
        ],
        model: process.env.SURF_CHAT_MODEL?.trim() || "surf-1.5",
        reasoning_effort: process.env.SURF_CHAT_REASONING_EFFORT?.trim() || "medium",
        stream: false,
      }),
      headers: {
        Authorization: `Bearer ${requireEnv("SURF_API_KEY")}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      signal: options.signal,
      timeoutMs: readTimeout("SURF_CHAT_TIMEOUT_MS", 600000),
    })) as SurfChatCompletionResponse;
  } catch (error) {
    if (!shouldTrySurfCliFallback(error)) {
      throw error;
    }

    return getSurfSmartMoneyResearchFromCli({
      query,
      signal: options.signal,
      target,
    });
  }
  const content = readSurfContent(data);
  const parsed = parseJsonObject(content);
  let rows = normalizeRows(parsed?.rows);
  let sections = normalizeSections(parsed?.sections);
  let sqlFallback:
      | {
          meta?: unknown;
          rows: Array<Record<string, unknown>>;
          transport: SurfSqlTransport;
        }
    | undefined;
  let sqlError: string | undefined;

  if (
    !rows.length &&
    target?.sqlTable &&
    target.resolution !== "external-token-signal"
  ) {
    try {
      const fallback = await getDexAccumulationRows(target, options.signal);
      sqlFallback = fallback;

      if (fallback.rows.length) {
        rows = fallback.rows;
        sections = buildDexSqlSections(rows, target);
      }
    } catch (error) {
      if (shouldTrySurfCliFallback(error)) {
        try {
          const fallback = await getDexAccumulationRows(
            target,
            options.signal,
            "cli"
          );
          sqlFallback = fallback;

          if (fallback.rows.length) {
            rows = fallback.rows;
            sections = buildDexSqlSections(rows, target);
          }
        } catch (cliError) {
          sqlError = cliError instanceof Error
            ? cliError.message
            : "Surf CLI fallback failed.";
        }
      } else {
        sqlError = error instanceof Error ? error.message : "Surf SQL fallback failed.";
      }
    }
  }

  const summary = rows.length
    ? buildSmartMoneySummary(rows, target, Boolean(sqlFallback?.rows.length))
    : readTextField(parsed ?? {}, "summary");
  const bottomLine = rows.length
    ? "Use confirmed smart-money only when labels and retention checks support it. DEX-only rows are large-flow watchlist entries, not confirmed smart money."
    : readTextField(parsed ?? {}, "bottomLine");
  const output = {
    ...(parsed ?? {}),
    ability: [...surfBackendSkill.abilities],
    bottomLine,
    content: rows.length ? summary : content,
    id: data.id,
    model: data.model,
    rows,
    sections,
    skill: surfBackendSkill,
    sqlFallback: sqlFallback
      ? {
          meta: sqlFallback.meta,
          source: `agent.${target?.sqlTable}`,
          target: formatTargetLabel(target),
          transport: sqlFallback.transport,
        }
      : undefined,
    sqlFallbackError: sqlError,
    summary,
    target,
    usage: data.usage,
  };

  return {
    data: output,
    sourceUrl: rows.length && sqlFallback?.rows.length
      ? "https://docs.asksurf.ai/data-api/onchain/sql"
      : "https://docs.asksurf.ai/chat-completions",
    summary: rows.length
      ? sqlFallback?.rows.length
        ? `Surf SQL returned ${rows.length} ${formatTargetLabel(target)} DEX accumulation row(s), normalized token amounts, and bucketed weak rows as large DEX-buy candidates.`
        : `Surf ability returned ${rows.length} smart-money candidate row(s). ${compactText(content)}`
      : `Surf ability completed but did not return row-level wallet-flow rows. ${compactText(content)}`,
  };
}

async function getSurfSmartMoneyResearchFromCli({
  query,
  signal,
  target,
}: {
  query: string;
  signal?: AbortSignal;
  target?: SmartMoneyTarget;
}): Promise<OnChainProviderResponse> {
  if (
    !target?.sqlTable ||
    target.resolution === "external-token-signal"
  ) {
    throw new Error("Surf CLI fallback is not mapped for this smart-money scope.");
  }

  const sqlFallback = await getDexAccumulationRows(target, signal, "cli");

  if (!sqlFallback.rows.length) {
    throw new Error("Surf CLI did not return row-level wallet-flow rows.");
  }

  const rows = sqlFallback.rows;
  const sections = buildDexSqlSections(rows, target);
  const summary = buildSmartMoneySummary(rows, target, true);
  const output = {
    ability: [...surfBackendSkill.abilities],
    bottomLine:
      "Use confirmed smart-money only when labels and retention checks support it. DEX-only rows are large-flow watchlist entries, not confirmed smart money.",
    content: summary,
    rows,
    sections,
    skill: surfBackendSkill,
    sqlFallback: {
      meta: sqlFallback.meta,
      source: `agent.${target.sqlTable}`,
      target: formatTargetLabel(target),
      transport: sqlFallback.transport,
    },
    summary,
    target,
  };

  return {
    data: output,
    sourceUrl: "https://docs.asksurf.ai/data-api/onchain/sql",
    summary: `Surf returned ${rows.length} ${formatTargetLabel(target)} DEX accumulation row(s), normalized token amounts, and bucketed weak rows as large DEX-buy candidates.`,
  };
}

export function getSurfSmartMoneyCoverage(
  options: Pick<SurfOptions, "chain" | "query" | "tokenAddress">
): SurfSmartMoneyCoverage {
  const query = (
    options.query ||
    `Find smart-money accumulation on ${options.chain || "Sui"}`
  ).trim();
  const target = resolveSmartMoneyTarget(options, query);
  const normalizedChain = normalizeChainId(
    options.chain || extractChainFromQuery(query)
  );

  if (!target) {
    return {
      chain: normalizedChain,
      chainName: titleCase(normalizedChain),
      hasSqlFallback: false,
      mode: "ability-only",
    };
  }

  return {
    chain: target.chain,
    chainName: target.chainName,
    hasSqlFallback:
      Boolean(target.sqlTable) && target.resolution !== "external-token-signal",
    mode: target.resolution,
    priceTable: target.sqlPriceTable,
    sqlTable: target.sqlTable,
    symbol: target.symbol,
    tokenAddress: target.tokenAddress,
    tokenAddressChainName: target.tokenAddressChainName,
  };
}

function buildSmartMoneySystemPrompt() {
  return [
    "You are a crypto research agent with Surf abilities.",
    "Use only retrieved Surf data. Do not invent wallets, labels, amounts, CEX names, dates, rankings, or token flows.",
    "For smart-money accumulation, classify wallets as candidates unless retrieved labels explicitly prove fund or whale identity.",
    "If the only evidence is row-level DEX buys without labels, retention, or sell-pressure checks, call the rows large DEX-buy candidates, not smart-money candidates.",
    "Always separate non-stable token accumulation, stablecoin dry-powder flow, wrapped major asset flow, and excluded infrastructure flow.",
    "Do not ask the user to rerun the same task for standard follow-up checks. Attempt the checks or list them as unavailable.",
    "Return valid JSON only. Do not wrap the JSON in markdown.",
  ].join(" ");
}

function buildSmartMoneyUserPrompt(
  options: SurfOptions,
  query: string,
  target: SmartMoneyTarget | undefined
) {
  const chain = options.chain || "sui";
  const token = options.tokenAddress
    ? `Token address: ${options.tokenAddress}.`
    : target?.tokenAddress
      ? `Token focus: ${target.symbol ?? "token"} at ${target.tokenAddress}.`
      : target?.symbol
        ? `Token focus: ${target.symbol}.`
        : "Token focus: broad token accumulation if no explicit token was supplied.";
  const wallet = options.walletAddress
    ? `Wallet focus: ${options.walletAddress}.`
    : "Wallet focus: broad candidate accumulation.";
  const targetPrompt = target
    ? buildTargetPrompt(target)
    : "No token target was resolved. Treat this as chain-level research. Do not substitute token activity from another chain as chain activity.";

  return [
    query,
    `Analysis chain: ${chain}.`,
    targetPrompt,
    token,
    wallet,
    "Find candidate smart-money accumulation using EVM on-chain, market analysis, and search abilities.",
    "Prefer row-level evidence for DEX buys and CEX withdrawals.",
    "Return this exact JSON shape:",
    JSON.stringify({
      bottomLine: "short actionable bottom line",
      rows: [
        {
          confidence: "Medium",
          dataStatus: "large_flow_watchlist",
          dexOnly: true,
          netToken: "179.4K",
          netUsd: "$119.4K",
          retentionAfterBuy: "unavailable",
          signal: "DEX buy",
          sellPressureAfterBuy: "unavailable",
          sourceCex: null,
          tokenCategory: "non-stable-token-accumulation",
          tokenAddress: "0x1234...",
          tokenSymbol: "ARB",
          trades: 134,
          transfers: null,
          wallet: "0x1234...abcd",
          walletLabel: "unavailable",
          window: "2026-05-20 to 2026-05-21",
        },
      ],
      sections: [
        { markdown: "Headline and market context.", title: "Read" },
        { markdown: "Evidence summary.", title: "Evidence" },
        { markdown: "Confirmed labeled wallets if any.", title: "Confirmed smart money" },
        { markdown: "Candidate wallets with partial enrichment if any.", title: "Candidate smart money" },
        { markdown: "DEX-only wallets without smart-money confirmation.", title: "Large-flow watchlist" },
        { markdown: "Routers, pools, bridges, CEX, or MM addresses excluded.", title: "Excluded addresses" },
        { markdown: "Provider coverage and unavailable checks.", title: "Limits" },
        { markdown: "Data-source status table.", title: "Data source diagnostics" },
        { markdown: "Checks performed.", title: "Follow-up checks performed" },
        { markdown: "Unavailable checks.", title: "Checks unavailable" },
        { markdown: "Conclusion statement.", title: "Conclusion" },
        { markdown: "What would improve confidence.", title: "What would improve confidence" },
      ],
      summary: "one-paragraph research summary",
    }),
    "If row-level wallet evidence is unavailable, return rows: [] and explain the missing source in sections.",
  ].join("\n");
}

function buildTargetPrompt(target: SmartMoneyTarget) {
  if (target.resolution === "broad-chain") {
    return [
      `Auto-resolved scope: broad token accumulation on ${target.chainName}.`,
      target.sqlTable
        ? `If Chat ability wallet-flow rows are unavailable, use ${target.chainName} DEX trades across token_bought rows, fetch decimals, normalize raw amounts, and bucket stablecoins or wrapped majors separately before asking for more input.`
        : "If row-level wallet-flow is unavailable, explain the source gap without asking for token input first.",
    ].join(" ");
  }

  const contract = target.tokenAddress
    ? `Token contract: ${target.tokenAddress} on ${target.tokenAddressChainName ?? target.chainName}.`
    : `Token symbol filter: ${target.symbol}.`;
  const externalScope = target.resolution === "external-token-signal"
    ? ` Requested chain: ${target.requestedChainName ?? target.requestedChain ?? "requested chain"}. Treat these rows only as external low-confidence token context. Do not present them as ${target.requestedChainName ?? "the requested chain"} chain-level activity.`
    : "";
  const fallbackInstruction = target.resolution === "external-token-signal"
    ? "If requested-chain wallet-flow rows are unavailable, return rows: [] so chain-level fallback providers can run first. Do not substitute external token activity as chain activity."
    : target.sqlTable
      ? `If Chat ability wallet-flow rows are unavailable, use ${target.chainName} DEX trades for ${target.symbol ?? "the token"}, fetch decimals, and normalize raw amounts before asking for more input.`
      : "If row-level wallet-flow is unavailable, explain the source gap without asking for token input first.";

  return [
    `Resolved token target: ${target.projectName} (${target.symbol ?? "token"}).`,
    `${contract}${externalScope}`,
    fallbackInstruction,
  ].join(" ");
}

async function getDexAccumulationRows(
  target: SmartMoneyTarget,
  signal?: AbortSignal,
  transport: SurfSqlTransport = "api"
) {
  if (!target.sqlTable) {
    return {
      rows: [],
      transport,
    };
  }

  if (!target.sqlPriceTable) {
    throw new Error(`Missing Surf price table for ${target.chainName}.`);
  }

  const filters = [
    "block_date >= today() - 7",
    "taker != ''",
    "token_bought_address != ''",
  ];

  if (target.tokenAddress) {
    filters.push(
      `lower(token_bought_address) = '${escapeSqlString(target.tokenAddress.toLowerCase())}'`
    );
  } else if (target.symbol && target.resolution === "explicit-symbol") {
    filters.push(
      `upper(ifNull(token_bought_symbol, '')) = '${escapeSqlString(target.symbol.toUpperCase())}'`
    );
  }

  const stableList = sqlStringList([...stablecoinSymbols]);
  const wrappedList = sqlStringList([...wrappedMajorSymbols]);
  const sql = `
WITH dex AS (
  SELECT
    taker AS wallet,
    upper(ifNull(token_bought_symbol, '')) AS tokenSymbol,
    lower(ifNull(token_bought_address, '')) AS tokenAddress,
    toString(sum(token_bought_amount_raw)) AS tokenBoughtAmountRaw,
    round(sum(ifNull(amount_usd, 0)), 2) AS providerAmountUsd,
    count() AS trades,
    min(block_date) AS firstBlockDate,
    max(block_date) AS lastBlockDate
  FROM agent.${target.sqlTable}
  WHERE ${filters.join("\n    AND ")}
  GROUP BY wallet, tokenSymbol, tokenAddress
),
prices AS (
  SELECT
    lower(contract_address) AS tokenAddress,
    argMax(decimals, block_date) AS tokenDecimals,
    argMax(price, block_date) AS priceUsd
  FROM agent.${target.sqlPriceTable}
  WHERE block_date >= today() - 14
  GROUP BY tokenAddress
)
SELECT
  dex.wallet AS wallet,
  dex.tokenSymbol AS tokenSymbol,
  dex.tokenAddress AS tokenAddress,
  'DEX buy' AS signal,
  dex.tokenBoughtAmountRaw AS tokenBoughtAmountRaw,
  prices.tokenDecimals AS tokenDecimals,
  prices.priceUsd AS priceUsd,
  dex.providerAmountUsd AS providerAmountUsd,
  dex.trades AS trades,
  concat(toString(dex.firstBlockDate), ' to ', toString(dex.lastBlockDate)) AS window
FROM dex
LEFT JOIN prices ON dex.tokenAddress = prices.tokenAddress
WHERE dex.tokenBoughtAmountRaw != '0'
ORDER BY
  multiIf(dex.tokenSymbol IN (${stableList}), 2, dex.tokenSymbol IN (${wrappedList}), 3, 1),
  dex.providerAmountUsd DESC
LIMIT 80
`;
  const payload = transport === "cli"
    ? ((await runSurfCliJson({
        args: ["onchain-sql"],
        input: {
          max_rows: 80,
          sql,
        },
        signal,
        timeoutMs: readTimeout("SURF_CLI_TIMEOUT_MS", 90000),
      })) as SurfSqlResponse)
    : ((await fetchJson("https://api.asksurf.ai/gateway/v1/onchain/sql", {
        body: JSON.stringify({
          max_rows: 80,
          sql,
        }),
        headers: {
          Authorization: `Bearer ${requireEnv("SURF_API_KEY")}`,
          "Content-Type": "application/json",
        },
        method: "POST",
        signal,
        timeoutMs: readTimeout("SURF_SQL_TIMEOUT_MS", 60000),
      })) as SurfSqlResponse);
  const rows: Array<Record<string, unknown>> = [];

  if (Array.isArray(payload.data)) {
    for (const item of payload.data) {
      if (!item || typeof item !== "object") {
        continue;
      }

      const normalized = normalizeDexAccumulationRow(
        item as Record<string, unknown>,
        target
      );

      if (normalized) {
        rows.push(normalized);
      }
    }
  }

  rows.sort(compareSmartMoneyRows);

  return {
    meta: payload.meta,
    rows: rows.slice(0, 20),
    transport,
  };
}

function normalizeDexAccumulationRow(
  record: Record<string, unknown>,
  target?: SmartMoneyTarget
) {
  const address = readTextField(record, "wallet");
  const tokenDecimals = readNumberField(record, "tokenDecimals");
  const tokenAmountRaw = readTextField(record, "tokenBoughtAmountRaw");
  const normalizedTokenAmount =
    normalizeRawTokenAmount(tokenAmountRaw, tokenDecimals) ??
    readNumberField(record, "netToken") ??
    readNumberField(record, "netMnt");
  const priceUsd = readNumberField(record, "priceUsd");
  const providerAmountUsd =
    readNumberField(record, "providerAmountUsd") ?? readNumberField(record, "netUsd");
  const netUsd =
    normalizedTokenAmount !== undefined &&
    priceUsd !== undefined &&
    Number.isFinite(priceUsd) &&
    priceUsd > 0
      ? normalizedTokenAmount * priceUsd
      : providerAmountUsd;
  const trades = readNumberField(record, "trades");
  const tokenAddress =
    readTextField(record, "tokenAddress") || target?.tokenAddress || "";
  const tokenSymbol =
    readTextField(record, "tokenSymbol") || target?.symbol || "TOKEN";
  const window = readTextField(record, "window");
  const tokenCategory = categorizeSmartMoneyToken(tokenSymbol);
  const infrastructureReason = inferInfrastructureReason(record);
  const smartMoneyStatus: SmartMoneyStatus = infrastructureReason
    ? "excluded_address"
    : "large_flow_watchlist";
  const amountSource =
    normalizedTokenAmount !== undefined && tokenAmountRaw && tokenDecimals !== undefined
      ? "raw_amount_decimals"
      : "provider_normalized_fallback";
  const usdSource =
    normalizedTokenAmount !== undefined && priceUsd !== undefined && priceUsd > 0
      ? "normalized_amount_x_price"
      : "provider_amount_usd_fallback";

  if (!address || normalizedTokenAmount === undefined || normalizedTokenAmount <= 0) {
    return undefined;
  }

  const tokenAmount = formatCompactTokenAmount(normalizedTokenAmount);
  const sourceTable = target?.sqlTable ? `agent.${target.sqlTable}` : undefined;

  return {
    address,
    amountSource,
    confidence: "Low",
    dataSourceDiagnostic: [
      "Surf SQL DEX rows",
      amountSource,
      usdSource,
      "wallet_enrichment_partial",
    ].join(" | "),
    dexOnly: true,
    excludedReason: infrastructureReason,
    label: shortenAddress(address),
    netTokenRaw: tokenAmountRaw || null,
    netToken: tokenAmount,
    netUsd: netUsd === undefined ? null : formatCompactUsd(netUsd),
    normalizedTokenAmount: roundTokenAmount(normalizedTokenAmount),
    priceUsd: priceUsd ?? null,
    providerAmountUsd: providerAmountUsd ?? null,
    repeatedAccumulationPattern:
      trades !== undefined && trades >= 3
        ? "repeated DEX buys observed in window"
        : "limited DEX buy history in window",
    retentionAfterBuy: "unavailable",
    signal: "DEX buy",
    sellPressureAfterBuy: "unavailable",
    smartMoneyStatus,
    sourceChain: target?.chainName ?? "EVM",
    sourceTable,
    tokenAddress: tokenAddress || null,
    tokenCategory,
    tokenDecimals: tokenDecimals ?? null,
    tokenFlow: `${tokenAmount} ${tokenSymbol}`,
    tokenSymbol,
    trades: trades ?? null,
    wallet: shortenAddress(address),
    walletAddress: address,
    walletLabel: readTextField(record, "walletLabel") || "unavailable",
    walletNetWorth: "unavailable",
    walletType: "unknown",
    window,
  };
}

function buildDexSqlSections(
  rows: Array<Record<string, unknown>>,
  target: SmartMoneyTarget
) {
  const confirmed = rows.filter((row) => readTextField(row, "smartMoneyStatus") === "confirmed_smart_money");
  const candidates = rows.filter((row) => readTextField(row, "smartMoneyStatus") === "candidate_smart_money");
  const watchlist = rows.filter((row) => readTextField(row, "smartMoneyStatus") === "large_flow_watchlist");
  const excluded = rows.filter((row) => readTextField(row, "smartMoneyStatus") === "excluded_address");
  const scope =
    target.resolution === "broad-chain"
      ? `${target.chainName} tokens`
      : `${target.symbol ?? "token"} on ${target.chainName}`;
  const bucketSummary = summarizeTokenBuckets(rows);

  return [
    {
      markdown: `Headline. Langclaw resolved the request to ${scope} and used row-level Surf DEX activity with raw amount normalization. The current output is a large DEX-buy watchlist unless wallet labels, retention, and sell-pressure checks confirm stronger smart-money behavior.`,
      title: "Read",
    },
    {
      markdown: `Evidence. Surf SQL returned row-level ${target.chainName} DEX trades from the last 7 days. Amounts use token_bought_amount_raw plus token decimals where available, and USD value uses normalized amount times latest price when Surf price metadata is present. Buckets: ${bucketSummary}.`,
      title: "Evidence",
    },
    {
      markdown: formatSmartMoneyRows(confirmed) || "None. No row had a retrieved fund, whale, or smart-wallet label plus retention evidence.",
      title: "Confirmed smart money",
    },
    {
      markdown: formatSmartMoneyRows(candidates) || "None. No wallet had enough enrichment to promote it above a DEX-buy watchlist.",
      title: "Candidate smart money",
    },
    {
      markdown: formatSmartMoneyRows(watchlist) || "No large DEX-buy rows remained after filtering.",
      title: "Large-flow watchlist",
    },
    {
      markdown: formatExcludedRows(excluded) || "None detected from the available labels and heuristics.",
      title: "Excluded addresses",
    },
    {
      markdown: buildDexSqlLimits(rows, target),
      title: "Limits",
    },
    {
      markdown: buildDiagnosticMarkdown(rows, target),
      title: "Data source diagnostics",
    },
    {
      markdown:
        "Normalized raw token amounts with decimals. Recomputed USD notional when token price was available. Bucketed stablecoins, wrapped majors, and non-stable tokens. Checked available row labels for router, pool, bridge, CEX, and market-maker hints. Inferred repeated DEX-buy pattern from trade count.",
      title: "Follow-up checks performed",
    },
    {
      markdown:
        "Unavailable in this Surf SQL fallback: wallet label lookup, definitive contract or EOA status, wallet net worth, post-buy retention, post-buy sell pressure, CEX deposit or withdrawal matching, complete wallet history, and independent second-source validation.",
      title: "Checks unavailable",
    },
    {
      markdown:
        "Confidence: low for smart-money identity, medium for large DEX-buy activity when rows include normalized amount, decimals, USD value, wallet, and window.",
      title: "Conclusion",
    },
    {
      markdown:
        "Confidence would improve with wallet labels, holder balance deltas after the buy, sell-pressure checks after the buy, exchange-flow matching, wallet net worth, longer wallet history, and a second on-chain source.",
      title: "What would improve confidence",
    },
  ];
}

function buildDexSqlLimits(
  rows: Array<Record<string, unknown>>,
  target: SmartMoneyTarget
) {
  const source = target.sqlTable
    ? `agent.${target.sqlTable}`
    : `${target.chainName} DEX trade rows`;
  const windows = uniqueStrings(
    rows.map((row) => readTextField(row, "window")).filter(Boolean)
  );
  const windowText = windows.length
    ? windows.slice(0, 3).join(", ")
    : "the returned query window";
  const tokenFocus = target.tokenAddress
    ? `${target.symbol ? `$${target.symbol}` : "token"} contract ${target.tokenAddress}${target.tokenAddressChainName ? ` on ${target.tokenAddressChainName}` : ""}`
    : target.resolution === "broad-chain"
      ? `${target.chainName} token flow as a chain-level scan`
      : `${target.symbol ? `$${target.symbol}` : "token"} on ${target.chainName}`;
  const nativeGap =
    target.tokenAddress &&
    target.tokenAddressChainName &&
    target.tokenAddressChainName.toLowerCase() !== target.chainName.toLowerCase()
      ? ` ${target.chainName}-native holder and transfer coverage was not confirmed by this row set.`
      : "";
  const statuses = uniqueStrings(
    rows.map((row) =>
      humanizeStatus(readTextField(row, "smartMoneyStatus") || "large_flow_watchlist")
    )
  );
  const classification = statuses.length ? statuses.join(" and ") : "large-flow watchlist";

  return [
    `Coverage gap. This scan used ${source} for ${tokenFocus}.${nativeGap} It did not include complete holder balance deltas, exchange-flow matching, wallet net worth, complete wallet history, or independent second-source validation.`,
    `Smart-money labeling gap. The candidate wallets are mostly unlabeled in the returned rows. A large DEX buy can still come from a router, market maker, OTC desk, CEX-related wallet, or internal operational wallet. The correct classification stays ${classification}, not confirmed smart-money accumulation.`,
    `Sample window. The ranking reflects ${windowText}, not a full long-term balance-delta study. Treat the table as a monitor set until labels and post-buy behavior support a stronger claim.`,
  ].join("\n\n");
}

function uniqueStrings(values: Array<string | undefined>) {
  const seen = new Set<string>();
  const output: string[] = [];

  for (const value of values) {
    const normalized = value?.trim();

    if (!normalized) {
      continue;
    }

    const key = normalized.toLowerCase();

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    output.push(normalized);
  }

  return output;
}

function humanizeStatus(value: string) {
  return value
    .replace(/\bconfirmed_smart_money\b/gi, "confirmed smart money")
    .replace(/\bcandidate_smart_money\b/gi, "candidate smart money")
    .replace(/\blarge_flow_watchlist\b/gi, "large-flow watchlist")
    .replace(/\bexcluded_address\b/gi, "excluded address");
}

function buildSmartMoneySummary(
  rows: Array<Record<string, unknown>>,
  target: SmartMoneyTarget | undefined,
  usedSqlFallback: boolean
) {
  const top = rows
    .filter((row) => readTextField(row, "smartMoneyStatus") !== "excluded_address")
    .slice(0, 3)
    .map((row) => {
    const wallet = readTextField(row, "wallet") || readTextField(row, "label");
    const tokenFlow =
      readTextField(row, "tokenFlow") ||
      [
        readTextField(row, "netToken"),
        readTextField(row, "tokenSymbol") || target?.symbol,
      ]
        .filter(Boolean)
        .join(" ");
    const signal = readTextField(row, "signal");

    return `${wallet} (${tokenFlow} ${signal.toLowerCase()})`;
  });
  const hasConfirmed = rows.some(
    (row) => resolveSmartMoneyStatus(row) === "confirmed_smart_money"
  );
  const hasCandidate = rows.some(
    (row) => resolveSmartMoneyStatus(row) === "candidate_smart_money"
  );
  const source = usedSqlFallback
    ? `Surf SQL over ${formatTargetLabel(target)} DEX trades`
    : "Surf Chat Completions ability output";
  const targetLabel = target?.symbol
    ? target.externalTokenSignal
      ? `$${target.symbol} external token context for ${target.requestedChainName ?? "the requested chain"}`
      : `$${target.symbol}`
    : target?.chainName
      ? `${target.chainName} token`
      : "token";
  const rowLabel = hasConfirmed
    ? "confirmed smart-money wallet-flow"
    : hasCandidate
      ? "candidate smart-money wallet-flow"
      : "large DEX-buy flow";

  return `The clearest accumulation signal is ${rowLabel} for ${targetLabel} from ${source}. Strongest rows: ${top.join(", ")}. DEX-only rows stay in the large-flow watchlist until labels, retention, sell pressure, and second-source checks support a smart-money classification.`;
}

function resolveSmartMoneyStatus(row: Record<string, unknown>): SmartMoneyStatus {
  const explicitStatus = readTextField(row, "smartMoneyStatus");

  if (
    explicitStatus === "confirmed_smart_money" ||
    explicitStatus === "candidate_smart_money" ||
    explicitStatus === "large_flow_watchlist" ||
    explicitStatus === "excluded_address"
  ) {
    return explicitStatus;
  }

  const signal = readTextField(row, "signal");
  const walletLabel = readTextField(row, "walletLabel");
  const retention = readTextField(row, "retentionAfterBuy");
  const sellPressure = readTextField(row, "sellPressureAfterBuy");
  const hasFollowUpCheck =
    Boolean(retention && !/^unavailable$/i.test(retention)) ||
    Boolean(sellPressure && !/^unavailable$/i.test(sellPressure));
  const hasWalletLabel = Boolean(walletLabel && !/^unavailable$/i.test(walletLabel));

  if (/dex buy/i.test(signal) && !(hasWalletLabel && hasFollowUpCheck)) {
    return "large_flow_watchlist";
  }

  return "candidate_smart_money";
}

export function normalizeRawTokenAmount(
  rawAmount: unknown,
  decimals: unknown
) {
  const rawText = String(rawAmount ?? "").trim().replace(/,/g, "");
  const decimalCount = typeof decimals === "number" ? decimals : Number(decimals);

  if (!rawText || !Number.isInteger(decimalCount) || decimalCount < 0) {
    return undefined;
  }

  const normalizedRaw = rawText.endsWith(".0")
    ? rawText.slice(0, -2)
    : rawText;

  if (!/^\d+$/.test(normalizedRaw)) {
    const parsed = Number(normalizedRaw);

    if (!Number.isFinite(parsed)) {
      return undefined;
    }

    const fallback = parsed / 10 ** decimalCount;
    return Number.isFinite(fallback) ? fallback : undefined;
  }

  if (decimalCount === 0) {
    const value = Number(normalizedRaw);
    return Number.isFinite(value) ? value : undefined;
  }

  const padded = normalizedRaw.padStart(decimalCount + 1, "0");
  const whole = padded.slice(0, -decimalCount) || "0";
  const fraction = padded.slice(-decimalCount).replace(/0+$/, "");
  const value = Number(`${whole}${fraction ? `.${fraction}` : ""}`);

  return Number.isFinite(value) ? value : undefined;
}

function categorizeSmartMoneyToken(symbol: string): SmartMoneyTokenCategory {
  const normalized = symbol.trim().toUpperCase();

  if (!normalized) {
    return "excluded-infrastructure-flow";
  }

  if (stablecoinSymbols.has(normalized)) {
    return "stablecoin-dry-powder-flow";
  }

  if (wrappedMajorSymbols.has(normalized)) {
    return "wrapped-major-asset-flow";
  }

  return "non-stable-token-accumulation";
}

function compareSmartMoneyRows(
  left: Record<string, unknown>,
  right: Record<string, unknown>
) {
  const leftPriority = smartMoneyRowPriority(left);
  const rightPriority = smartMoneyRowPriority(right);

  if (leftPriority !== rightPriority) {
    return leftPriority - rightPriority;
  }

  return (
    readUsdNumber(right) - readUsdNumber(left) ||
    (readNumberField(right, "trades") ?? 0) - (readNumberField(left, "trades") ?? 0)
  );
}

function smartMoneyRowPriority(row: Record<string, unknown>) {
  const status = readTextField(row, "smartMoneyStatus");
  const category = readTextField(row, "tokenCategory");

  if (status === "confirmed_smart_money") {
    return 0;
  }

  if (status === "candidate_smart_money") {
    return 1;
  }

  if (category === "non-stable-token-accumulation") {
    return 2;
  }

  if (category === "stablecoin-dry-powder-flow") {
    return 3;
  }

  if (category === "wrapped-major-asset-flow") {
    return 4;
  }

  return 5;
}

function inferInfrastructureReason(record: Record<string, unknown>) {
  const label = [
    readTextField(record, "walletLabel"),
    readTextField(record, "label"),
    readTextField(record, "entity"),
    readTextField(record, "name"),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (!label) {
    return null;
  }

  if (/\b(router|pool|bridge|vault|staking contract)\b/.test(label)) {
    return "infrastructure label";
  }

  if (/\b(cex|exchange|binance|coinbase|bybit|okx|kraken|kucoin|gate\.?io)\b/.test(label)) {
    return "exchange or hot-wallet label";
  }

  if (/\b(market maker|wintermute|jump|amber|flow traders|gts|b2c2)\b/.test(label)) {
    return "market-maker label";
  }

  return null;
}

function summarizeTokenBuckets(rows: Array<Record<string, unknown>>) {
  const counts = new Map<string, number>();

  for (const row of rows) {
    const category =
      readTextField(row, "tokenCategory") || "non-stable-token-accumulation";
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }

  return [
    ["non-stable token accumulation", "non-stable-token-accumulation"],
    ["stablecoin/dry-powder flow", "stablecoin-dry-powder-flow"],
    ["wrapped major asset flow", "wrapped-major-asset-flow"],
    ["excluded infrastructure flow", "excluded-infrastructure-flow"],
  ]
    .map(([label, key]) => `${label}: ${counts.get(key) ?? 0}`)
    .join(", ");
}

function formatSmartMoneyRows(rows: Array<Record<string, unknown>>) {
  return rows
    .slice(0, 5)
    .map((row, index) => {
      const wallet = readTextField(row, "wallet") || readTextField(row, "label");
      const tokenFlow =
        readTextField(row, "tokenFlow") ||
        [
          readTextField(row, "netToken"),
          readTextField(row, "tokenSymbol"),
        ]
          .filter(Boolean)
          .join(" ");
      const netUsd = readTextField(row, "netUsd") || "USD value unavailable";
      const category = readTextField(row, "tokenCategory") || "unbucketed";
      const trades = row.trades ?? "n/a";

      return `${index + 1}. ${wallet}: ${tokenFlow} DEX buy, about ${netUsd}, ${trades} trade(s), bucket ${category}.`;
    })
    .join("\n");
}

function formatExcludedRows(rows: Array<Record<string, unknown>>) {
  return rows
    .slice(0, 5)
    .map((row, index) => {
      const wallet = readTextField(row, "wallet") || readTextField(row, "label");
      const reason = readTextField(row, "excludedReason") || "excluded by infrastructure heuristic";
      const tokenFlow = readTextField(row, "tokenFlow");

      return `${index + 1}. ${wallet}: ${reason}${tokenFlow ? `, ${tokenFlow}` : ""}.`;
    })
    .join("\n");
}

function buildDiagnosticMarkdown(
  rows: Array<Record<string, unknown>>,
  target: SmartMoneyTarget
) {
  const source = `agent.${target.sqlTable}`;
  const priceSource = target.sqlPriceTable ? `agent.${target.sqlPriceTable}` : "unavailable";
  const directRows = rows.length;
  const normalized = rows.filter(
    (row) => readTextField(row, "amountSource") === "raw_amount_decimals"
  ).length;
  const priced = rows.filter(
    (row) => readTextField(row, "dataSourceDiagnostic").includes("normalized_amount_x_price")
  ).length;

  return [
    "| Source | Status | Notes |",
    "| --- | --- | --- |",
    `| ${source} | available | ${directRows} DEX buy row(s) after filtering. |`,
    `| ${priceSource} | ${normalized ? "available" : "partial"} | ${normalized} row(s) had raw amount plus decimals. |`,
    `| normalized USD value | ${priced ? "available" : "partial"} | ${priced} row(s) used normalized amount times token price. |`,
    "| wallet enrichment | partial | Repeated buy pattern inferred from trade count. Labels, retention, sell pressure, net worth, and second source were unavailable in this fallback. |",
  ].join("\n");
}

function readUsdNumber(row: Record<string, unknown>) {
  const formatted = readTextField(row, "netUsd");
  const direct = readNumberField(row, "netUsd");

  if (direct !== undefined) {
    return direct;
  }

  if (!formatted) {
    return 0;
  }

  const multiplier = formatted.toUpperCase().endsWith("M")
    ? 1_000_000
    : formatted.toUpperCase().endsWith("K")
      ? 1_000
      : 1;
  const parsed = Number(formatted.replace(/[$,KM]/gi, ""));

  return Number.isFinite(parsed) ? parsed * multiplier : 0;
}

function resolveSmartMoneyTarget(
  options: SurfOptions,
  query: string
): SmartMoneyTarget | undefined {
  const chain = normalizeChainId(options.chain || extractChainFromQuery(query));
  const table = surfDexTables[chain];
  const explicitSymbol = extractRequestedTokenSymbol(query, chain);
  const defaultTarget = defaultSmartMoneyTargets[chain];
  const requestedChainName = table?.chainName ?? titleCase(chain);

  if (options.tokenAddress) {
    return {
      chain,
      chainName: requestedChainName,
      id: `${chain}-token-address-${options.tokenAddress.toLowerCase()}`,
      projectName: explicitSymbol || "Token",
      requestedChain: chain,
      requestedChainName,
      resolution: "explicit-address",
      sqlPriceTable: table?.priceTable,
      sqlTable: table?.table,
      symbol: explicitSymbol,
      tokenAddress: options.tokenAddress,
      tokenAddressChainName: table?.chainName ?? titleCase(chain),
    };
  }

  if (
    explicitSymbol &&
    defaultTarget &&
    explicitSymbol.toUpperCase() === defaultTarget.symbol.toUpperCase()
  ) {
    const targetTable = surfDexTables[defaultTarget.sqlChain];
    const sourceChainName =
      targetTable?.chainName ?? titleCase(defaultTarget.sqlChain);
    const isExternalTokenSignal = defaultTarget.sqlChain !== chain;

    return {
      chain: defaultTarget.sqlChain,
      chainName: sourceChainName,
      externalTokenSignal: isExternalTokenSignal,
      id: `${chain}-${defaultTarget.symbol.toLowerCase()}-explicit`,
      projectName: defaultTarget.projectName,
      requestedChain: chain,
      requestedChainName,
      resolution: isExternalTokenSignal
        ? "external-token-signal"
        : "explicit-symbol",
      sqlPriceTable: targetTable?.priceTable,
      sqlTable: targetTable?.table,
      symbol: defaultTarget.symbol,
      tokenAddress: defaultTarget.tokenAddress,
      tokenAddressChainName:
        defaultTarget.tokenAddressChainName ??
        targetTable?.chainName ??
        titleCase(defaultTarget.sqlChain),
    };
  }

  if (explicitSymbol && table) {
    return {
      chain,
      chainName: table.chainName,
      id: `${chain}-symbol-${explicitSymbol.toLowerCase()}`,
      projectName: explicitSymbol,
      requestedChain: chain,
      requestedChainName: table.chainName,
      resolution: "explicit-symbol",
      sqlPriceTable: table.priceTable,
      sqlTable: table.table,
      symbol: explicitSymbol,
    };
  }

  if (table) {
    return {
      chain,
      chainName: table.chainName,
      id: `${chain}-broad-token-flow`,
      projectName: table.chainName,
      requestedChain: chain,
      requestedChainName: table.chainName,
      resolution: "broad-chain",
      sqlPriceTable: table.priceTable,
      sqlTable: table.table,
    };
  }

  return undefined;
}

function formatTargetLabel(target: SmartMoneyTarget | undefined) {
  if (!target) {
    return "EVM";
  }

  if (target.resolution === "broad-chain") {
    return target.chainName;
  }

  return `${target.chainName} ${target.symbol ?? "token"}`;
}

function normalizeChainId(value: string | undefined) {
  const normalized = value?.trim().toLowerCase() || "sui";
  const aliases: Record<string, string> = {
    arb: "arbitrum",
    "arbitrum one": "arbitrum",
    binance: "bnb",
    "binance smart chain": "bnb",
    bsc: "bnb",
    cello: "celo",
    eth: "ethereum",
    "ethereum mainnet": "ethereum",
    minipay: "celo",
  };

  return aliases[normalized] ?? normalized;
}

function extractChainFromQuery(query: string) {
  const normalized = query.toLowerCase();
  const chainTerms = [
    "arbitrum",
    "arbitrum one",
    "base",
    "bnb",
    "bsc",
    "binance smart chain",
    "celo",
    "cello",
    "ethereum",
    "eth",
    "hyperevm",
    "mantle",
    "minipay",
    "tron",
  ];

  return chainTerms.find((term) =>
    new RegExp(`\\b${escapeRegExp(term)}\\b`, "i").test(normalized)
  );
}

function extractRequestedTokenSymbol(query: string, chain: string) {
  const ticker = query.match(/\$([A-Z][A-Z0-9]{1,9})\b/)?.[1];

  if (ticker && !isGenericSymbol(ticker, chain)) {
    return ticker.toUpperCase();
  }

  const explicit = query.match(
    /\b(?:for|of|token|coin|asset)\s+([A-Z][A-Z0-9]{1,9})\b/
  )?.[1];

  if (explicit && !isGenericSymbol(explicit, chain)) {
    return explicit.toUpperCase();
  }

  const standalone = query.trim().match(/^([A-Z][A-Z0-9]{1,9})$/)?.[1];

  if (standalone && !isGenericSymbol(standalone, chain)) {
    return standalone.toUpperCase();
  }

  return undefined;
}

function isGenericSymbol(value: string, _chain: string) {
  const normalized = value.toUpperCase();

  return (
    ["AI", "API", "CEX", "DEX", "EVM", "TVL", "USD"].includes(
      normalized
    )
  );
}

function titleCase(value: string) {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeSqlString(value: string) {
  return value.replace(/'/g, "''");
}

function sqlStringList(values: string[]) {
  return values
    .map((value) => `'${escapeSqlString(value.toUpperCase())}'`)
    .join(", ");
}

function readSurfContent(data: SurfChatCompletionResponse) {
  return data.choices?.[0]?.message?.content?.trim() || "";
}

function parseJsonObject(text: string) {
  const trimmed = text.trim();
  const candidates = [
    trimmed,
    trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim(),
    trimmed.match(/\{[\s\S]*\}/)?.[0]?.trim(),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;

      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      continue;
    }
  }

  return undefined;
}

function normalizeRows(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => (item && typeof item === "object" ? item : undefined))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .filter((item) => {
      const wallet = readTextField(item, "wallet") || readTextField(item, "address");
      const signal = readTextField(item, "signal") || readTextField(item, "type");

      return Boolean(wallet || signal);
    })
    .slice(0, 20);
}

function normalizeSections(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => (item && typeof item === "object" ? item : undefined))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => ({
      markdown: readTextField(item, "markdown") || readTextField(item, "content"),
      title: readTextField(item, "title"),
    }))
    .filter((item) => item.title && item.markdown)
    .slice(0, 12);
}

function readTextField(record: Record<string, unknown>, key: string) {
  const value = record[key];

  return typeof value === "string" ? value.trim() : "";
}

function readNumberField(record: Record<string, unknown>, key: string) {
  const value = record[key];

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function shortenAddress(address: string) {
  return address.length > 12
    ? `${address.slice(0, 6)}...${address.slice(-4)}`
    : address;
}

function formatCompactTokenAmount(value: number) {
  return formatCompactNumber(value);
}

function formatCompactUsd(value: number) {
  return `$${formatCompactNumber(value)}`;
}

function formatCompactNumber(value: number) {
  const absolute = Math.abs(value);

  if (absolute >= 1_000_000) {
    return `${trimFixed(value / 1_000_000)}M`;
  }

  if (absolute >= 1_000) {
    return `${trimFixed(value / 1_000)}K`;
  }

  return trimFixed(value);
}

function trimFixed(value: number) {
  return value
    .toFixed(Math.abs(value) >= 100 ? 0 : 1)
    .replace(/\\.0$/, "");
}

function roundTokenAmount(value: number) {
  if (Math.abs(value) >= 1000) {
    return Math.round(value * 100) / 100;
  }

  return Math.round(value * 1_000_000) / 1_000_000;
}

async function runSurfCliJson({
  args,
  input,
  signal,
  timeoutMs,
}: {
  args: string[];
  input?: unknown;
  signal?: AbortSignal;
  timeoutMs: number;
}) {
  const cliPath = process.env.SURF_CLI_PATH?.trim() || "surf";
  const cliArgs = [
    ...args,
    "--json",
    "--quiet",
  ];

  return new Promise<unknown>((resolve, reject) => {
    const child = spawn(cliPath, cliArgs, {
      env: buildSurfCliEnv(),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let settled = false;
    let stdout = "";
    let stderr = "";
    const finish = (error?: Error, value?: unknown) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);

      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error("Surf CLI timed out."));
    }, timeoutMs);
    const abort = () => {
      child.kill("SIGTERM");
      finish(new Error("Surf CLI aborted."));
    };

    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish(error);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        const detail = parseSurfCliError(stdout) || compactText(stderr || stdout);

        finish(new Error(`Surf CLI failed. ${detail}`));
        return;
      }

      const parsed = parseJsonObject(stdout) ?? parseJsonObject(stderr);

      if (!parsed) {
        finish(new Error("Surf CLI did not return valid JSON."));
        return;
      }

      finish(undefined, parsed);
    });

    if (input !== undefined) {
      child.stdin.write(JSON.stringify(input));
    }

    child.stdin.end();
  });
}

function buildSurfCliEnv() {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
  };

  if (readBooleanEnv("SURF_CLI_CLEAR_API_ENV", true)) {
    delete env.SURF_API_KEY;
    delete env.ASKSURF_API_KEY;
  }

  return env;
}

function parseSurfCliError(stdout: string) {
  const parsed = parseJsonObject(stdout);
  const error = parsed?.error;

  if (!error || typeof error !== "object" || Array.isArray(error)) {
    return "";
  }

  const record = error as Record<string, unknown>;
  const code = readTextField(record, "code");
  const message = readTextField(record, "message");

  return [code, message].filter(Boolean).join(": ");
}

function shouldTrySurfCliFallback(error: unknown) {
  if (!readBooleanEnv("SURF_CLI_FALLBACK_ENABLED", process.env.NODE_ENV !== "production")) {
    return false;
  }

  const message = error instanceof Error ? error.message : String(error ?? "");

  return /402|PAID_BALANCE_ZERO|FREE_QUOTA_EXHAUSTED|INSUFFICIENT_CREDIT|insufficient credit|insufficient credits|balance/i.test(
    message
  );
}

function readBooleanEnv(name: string, fallback: boolean) {
  const value = process.env[name]?.trim().toLowerCase();

  if (!value) {
    return fallback;
  }

  if (["1", "true", "yes", "on"].includes(value)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(value)) {
    return false;
  }

  return fallback;
}

function readTimeout(name: string, fallback = 12000) {
  const value = Number(process.env[name]);

  return Number.isFinite(value) && value > 0 ? value : fallback;
}
