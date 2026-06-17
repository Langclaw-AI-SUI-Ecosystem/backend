import type { OnChainProviderResponse } from "../types";
import { compactText, fetchJson, requireEnv } from "./http";
import {
  getSuiCexTransferActivities,
  isBlockVisionEnabled,
} from "./sui-blockvision";
import { getSuiCexWithdrawalsFromRpc } from "./sui-rpc";

const baseUrl = "https://api.dune.com/api/v1";
const defaultPollIntervalMs = 1000;
const defaultTimeoutMs = 60000;

const externalTokenFallbackTargets: Record<
  string,
  Record<
    string,
    {
      chain: string;
      chainName: string;
      symbol: string;
      tokenAddress: string;
      tokenAddressChainName: string;
    }
  >
> = {
  mantle: {
    MNT: {
      chain: "ethereum",
      chainName: "Ethereum",
      symbol: "MNT",
      tokenAddress: "0x3c3a81e81dc49a522a592e7622a7e711c06bf354",
      tokenAddressChainName: "Ethereum",
    },
  },
};

type DuneOptions = {
  query?: string;
  queryId?: string;
  signal?: AbortSignal;
};

type DuneSmartMoneyOptions = {
  chain: string;
  minUsdOverride?: number;
  query?: string;
  rawQuery?: string;
  signal?: AbortSignal;
  tokenAddress?: string;
  windowDaysOverride?: number;
};

type SmartMoneySameScopeFallback = {
  chain: string;
  chainName: string;
  fallbackReason: string;
  minUsd: number;
  mode: "same-chain-relaxed";
  requestedChain: string;
  requestedChainName: string;
  windowDays: number;
};

type SmartMoneyExternalFallback = NonNullable<
  ReturnType<typeof resolveSmartMoneyFallbackTarget>
>;

type SmartMoneyFallbackTarget =
  | SmartMoneyExternalFallback
  | SmartMoneySameScopeFallback;

type SmartMoneyFallbackAttempt = {
  chain: string;
  minUsd: number;
  reason: string;
  route: string;
  rowCount: number;
  scope: "chain" | "token";
  status: "empty" | "success";
  windowDays: number;
};

type SuiCexLookupMeta = {
  checkedAddresses?: number;
  error?: string;
  minUsd: number;
  route:
    | "blockvision.account/activities"
    | "cex.addresses"
    | "sui.rpc.transaction_blocks"
    | "tokens_sui.transfers";
  rowCount: number;
  signalKind: "activity-flow" | "address-context" | "rpc-flow" | "transfer-flow";
  status: "failed" | "success";
  windowDays: number;
};

export async function getLatestResult(
  options: DuneOptions
): Promise<OnChainProviderResponse> {
  const queryId =
    options.queryId ||
    extractQueryId(options.query) ||
    process.env.DUNE_DEFAULT_QUERY_ID?.trim();

  if (!queryId) {
    throw new Error("A Dune query id is required. Set DUNE_DEFAULT_QUERY_ID or include one in the prompt.");
  }

  const sourceUrl = `${baseUrl}/query/${encodeURIComponent(queryId)}/results`;
  const data = await fetchJson(sourceUrl, {
    headers: {
      "X-Dune-API-Key": requireEnv("DUNE_API_KEY"),
    },
    signal: options.signal,
  });

  return {
    data,
    sourceUrl,
    summary: `Fetched latest Dune query result for query ${queryId}. ${compactText(data)}`,
  };
}

/**
 * Sui-native smart-money accumulation flow via Dune's curated `dex_sui.trades`
 * spellbook (the EVM `dex.trades`/`labels.addresses` tables have no Sui rows, but
 * `dex_sui.trades` is indexed: sender, amount_usd, token_bought/sold_*, blockchain
 * = 'sui'). Ranks senders by net USD deployed (bought - sold) over a recent
 * window — the Dune complement to BlockVision's holder snapshot. There are no
 * Dune smart-money labels for Sui, so rows are "top net DEX accumulators by
 * volume", surfaced honestly. Column aliases are double-quoted to keep the camel
 * case that the report row extractor (`collectStructuredRows`) expects.
 */
export async function getSuiAccumulationFlow(options: {
  chain?: string;
  query?: string;
  rawQuery?: string;
  signal?: AbortSignal;
  tokenAddress?: string;
  windowDays?: number;
}): Promise<OnChainProviderResponse> {
  const queryText = options.rawQuery ?? options.query ?? "";
  const windowDays =
    options.windowDays && options.windowDays > 0 && options.windowDays <= 90
      ? Math.trunc(options.windowDays)
      : extractWindowDays(queryText);
  const minUsd = extractMinUsd(queryText);
  const symbol = extractSuiSymbol(queryText);
  let spellbookError = "";
  let flowData: unknown;
  let flowRoute = "dex_sui.trades";
  let flowSourceUrl = "";
  let fallbackReason: string | undefined;

  try {
    const spellbook = await executeSuiDexSpellbookAccumulation({
      minUsd,
      signal: options.signal,
      symbol,
      windowDays,
    });
    const rows = readDuneRows(spellbook.data);

    if (rows.length) {
      flowData = spellbook.data;
      flowRoute = "dex_sui.trades";
      flowSourceUrl = spellbook.sourceUrl;
    }
  } catch (error) {
    spellbookError = error instanceof Error ? error.message : "dex_sui.trades failed.";
  }

  if (!flowData) {
    const events = await executeSuiEventAccumulation({
      minUsd,
      signal: options.signal,
      symbol,
      windowDays,
    });

    flowData = events.data;
    flowRoute = "sui.events.cetus_swap";
    flowSourceUrl = events.sourceUrl;
    fallbackReason = spellbookError
      ? `dex_sui.trades was unavailable, so the workflow used Sui event fallback. ${spellbookError}`
      : "dex_sui.trades returned no rows, so the workflow used Sui event fallback.";
  }

  const cexLookup = await trySuiCexTransferFlow({
    minUsd,
    signal: options.signal,
    symbol,
    windowDays,
  });
  const data = cexLookup.rows.length
    ? appendSmartMoneyRows(flowData, cexLookup.rows)
    : flowData;

  return buildSuiAccumulationResponse({
    cexLookup: cexLookup.meta,
    data,
    fallbackReason,
    minUsd,
    route: flowRoute,
    sourceUrl: flowSourceUrl,
    symbol,
    windowDays,
  });
}

function extractSuiSymbol(text: string) {
  const raw =
    text.match(/\$([a-zA-Z][a-zA-Z0-9_]{1,19})\b/)?.[1] ||
    text.match(/\b(?:for|of|token|coin|asset)\s+\$?([a-zA-Z][a-zA-Z0-9_]{1,19})\b/i)?.[1];
  const cleaned = raw?.toUpperCase().replace(/[^A-Z0-9_]/g, "");
  return cleaned && cleaned.length >= 2 ? cleaned : "";
}

async function executeSuiDexSpellbookAccumulation({
  minUsd,
  signal,
  symbol,
  windowDays,
}: {
  minUsd: number;
  signal?: AbortSignal;
  symbol: string;
  windowDays: number;
}) {
  const tokenFilter = symbol
    ? `AND upper(token_bought_symbol) = '${escapeSqlLiteral(symbol)}'`
    : "";
  const sql = `
WITH dex_buys AS (
  SELECT
    concat('0x', lower(to_hex(sender))) AS wallet,
    upper(token_bought_symbol) AS tokenSymbol,
    try_cast(token_bought_amount AS double) AS amount,
    try_cast(amount_usd AS double) AS amount_usd,
    block_time
  FROM dex_sui.trades
  WHERE blockchain = 'sui'
    AND block_time >= date_add('day', -${windowDays}, current_timestamp)
    AND token_bought_symbol IS NOT NULL
    AND token_bought_amount IS NOT NULL
    AND amount_usd IS NOT NULL
    AND amount_usd >= ${minUsd}
    ${tokenFilter}
),
grouped AS (
  SELECT
    wallet,
    tokenSymbol,
    sum(amount) AS amount,
    sum(amount_usd) AS netUsd,
    count(*) AS trades,
    min(block_time) AS first_seen,
    max(block_time) AS last_seen
  FROM dex_buys
  WHERE amount IS NOT NULL
    AND amount > 0
  GROUP BY 1, 2
  HAVING sum(amount_usd) >= ${minUsd}
)
SELECT
  wallet,
  tokenSymbol,
  'DEX buy' AS signal,
  round(amount, 6) AS amount,
  round(netUsd, 2) AS netUsd,
  trades,
  cast(cast(first_seen AS date) AS varchar) || ' to ' || cast(cast(last_seen AS date) AS varchar) AS window,
  'large_flow_watchlist' AS smartMoneyStatus,
  'non-stable token accumulation' AS tokenCategory,
  'unavailable' AS walletLabel,
  'unavailable' AS walletType,
  'unavailable' AS walletNetWorth,
  'unavailable' AS retentionAfterBuy,
  'unavailable' AS sellPressureAfterBuy,
  'Sui' AS sourceChain,
  'dex_sui.trades' AS sourceTable,
  'Dune Sui DEX spellbook | wallet labels unavailable | retention unavailable' AS dataSourceDiagnostic
FROM grouped
ORDER BY netUsd DESC
LIMIT 25`.trim();

  return executeDuneSql({ signal, sql });
}

async function executeSuiEventAccumulation({
  minUsd,
  signal,
  symbol,
  windowDays,
}: {
  minUsd: number;
  signal?: AbortSignal;
  symbol: string;
  windowDays: number;
}) {
  const minRawAmount = Math.max(minUsd, 1000);
  const tokenLabel = symbol || "CETUS_POOL";
  const sql = `
WITH cetus_swaps AS (
  SELECT
    concat('0x', lower(to_hex(sender))) AS wallet,
    json_extract_scalar(event_json, '$.pool') AS pool,
    try_cast(json_extract_scalar(event_json, '$.amount_in') AS double) AS amount_in,
    try_cast(json_extract_scalar(event_json, '$.amount_out') AS double) AS amount_out,
    transaction_digest,
    date
  FROM sui.events
  WHERE date >= current_date - interval '${windowDays}' day
    AND event_type = '0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb::pool::SwapEvent'
),
grouped AS (
  SELECT
    wallet,
    coalesce(pool, 'unknown_pool') AS pool,
    sum(amount_in) AS grossAmountInRaw,
    sum(amount_out) AS grossAmountOutRaw,
    count(DISTINCT transaction_digest) AS trades,
    min(date) AS first_date,
    max(date) AS last_date
  FROM cetus_swaps
  WHERE amount_in IS NOT NULL
    AND amount_out IS NOT NULL
    AND amount_in > 0
  GROUP BY 1, 2
  HAVING sum(amount_in) >= ${minRawAmount}
)
SELECT
  wallet,
  '${escapeSqlLiteral(tokenLabel)}' AS tokenSymbol,
  pool,
  'DEX buy' AS signal,
  'raw in ' || cast(cast(grossAmountInRaw AS decimal(38, 0)) AS varchar) ||
    ' / raw out ' || cast(cast(grossAmountOutRaw AS decimal(38, 0)) AS varchar) AS netToken,
  null AS netUsd,
  trades,
  cast(first_date AS varchar) || ' to ' || cast(last_date AS varchar) AS window,
  'large_flow_watchlist' AS smartMoneyStatus,
  'non-stable token accumulation' AS tokenCategory,
  'unavailable' AS walletLabel,
  'unavailable' AS walletType,
  'unavailable' AS walletNetWorth,
  'unavailable' AS retentionAfterBuy,
  'unavailable' AS sellPressureAfterBuy,
  'Sui' AS sourceChain,
  'sui.events Cetus SwapEvent' AS sourceTable,
  'Dune Sui event fallback | raw amounts only | token metadata unavailable' AS dataSourceDiagnostic
FROM grouped
ORDER BY grossAmountInRaw DESC
LIMIT 25`.trim();

  return executeDuneSql({ signal, sql });
}

async function trySuiCexTransferFlow({
  minUsd,
  signal,
  symbol,
  windowDays,
}: {
  minUsd: number;
  signal?: AbortSignal;
  symbol: string;
  windowDays: number;
}): Promise<{
  meta: SuiCexLookupMeta;
  rows: unknown[];
}> {
  const metaBase = {
    minUsd,
    route: "tokens_sui.transfers" as const,
    signalKind: "transfer-flow" as const,
    windowDays,
  };

  try {
    const result = await executeSuiCexTransferFlow({
      minUsd,
      signal,
      symbol,
      windowDays,
    });
    const rows = readResultRows(result.data);

    return {
      meta: {
        ...metaBase,
        rowCount: rows.length,
        status: "success",
      },
      rows,
    };
  } catch (error) {
    const transferError = error instanceof Error
      ? error.message
      : "Sui CEX transfer lookup failed.";
    let blockVisionError = "";

    try {
      const context = await executeSuiCexAddressContext({ signal });
      const rows = readResultRows(context.data);

      if (rows.length && isBlockVisionEnabled()) {
        try {
          const activity = await getSuiCexTransferActivities({
            addresses: rows as Array<Record<string, unknown>>,
            minUsd,
            signal,
            symbol,
            windowDays,
          });

          if (activity.rows.length) {
            return {
              meta: {
                checkedAddresses: activity.checkedAddresses,
                error: transferError,
                minUsd,
                route: "blockvision.account/activities",
                rowCount: activity.rows.length,
                signalKind: "activity-flow",
                status: "success",
                windowDays,
              },
              rows: activity.rows,
            };
          }

          blockVisionError =
            `BlockVision account/activities returned 0 candidate row(s) from ${activity.checkedAddresses} CEX address(es).`;
        } catch (activityError) {
          blockVisionError = activityError instanceof Error
            ? activityError.message
            : "BlockVision account/activities failed.";
        }
      }

      if (rows.length) {
        try {
          const rpcActivity = await getSuiCexWithdrawalsFromRpc({
            addresses: rows as Array<Record<string, unknown>>,
            minUsd,
            signal,
            symbol,
            windowDays,
          });

          if (rpcActivity.rows.length) {
            return {
              meta: {
                checkedAddresses: rpcActivity.checkedAddresses,
                error: blockVisionError
                  ? `${transferError} ${blockVisionError}`
                  : transferError,
                minUsd,
                route: "sui.rpc.transaction_blocks",
                rowCount: rpcActivity.rows.length,
                signalKind: "rpc-flow",
                status: "success",
                windowDays,
              },
              rows: rpcActivity.rows,
            };
          }

          blockVisionError = blockVisionError
            ? `${blockVisionError} Sui RPC withdrawal scan returned 0 candidate row(s) from ${rpcActivity.checkedAddresses} CEX address(es).`
            : `Sui RPC withdrawal scan returned 0 candidate row(s) from ${rpcActivity.checkedAddresses} CEX address(es).`;
        } catch (rpcError) {
          const rpcMessage = rpcError instanceof Error
            ? rpcError.message
            : "Sui RPC withdrawal scan failed.";
          blockVisionError = blockVisionError
            ? `${blockVisionError} ${rpcMessage}`
            : rpcMessage;
        }
      }

      return {
        meta: {
          error: blockVisionError
            ? `${transferError} ${blockVisionError}`
            : transferError,
          minUsd,
          route: "cex.addresses",
          rowCount: rows.length,
          signalKind: "address-context",
          status: "success",
          windowDays,
        },
        rows,
      };
    } catch (contextError) {
      return {
        meta: {
          error: contextError instanceof Error
            ? `${transferError} CEX address context also failed: ${contextError.message}`
            : transferError,
          ...metaBase,
          rowCount: 0,
          status: "failed",
        },
        rows: [],
      };
    }
  }
}

async function executeSuiCexAddressContext({
  signal,
}: {
  signal?: AbortSignal;
}) {
  const sql = `
SELECT
  address AS wallet,
  cex_name AS sourceCex,
  distinct_name AS walletLabel,
  'CEX address label' AS signal,
  'CEX address context' AS tokenCategory,
  'excluded_address' AS smartMoneyStatus,
  'Sui' AS sourceChain,
  'cex.addresses' AS sourceTable,
  'current Dune cex.addresses snapshot' AS window,
  'Dune Sui CEX address context | label-only | transfer flow unavailable' AS dataSourceDiagnostic
FROM cex.addresses
WHERE blockchain = 'sui'
ORDER BY cex_name, distinct_name
LIMIT 10`.trim();

  return executeDuneSql({ signal, sql });
}

async function executeSuiCexTransferFlow({
  minUsd,
  signal,
  symbol,
  windowDays,
}: {
  minUsd: number;
  signal?: AbortSignal;
  symbol: string;
  windowDays: number;
}) {
  const sql = buildSuiCexTransferSql({
    minUsd,
    symbol,
    windowDays,
  });

  return executeDuneSql({ signal, sql });
}

function buildSuiCexTransferSql({
  minUsd,
  symbol,
  windowDays,
}: {
  minUsd: number;
  symbol: string;
  windowDays: number;
}) {
  const tokenFilter = symbol
    ? `AND upper(transfer.symbol) = '${escapeSqlLiteral(symbol)}'`
    : "";

  return `
WITH cex_labels AS (
  SELECT
    address,
    regexp_replace(name, '\\s+[0-9]+$', '') AS source_cex
  FROM labels.addresses
  WHERE blockchain = 'sui'
    AND (
      lower(category) = 'cex'
      OR regexp_like(lower(name), 'binance|coinbase|okx|bybit|kucoin|gate\\.?io|kraken|mexc|bitget|upbit|crypto\\.?com|htx|huobi')
    )
),
transfers AS (
  SELECT
    CASE
      WHEN transfer."from" = label.address THEN transfer."to"
      ELSE transfer."from"
    END AS wallet,
    label.source_cex,
    upper(transfer.symbol) AS tokenSymbol,
    CASE
      WHEN transfer."from" = label.address THEN 'CEX withdrawal'
      ELSE 'CEX deposit'
    END AS signal,
    transfer.amount,
    transfer.amount_usd,
    transfer.block_time,
    transfer.tx_digest
  FROM tokens_sui.transfers transfer
  JOIN cex_labels label
    ON transfer."from" = label.address
    OR transfer."to" = label.address
  WHERE transfer.blockchain = 'sui'
    AND transfer.block_date >= current_date - interval '${windowDays}' day
    AND transfer.block_time >= date_add('day', -${windowDays}, current_timestamp)
    AND transfer.amount > 0
    AND transfer.amount_usd IS NOT NULL
    AND transfer.amount_usd >= ${minUsd}
    AND transfer.symbol IS NOT NULL
    AND transfer.is_supply_event = false
    ${tokenFilter}
),
grouped AS (
  SELECT
    wallet,
    source_cex,
    tokenSymbol,
    signal,
    SUM(amount) AS amount,
    SUM(amount_usd) AS netUsd,
    COUNT(DISTINCT tx_digest) AS transfers,
    MIN(block_time) AS first_seen,
    MAX(block_time) AS last_seen
  FROM transfers
  GROUP BY 1, 2, 3, 4
  HAVING SUM(amount_usd) >= ${minUsd}
)
SELECT
  concat('0x', lower(to_hex(wallet))) AS wallet,
  tokenSymbol,
  signal,
  round(amount, 6) AS amount,
  round(netUsd, 2) AS netUsd,
  CAST(NULL AS BIGINT) AS trades,
  transfers,
  cast(cast(first_seen AS date) AS varchar) || ' to ' || cast(cast(last_seen AS date) AS varchar) AS window,
  CASE
    WHEN signal = 'CEX withdrawal' THEN 'candidate_smart_money'
    ELSE 'sell_pressure_watchlist'
  END AS smartMoneyStatus,
  CASE
    WHEN signal = 'CEX withdrawal' THEN 'cex exchange outflow'
    ELSE 'cex sell-pressure flow'
  END AS tokenCategory,
  'unavailable' AS walletLabel,
  'unavailable' AS walletType,
  'unavailable' AS walletNetWorth,
  'unavailable' AS retentionAfterBuy,
  'unavailable' AS sellPressureAfterBuy,
  source_cex AS sourceCex,
  'Sui' AS sourceChain,
  'tokens_sui.transfers + labels.addresses' AS sourceTable,
  'Dune Sui CEX transfer lookup | exchange labels only | retention unavailable' AS dataSourceDiagnostic
FROM grouped
ORDER BY
  CASE
    WHEN signal = 'CEX withdrawal' THEN 1
    ELSE 2
  END,
  netUsd DESC
LIMIT 25`.trim();
}

function buildSuiAccumulationResponse({
  cexLookup,
  data,
  fallbackReason,
  minUsd,
  route,
  sourceUrl,
  symbol,
  windowDays,
}: {
  cexLookup?: SuiCexLookupMeta;
  data: unknown;
  fallbackReason?: string;
  minUsd: number;
  route: string;
  sourceUrl: string;
  symbol: string;
  windowDays: number;
}): OnChainProviderResponse {
  const rows = readDuneRows(data);
  const scope = symbol ? `${symbol} on Sui` : "Sui DEX flow";
  const dexRows = rows.filter((row) => /dex buy/i.test(String(row.signal ?? "")));
  const top = rows[0];
  const decorated = decorateSuiAccumulationData(data, {
    cexLookup,
    fallbackReason,
    minUsd,
    route,
    symbol,
    windowDays,
  });
  const cexSummary = summarizeSuiCexLookup(cexLookup, rows);
  const summary =
    rows.length === 0
      ? `Dune ${route} returned no Sui accumulation rows for ${scope} over ${windowDays} day(s). ${cexSummary}`
      : `Dune ${route} returned ${dexRows.length || rows.length} Sui DEX accumulation row(s) for ${scope} over ${windowDays} day(s). ${cexSummary}` +
        summarizeSuiTopRow(top) +
        "DEX rows are large-flow watchlist entries because Sui wallet labels, retention, sell pressure, and second-source checks are unavailable in this route. CEX withdrawals are candidate accumulation context until labels and retention support them. CEX deposits are sell-pressure context. " +
        (fallbackReason ? `${fallbackReason} ` : "") +
        compactText(rows.slice(0, 5));

  return {
    data: decorated,
    sourceUrl,
    summary,
  };
}

function decorateSuiAccumulationData(
  data: unknown,
  meta: {
    cexLookup?: SuiCexLookupMeta;
    fallbackReason?: string;
    minUsd: number;
    route: string;
    symbol: string;
    windowDays: number;
  }
) {
  const record = asRecord(data) ?? {};

  return {
    ...record,
    routeDebug: {
      confidence: 0.66,
      cexRoute: meta.cexLookup,
      fallbackReason: meta.fallbackReason,
      finalStatus: readDuneRows(data).length ? "success" : "empty",
      metrics: meta.cexLookup?.status === "success"
        ? ["sui dex buys", "sui cex transfers", "wallet-flow rows", "large-flow watchlist"]
        : ["sui dex buys", "wallet-flow rows", "large-flow watchlist"],
      primaryRoute: {
        chain: "sui",
        minUsd: meta.minUsd,
        route: meta.route,
        scope: meta.symbol ? "token" : "chain",
        windowDays: meta.windowDays,
      },
      selectedRoute: meta.route,
    },
    target: {
      chain: "sui",
      chainName: "Sui",
      mode: "broad-chain",
      requestedChain: "sui",
      requestedChainName: "Sui",
      resolution: "broad-chain",
      symbol: meta.symbol || undefined,
    },
  };
}

function summarizeSuiCexLookup(
  lookup: SuiCexLookupMeta | undefined,
  rows: Array<Record<string, unknown>>
) {
  if (!lookup) {
    return "";
  }

  if (lookup.status === "failed") {
    return "Sui CEX transfer lookup was unavailable. ";
  }

  if (lookup.signalKind === "address-context") {
    return lookup.rowCount
      ? `Sui CEX transfer lookup was unavailable, so Dune cex.addresses added ${lookup.rowCount} exchange-label context row(s). `
      : "Sui CEX transfer lookup was unavailable and Dune cex.addresses returned 0 exchange-label context row(s). ";
  }

  const withdrawals = rows.filter((row) =>
    /cex withdrawal/i.test(String(row.signal ?? ""))
  ).length;
  const deposits = rows.filter((row) =>
    /cex deposit/i.test(String(row.signal ?? ""))
  ).length;

  const source = lookup.signalKind === "activity-flow"
    ? `BlockVision account activity across ${lookup.checkedAddresses ?? "labeled"} CEX address(es)`
    : lookup.signalKind === "rpc-flow"
      ? `Sui RPC withdrawal scan across ${lookup.checkedAddresses ?? "labeled"} CEX address(es)`
    : "Sui CEX transfer lookup";

  return lookup.rowCount
    ? `${source} added ${lookup.rowCount} exchange-flow row(s): ${withdrawals} withdrawal row(s), ${deposits} deposit row(s). `
    : "Sui CEX transfer lookup returned 0 exchange-flow row(s). ";
}

function summarizeSuiTopRow(row: Record<string, unknown> | undefined) {
  if (!row) {
    return "";
  }

  const wallet = String(row.wallet ?? "unknown wallet").slice(0, 12);
  const token = String(row.tokenSymbol ?? row.token ?? "token");
  const usd = Number(row.netUsd);
  const usdText = Number.isFinite(usd) && usd > 0
    ? ` with about $${Math.round(usd).toLocaleString()} net DEX buy value`
    : "";

  return `Top row ${wallet}... on ${token}${usdText}. `;
}

function readDuneRows(data: unknown): Array<Record<string, unknown>> {
  const rows = (data as { result?: { rows?: unknown } } | undefined)?.result?.rows;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

export async function getSmartMoneyDexBuyCandidates(
  options: DuneSmartMoneyOptions
): Promise<OnChainProviderResponse> {
  const queryText = options.rawQuery ?? options.query;
  const explicitQueryId = extractQueryId(queryText);

  if (explicitQueryId) {
    return getLatestResult({
      queryId: explicitQueryId,
      signal: options.signal,
    });
  }

  const primary = await executeSmartMoneyFlowSql(options);
  const primaryRowCount = readResultRows(primary.data).length;
  const sameScopeFallback = primaryRowCount
    ? undefined
    : resolveSameScopeRelaxedFallback(options);
  const fallbackAttempts: SmartMoneyFallbackAttempt[] = [];

  if (sameScopeFallback) {
    const fallback = await executeSmartMoneyFlowSql({
      ...options,
      chain: sameScopeFallback.chain,
      minUsdOverride: sameScopeFallback.minUsd,
      windowDaysOverride: sameScopeFallback.windowDays,
    });
    const fallbackRows = readResultRows(fallback.data).length;
    fallbackAttempts.push({
      chain: sameScopeFallback.chain,
      minUsd: sameScopeFallback.minUsd,
      reason: sameScopeFallback.fallbackReason,
      route: "dune.smart_money_sql.same_chain_relaxed",
      rowCount: fallbackRows,
      scope: "chain",
      status: fallbackRows ? "success" : "empty",
      windowDays: sameScopeFallback.windowDays,
    });

    if (fallbackRows) {
      const augmented = await addSupplementalExternalCexTransfers({
        data: addSmartMoneyTargetMeta(fallback.data, {
          ...sameScopeFallback,
          fallbackRows,
        }),
        fallbackAttempts,
        options,
        selectedRoute: "dune.smart_money_sql.same_chain_relaxed",
      });
      const fallbackData = addSmartMoneyRouteDebug(
        augmented.data,
        buildSmartMoneyRouteDebug({
          fallbackAttempts,
          options,
          selectedRoute: "dune.smart_money_sql.same_chain_relaxed",
        })
      );

      return {
        data: fallbackData,
        sourceUrl: fallback.sourceUrl,
        summary:
          `Executed dynamic Dune smart-money DEX and CEX flow SQL for ${normalizeDuneChain(options.chain)} and returned 0 row(s), then retried the same chain with ${sameScopeFallback.windowDays} days and minimum $${sameScopeFallback.minUsd} and returned ${fallbackRows} row(s).${augmented.summarySuffix} ${compactText(fallbackData)}`,
      };
    }
  }

  const fallbackTarget = primaryRowCount
    ? undefined
    : resolveSmartMoneyFallbackTarget(options);

  if (fallbackTarget) {
    const fallback = await executeSmartMoneyFlowSql({
      ...options,
      chain: fallbackTarget.chain,
      tokenAddress: fallbackTarget.tokenAddress,
    });
    const fallbackRows = readResultRows(fallback.data).length;
    fallbackAttempts.push({
      chain: fallbackTarget.chain,
      minUsd: describeSmartMoneySqlParams({
        ...options,
        chain: fallbackTarget.chain,
        tokenAddress: fallbackTarget.tokenAddress,
      }).minUsd,
      reason: fallbackTarget.fallbackReason,
      route: "dune.smart_money_sql.external_token_signal",
      rowCount: fallbackRows,
      scope: "token",
      status: fallbackRows ? "success" : "empty",
      windowDays: describeSmartMoneySqlParams({
        ...options,
        chain: fallbackTarget.chain,
        tokenAddress: fallbackTarget.tokenAddress,
      }).windowDays,
    });
    const augmented = await addSupplementalExternalCexTransfers({
      data: addSmartMoneyTargetMeta(fallback.data, fallbackTarget),
      fallbackAttempts,
      options,
      selectedRoute: "dune.smart_money_sql.external_token_signal",
    });
    const fallbackData = addSmartMoneyRouteDebug(
      augmented.data,
      buildSmartMoneyRouteDebug({
        fallbackAttempts,
        options,
        selectedRoute: "dune.smart_money_sql.external_token_signal",
      })
    );

    if (fallbackRows) {
      return {
        data: fallbackData,
        sourceUrl: fallback.sourceUrl,
        summary:
          `Executed dynamic Dune smart-money DEX and CEX flow SQL for ${normalizeDuneChain(options.chain)} and returned 0 row(s), then used ${fallbackTarget.tokenAddressChainName} ${fallbackTarget.symbol} as an external low-confidence token signal and returned ${fallbackRows} row(s).${augmented.summarySuffix} ${compactText(fallbackData)}`,
      };
    }

    return {
      data: addSmartMoneyRouteDebug(
        addSmartMoneyTargetMeta(primary.data, {
          ...fallbackTarget,
          fallbackRows,
        }),
        buildSmartMoneyRouteDebug({
          fallbackAttempts,
          options,
          selectedRoute: "dune.smart_money_sql.primary",
        })
      ),
      sourceUrl: primary.sourceUrl,
      summary:
        `Executed dynamic Dune smart-money DEX and CEX flow SQL for ${normalizeDuneChain(options.chain)} and returned 0 row(s). ${fallbackTarget.tokenAddressChainName} ${fallbackTarget.symbol} external token fallback also returned 0 row(s). ${compactText(primary.data)}`,
    };
  }

  const augmented = await addSupplementalExternalCexTransfers({
    data: primary.data,
    fallbackAttempts,
    options,
    selectedRoute: "dune.smart_money_sql.primary",
  });

  return {
    data: addSmartMoneyRouteDebug(
      augmented.data,
      buildSmartMoneyRouteDebug({
        fallbackAttempts,
        options,
        selectedRoute: "dune.smart_money_sql.primary",
      })
    ),
    sourceUrl: primary.sourceUrl,
    summary:
      primaryRowCount
        ? `Executed dynamic Dune smart-money DEX and CEX flow SQL for ${normalizeDuneChain(options.chain)} and returned ${primaryRowCount} row(s).${augmented.summarySuffix} ${compactText(augmented.data)}`
        : sameScopeFallback
          ? `Executed dynamic Dune smart-money DEX and CEX flow SQL for ${normalizeDuneChain(options.chain)} and returned 0 row(s), then same-chain relaxed fallback also returned 0 row(s).${augmented.summarySuffix} ${compactText(augmented.data)}`
          : `Executed dynamic Dune smart-money DEX and CEX flow SQL for ${normalizeDuneChain(options.chain)} and returned ${primaryRowCount} row(s).${augmented.summarySuffix} ${compactText(augmented.data)}`,
  };
}

async function executeSmartMoneyFlowSql(
  options: DuneSmartMoneyOptions
): Promise<{
  data: unknown;
  sourceUrl: string;
}> {
  const sql = buildSmartMoneyFlowSql(options);

  return executeDuneSql({
    signal: options.signal,
    sql,
  });
}

async function executeDuneSql({
  signal,
  sql,
}: {
  signal?: AbortSignal;
  sql: string;
}): Promise<{
  data: unknown;
  sourceUrl: string;
}> {
  const apiKey = requireEnv("DUNE_API_KEY");
  const performance = readDunePerformance();
  const execution = await fetchJson(`${baseUrl}/sql/execute`, {
    body: JSON.stringify({
      ...(performance ? { performance } : {}),
      sql,
    }),
    headers: {
      "Content-Type": "application/json",
      "X-Dune-API-Key": apiKey,
    },
    method: "POST",
    signal,
    timeoutMs: 30000,
  });
  const executionId = readExecutionId(execution);

  if (!executionId) {
    throw new Error("Dune SQL execution did not return an execution_id.");
  }

  await waitForExecution({
    apiKey,
    executionId,
    signal,
  });

  const sourceUrl = `${baseUrl}/execution/${encodeURIComponent(executionId)}/results`;
  const data = await fetchJson(sourceUrl, {
    headers: {
      "X-Dune-API-Key": apiKey,
    },
    signal,
    timeoutMs: 30000,
  });

  return {
    data,
    sourceUrl,
  };
}

function resolveSmartMoneyFallbackTarget(options: DuneSmartMoneyOptions) {
  const chain = normalizeDuneChain(options.chain);
  const queryText = options.rawQuery ?? options.query ?? "";
  const symbol = extractTokenSymbol(queryText, chain);

  if (!externalTokenFallbackTargets[chain] || options.tokenAddress) {
    return undefined;
  }

  if (!symbol) {
    return undefined;
  }
  const fallback = externalTokenFallbackTargets[chain]?.[symbol.toUpperCase()];

  if (!fallback) {
    return undefined;
  }
  const requestedChainName = titleCase(chain);

  return {
    chain: fallback.chain,
    chainName: fallback.chainName,
    externalTokenSignal: fallback.chain !== chain,
    fallbackReason:
      `The user explicitly requested ${fallback.symbol} token context. ${requestedChainName} chain-level Dune wallet-flow rows were empty, so the workflow used ${fallback.tokenAddressChainName} ${fallback.symbol} token flow as an external low-confidence signal, not ${requestedChainName} chain activity.`,
    mode: fallback.chain === chain ? "explicit-token" : "external-token-signal",
    requestedChain: chain,
    requestedChainName,
    symbol: fallback.symbol,
    tokenAddress: fallback.tokenAddress,
    tokenAddressChainName: fallback.tokenAddressChainName,
  };
}

async function addSupplementalExternalCexTransfers({
  data,
  fallbackAttempts,
  options,
  selectedRoute,
}: {
  data: unknown;
  fallbackAttempts: SmartMoneyFallbackAttempt[];
  options: DuneSmartMoneyOptions;
  selectedRoute: string;
}) {
  const target = resolveExternalCexTransferTarget(options);

  if (!target || hasCexWithdrawalRows(data)) {
    return {
      data,
      summarySuffix: "",
    };
  }

  const cexParams = describeExternalCexTransferParams(options);
  const cexResult = await executeExternalCexTransferSql({
    minUsd: cexParams.minUsd,
    signal: options.signal,
    target,
    windowDays: cexParams.windowDays,
  });
  const rows = readResultRows(cexResult.data);

  fallbackAttempts.push({
    chain: target.chain,
    minUsd: cexParams.minUsd,
    reason: target.fallbackReason,
    route: "dune.smart_money_sql.external_cex_transfers",
    rowCount: rows.length,
    scope: "token",
    status: rows.length ? "success" : "empty",
    windowDays: cexParams.windowDays,
  });

  if (!rows.length) {
    return {
      data,
      summarySuffix:
        ` Supplemental ${target.tokenAddressChainName} ${target.symbol} CEX transfer lookup returned 0 row(s).`,
    };
  }

  return {
    data: addSmartMoneyTargetMeta(appendSmartMoneyRows(data, rows), {
      ...target,
      fallbackRows: rows.length,
    }),
    summarySuffix:
      ` Supplemental ${target.tokenAddressChainName} ${target.symbol} CEX transfer lookup returned ${rows.length} row(s) as external low-confidence context.`,
  };
}

function resolveExternalCexTransferTarget(options: DuneSmartMoneyOptions) {
  const chain = normalizeDuneChain(options.chain);
  const queryText = options.rawQuery ?? options.query ?? "";
  const symbol = extractTokenSymbol(queryText, chain);
  const fallback = symbol
    ? externalTokenFallbackTargets[chain]?.[symbol.toUpperCase()]
    : resolveDefaultExternalTokenTarget(chain);

  if (!fallback || options.tokenAddress) {
    return undefined;
  }

  const requestedChainName = titleCase(chain);

  if (fallback.chain === chain) {
    return undefined;
  }

  return {
    chain: fallback.chain,
    chainName: fallback.chainName,
    externalTokenSignal: true,
    fallbackReason:
      `Supplemental CEX withdrawal context uses ${fallback.tokenAddressChainName} ${fallback.symbol} token transfers because ${requestedChainName} native CEX flow rows were unavailable. This is external token context, not ${requestedChainName} chain-level activity.`,
    mode: "external-token-signal",
    requestedChain: chain,
    requestedChainName,
    symbol: fallback.symbol,
    tokenAddress: fallback.tokenAddress,
    tokenAddressChainName: fallback.tokenAddressChainName,
  };
}

function resolveDefaultExternalTokenTarget(chain: string) {
  const targets = Object.values(externalTokenFallbackTargets[chain] ?? {});

  return targets.length === 1 ? targets[0] : undefined;
}

function hasCexWithdrawalRows(data: unknown) {
  return readResultRows(data).some((row) => {
    const record = asRecord(row);
    const signal = typeof record?.signal === "string" ? record.signal : "";

    return /cex withdrawal/i.test(signal);
  });
}

function appendSmartMoneyRows(data: unknown, rows: unknown[]) {
  if (!rows.length || !data || typeof data !== "object" || Array.isArray(data)) {
    return data;
  }

  const record = data as Record<string, unknown>;
  const result = asRecord(record.result);
  const existingRows = readResultRows(data);

  if (result) {
    return {
      ...record,
      result: {
        ...result,
        rows: [...existingRows, ...rows],
      },
    };
  }

  return {
    ...record,
    result: {
      rows: [...existingRows, ...rows],
    },
  };
}

async function executeExternalCexTransferSql({
  minUsd,
  signal,
  target,
  windowDays,
}: {
  minUsd: number;
  signal?: AbortSignal;
  target: NonNullable<ReturnType<typeof resolveExternalCexTransferTarget>>;
  windowDays: number;
}) {
  const sql = buildExternalCexTransferSql({
    minUsd,
    target,
    windowDays,
  });

  return executeDuneSql({
    signal,
    sql,
  });
}

function addSmartMoneyTargetMeta(
  data: unknown,
  target: SmartMoneyFallbackTarget & {
    fallbackRows?: number;
  }
) {
  if (!target || !data || typeof data !== "object" || Array.isArray(data)) {
    return data;
  }

  return {
    ...(data as Record<string, unknown>),
    target,
  };
}

function addSmartMoneyRouteDebug(
  data: unknown,
  routeDebug: ReturnType<typeof buildSmartMoneyRouteDebug>
) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return data;
  }

  return {
    ...(data as Record<string, unknown>),
    routeDebug,
  };
}

function buildSmartMoneyRouteDebug({
  fallbackAttempts,
  options,
  selectedRoute,
}: {
  fallbackAttempts: SmartMoneyFallbackAttempt[];
  options: DuneSmartMoneyOptions;
  selectedRoute: string;
}) {
  const chain = normalizeDuneChain(options.chain);
  const queryText = options.rawQuery ?? options.query ?? "";
  const symbol = normalizeTokenAddress(options.tokenAddress)
    ? undefined
    : extractTokenSymbol(queryText, chain);
  const params = describeSmartMoneySqlParams(options);
  const blockedFallbacks = symbol
    ? []
    : [
        "Blocked token-level fallback because the request is chain-level and no token was explicitly requested.",
      ];

  return {
    blockedFallbacks,
    confidence: symbol || options.tokenAddress ? 0.82 : 0.86,
    entities: [
      { type: "chain", value: chain },
      ...(symbol ? [{ type: "token", value: symbol.toUpperCase() }] : []),
      ...(options.tokenAddress
        ? [{ type: "tokenAddress", value: options.tokenAddress.toLowerCase() }]
        : []),
    ],
    fallbackAttempts,
    finalStatus: fallbackAttempts.some((attempt) => attempt.status === "success")
      ? "success"
      : "empty",
    intent: "smart-money",
    metrics: ["dex buys", "cex flows", "wallet-flow rows"],
    normalizedQuery: queryText || null,
    originalQuery: options.rawQuery ?? options.query ?? null,
    preservationCheck:
      fallbackAttempts.some((attempt) => attempt.scope === "token")
        ? "chain scope preserved first; external token signal is labeled context"
        : "chain scope preserved",
    primaryRoute: {
      chain,
      minUsd: params.minUsd,
      route: "dune.smart_money_sql.primary",
      scope: symbol || options.tokenAddress ? "token" : "chain",
      windowDays: params.windowDays,
    },
    scope: symbol || options.tokenAddress ? "token" : "chain",
    selectedRoute,
  };
}

function resolveSameScopeRelaxedFallback(
  options: DuneSmartMoneyOptions
): SmartMoneySameScopeFallback | undefined {
  const chain = normalizeDuneChain(options.chain);
  const queryText = options.rawQuery ?? options.query ?? "";
  const current = describeSmartMoneySqlParams(options);
  const relaxedWindowDays = hasExplicitWindow(queryText)
    ? current.windowDays
    : Math.max(
        current.windowDays,
        readPositiveInteger(process.env.DUNE_SMART_MONEY_RELAXED_DAYS, 30)
      );
  const relaxedMinUsd = hasExplicitMinUsd(queryText)
    ? current.minUsd
    : Math.min(
        current.minUsd,
        readPositiveInteger(process.env.DUNE_SMART_MONEY_RELAXED_MIN_USD, 1000)
      );

  if (
    relaxedWindowDays === current.windowDays &&
    relaxedMinUsd === current.minUsd
  ) {
    return undefined;
  }

  return {
    chain,
    chainName: titleCase(chain),
    fallbackReason:
      `Primary ${titleCase(chain)} chain-level smart-money SQL returned no rows, so Dune retried the same chain with a wider or lower-threshold scan instead of switching to token activity on another chain.`,
    minUsd: relaxedMinUsd,
    mode: "same-chain-relaxed",
    requestedChain: chain,
    requestedChainName: titleCase(chain),
    windowDays: relaxedWindowDays,
  };
}

function extractQueryId(query: string | undefined) {
  const match = query?.match(/\b(?:dune\s+)?query\s+(\d{3,12})\b/i);

  return match?.[1];
}

function buildSmartMoneyFlowSql(options: DuneSmartMoneyOptions) {
  const chain = normalizeDuneChain(options.chain);
  const tokenAddress = normalizeTokenAddress(options.tokenAddress);
  const queryText = options.rawQuery ?? options.query ?? "";
  const symbol = tokenAddress ? undefined : extractTokenSymbol(queryText, chain);
  const days = clampWindowDays(options.windowDaysOverride ?? extractWindowDays(queryText));
  const minUsd = clampMinUsd(options.minUsdOverride ?? extractMinUsd(queryText));
  const includeExcludedAssets = Boolean(tokenAddress || symbol);
  const dexCategoryCase = buildTokenCategoryCase("token_bought_symbol");
  const cexCategoryCase = buildTokenCategoryCase("token_symbol");
  const dexTokenFilters = [
    tokenAddress ? `token_bought_address = ${tokenAddress}` : undefined,
    symbol ? `upper(token_bought_symbol) = '${escapeSqlLiteral(symbol.toUpperCase())}'` : undefined,
  ].filter(Boolean);
  const cexTokenFilters = [
    tokenAddress ? `token_address = ${tokenAddress}` : undefined,
    symbol ? `upper(token_symbol) = '${escapeSqlLiteral(symbol.toUpperCase())}'` : undefined,
  ].filter(Boolean);
  const categoryFilter = includeExcludedAssets
    ? ""
    : "\n  WHERE category = 'non-stable token accumulation'";

  return `
WITH dex_buys AS (
  SELECT
    COALESCE(taker, tx_from) AS wallet_address,
    token_bought_symbol AS token,
    token_bought_address AS token_address,
    token_bought_amount AS bought_amount,
    amount_usd,
    block_time,
    tx_hash,
    ${dexCategoryCase} AS category
  FROM dex.trades
  WHERE blockchain = '${chain}'
    AND block_time >= date_add('day', -${days}, current_timestamp)
    AND amount_usd >= ${minUsd}
    AND COALESCE(taker, tx_from) IS NOT NULL
    AND token_bought_symbol IS NOT NULL
    AND token_bought_amount IS NOT NULL
    AND amount_usd IS NOT NULL
    AND regexp_like(token_bought_symbol, '^[A-Za-z0-9.$_-]{2,24}$')
    ${dexTokenFilters.map((filter) => `AND ${filter}`).join("\n    ")}
),
filtered_dex AS (
  SELECT *
  FROM dex_buys${categoryFilter}
),
dex_grouped AS (
  SELECT
    wallet_address,
    token,
    token_address,
    category,
    SUM(bought_amount) AS amount,
    SUM(amount_usd) AS usd_value,
    COUNT(DISTINCT tx_hash) AS trades,
    MIN(block_time) AS first_seen,
    MAX(block_time) AS last_seen
  FROM filtered_dex
  GROUP BY 1, 2, 3, 4
  HAVING SUM(amount_usd) >= ${minUsd}
),
cex_flows AS (
  SELECT
    CASE
      WHEN lower(flow_type) IN ('withdrawal', 'outflow') THEN "to"
      ELSE "from"
    END AS wallet_address,
    token_symbol AS token,
    token_address,
    cex_name AS source_cex,
    lower(flow_type) AS flow_type,
    amount,
    amount_usd,
    block_time,
    ${cexCategoryCase} AS category
  FROM cex.flows
  WHERE blockchain = '${chain}'
    AND block_time >= date_add('day', -${days}, current_timestamp)
    AND lower(flow_type) IN ('withdrawal', 'deposit', 'outflow', 'inflow')
    AND amount_usd >= ${minUsd}
    AND amount IS NOT NULL
    AND amount > 0
    AND amount_usd IS NOT NULL
    AND token_symbol IS NOT NULL
    AND cex_name IS NOT NULL
    AND regexp_like(token_symbol, '^[A-Za-z0-9.$_-]{2,24}$')
    ${cexTokenFilters.map((filter) => `AND ${filter}`).join("\n    ")}
),
filtered_cex AS (
  SELECT *
  FROM cex_flows${categoryFilter}
),
cex_grouped AS (
  SELECT
    wallet_address,
    token,
    token_address,
    source_cex,
    flow_type,
    category,
    SUM(amount) AS amount,
    SUM(amount_usd) AS usd_value,
    COUNT(*) AS transfers,
    MIN(block_time) AS first_seen,
    MAX(block_time) AS last_seen
  FROM filtered_cex
  WHERE wallet_address IS NOT NULL
  GROUP BY 1, 2, 3, 4, 5, 6
  HAVING SUM(amount_usd) >= ${minUsd}
),
combined AS (

SELECT
  CONCAT('0x', LOWER(TO_HEX(wallet_address))) AS wallet,
  token,
  'DEX buy' AS signal,
  amount,
  usd_value,
  trades,
  CAST(NULL AS BIGINT) AS transfers,
  CAST(CAST(first_seen AS date) AS varchar) || ' to ' || CAST(CAST(last_seen AS date) AS varchar) AS window,
  category,
  'large-flow watchlist' AS status,
  'large_flow_watchlist' AS smartMoneyStatus,
  CAST(NULL AS VARCHAR) AS sourceCex,
  '${chain}' AS sourceChain,
  'dex.trades' AS sourceTable
FROM dex_grouped
UNION ALL
SELECT
  CONCAT('0x', LOWER(TO_HEX(wallet_address))) AS wallet,
  token,
  CASE
    WHEN flow_type IN ('withdrawal', 'outflow') THEN 'CEX withdrawal'
    ELSE 'CEX deposit'
  END AS signal,
  amount,
  usd_value,
  CAST(NULL AS BIGINT) AS trades,
  transfers,
  CAST(CAST(first_seen AS date) AS varchar) || ' to ' || CAST(CAST(last_seen AS date) AS varchar) AS window,
  CASE
    WHEN flow_type IN ('deposit', 'inflow') THEN 'cex sell-pressure flow'
    ELSE category
  END AS category,
  CASE
    WHEN flow_type IN ('withdrawal', 'outflow') THEN 'candidate smart-money'
    ELSE 'sell-pressure watchlist'
  END AS status,
  CASE
    WHEN flow_type IN ('withdrawal', 'outflow') THEN 'candidate_smart_money'
    ELSE 'sell_pressure_watchlist'
  END AS smartMoneyStatus,
  source_cex AS sourceCex,
  '${chain}' AS sourceChain,
  'cex.flows' AS sourceTable
FROM cex_grouped
),
ranked AS (
  SELECT
    *,
    ROW_NUMBER() OVER (
      PARTITION BY signal
      ORDER BY
        CASE category
          WHEN 'non-stable token accumulation' THEN 1
          WHEN 'stablecoin/dry-powder flow' THEN 2
          WHEN 'wrapped major asset flow' THEN 3
          WHEN 'cex sell-pressure flow' THEN 4
          ELSE 5
        END,
        usd_value DESC
    ) AS signal_rank
  FROM combined
)
SELECT
  wallet,
  token,
  signal,
  amount,
  usd_value,
  trades,
  transfers,
  window,
  category,
  status,
  smartMoneyStatus,
  sourceCex,
  sourceChain,
  sourceTable
FROM ranked
WHERE signal_rank <= 20
ORDER BY
  CASE signal
    WHEN 'CEX withdrawal' THEN 1
    WHEN 'DEX buy' THEN 2
    WHEN 'CEX deposit' THEN 3
    ELSE 4
  END,
  CASE category
    WHEN 'non-stable token accumulation' THEN 1
    WHEN 'stablecoin/dry-powder flow' THEN 2
    WHEN 'wrapped major asset flow' THEN 3
    WHEN 'cex sell-pressure flow' THEN 4
    ELSE 4
  END,
  usd_value DESC
LIMIT 60`.trim();
}

function buildExternalCexTransferSql({
  minUsd,
  target,
  windowDays,
}: {
  minUsd: number;
  target: NonNullable<ReturnType<typeof resolveExternalCexTransferTarget>>;
  windowDays: number;
}) {
  const chain = normalizeDuneChain(target.chain);
  const tokenAddress = normalizeTokenAddress(target.tokenAddress);

  if (!tokenAddress) {
    throw new Error("External CEX transfer fallback requires a token address.");
  }

  return `
WITH cex_labels AS (
  SELECT
    address,
    regexp_replace(name, '\\s+[0-9]+$', '') AS source_cex
  FROM labels.addresses
  WHERE blockchain = '${chain}'
    AND model_name = 'cex_ethereum'
    AND category = 'institution'
),
recipient_labels AS (
  SELECT
    address,
    array_join(array_agg(DISTINCT category), ', ') AS recipient_categories
  FROM labels.addresses
  WHERE blockchain = '${chain}'
  GROUP BY 1
),
transfers AS (
  SELECT
    transfer."to" AS wallet,
    label.source_cex,
    transfer.symbol AS token,
    transfer.amount,
    transfer.amount_usd,
    transfer.block_time,
    transfer.tx_hash,
    recipient.recipient_categories
  FROM tokens.transfers transfer
  JOIN cex_labels label ON transfer."from" = label.address
  LEFT JOIN recipient_labels recipient ON transfer."to" = recipient.address
  WHERE transfer.blockchain = '${chain}'
    AND transfer.contract_address = ${tokenAddress}
    AND transfer.block_time >= date_add('day', -${windowDays}, current_timestamp)
    AND transfer.amount > 0
    AND transfer.amount_usd IS NOT NULL
    AND transfer.amount_usd >= ${minUsd}
    AND (
      recipient.recipient_categories IS NULL
      OR NOT regexp_like(lower(recipient.recipient_categories), 'institution|contracts')
    )
),
grouped AS (
  SELECT
    wallet,
    source_cex,
    token,
    SUM(amount) AS amount,
    SUM(amount_usd) AS usd_value,
    COUNT(DISTINCT tx_hash) AS transfers,
    MIN(block_time) AS first_seen,
    MAX(block_time) AS last_seen
  FROM transfers
  GROUP BY 1, 2, 3
  HAVING SUM(amount_usd) >= ${minUsd}
)
SELECT
  CONCAT('0x', LOWER(TO_HEX(wallet))) AS wallet,
  token,
  'CEX withdrawal' AS signal,
  amount,
  usd_value,
  CAST(NULL AS BIGINT) AS trades,
  transfers,
  CAST(CAST(first_seen AS date) AS varchar) || ' to ' || CAST(CAST(last_seen AS date) AS varchar) AS window,
  'external token CEX withdrawal' AS category,
  'candidate smart-money' AS status,
  'candidate_smart_money' AS smartMoneyStatus,
  source_cex AS sourceCex,
  '${chain}' AS sourceChain,
  'cex token transfers: tokens.transfers + labels.addresses' AS sourceTable,
  true AS externalTokenSignal,
  '${escapeSqlLiteral(target.requestedChain)}' AS requestedChain,
  '${escapeSqlLiteral(target.requestedChainName)}' AS requestedChainName,
  '${escapeSqlLiteral(target.tokenAddressChainName)}' AS tokenAddressChainName
FROM grouped
ORDER BY usd_value DESC
LIMIT 20`.trim();
}

function describeExternalCexTransferParams(options: DuneSmartMoneyOptions) {
  const queryText = options.rawQuery ?? options.query ?? "";
  const base = describeSmartMoneySqlParams(options);

  return {
    minUsd: hasExplicitMinUsd(queryText)
      ? base.minUsd
      : readPositiveInteger(process.env.DUNE_SMART_MONEY_EXTERNAL_CEX_MIN_USD, 1000),
    windowDays: hasExplicitWindow(queryText)
      ? base.windowDays
      : readPositiveInteger(process.env.DUNE_SMART_MONEY_EXTERNAL_CEX_DAYS, 30),
  };
}

function describeSmartMoneySqlParams(options: DuneSmartMoneyOptions) {
  const queryText = options.rawQuery ?? options.query ?? "";

  return {
    minUsd: clampMinUsd(options.minUsdOverride ?? extractMinUsd(queryText)),
    windowDays: clampWindowDays(
      options.windowDaysOverride ?? extractWindowDays(queryText)
    ),
  };
}

function buildTokenCategoryCase(symbolColumn: string) {
  return `CASE
      WHEN upper(${symbolColumn}) IN (${sqlStringList(stableSymbols)})
        OR regexp_like(upper(${symbolColumn}), 'USD|USDC|USDT')
        THEN 'stablecoin/dry-powder flow'
      WHEN upper(${symbolColumn}) IN (${sqlStringList(wrappedMajorSymbols)})
        OR regexp_like(upper(${symbolColumn}), '(^|[^A-Z0-9])(W?ETH|STETH|WSTETH|WBTC|BTC)|ETH$|BTC$')
        THEN 'wrapped major asset flow'
      ELSE 'non-stable token accumulation'
    END`;
}

async function waitForExecution({
  apiKey,
  executionId,
  signal,
}: {
  apiKey: string;
  executionId: string;
  signal?: AbortSignal;
}) {
  const startedAt = Date.now();
  const timeoutMs = readPositiveInteger(
    process.env.DUNE_SQL_TIMEOUT_MS,
    defaultTimeoutMs
  );
  const pollIntervalMs = readPositiveInteger(
    process.env.DUNE_SQL_POLL_INTERVAL_MS,
    defaultPollIntervalMs
  );

  while (Date.now() - startedAt <= timeoutMs) {
    const status = await fetchJson(
      `${baseUrl}/execution/${encodeURIComponent(executionId)}/status`,
      {
        headers: {
          "X-Dune-API-Key": apiKey,
        },
        signal,
        timeoutMs: 30000,
      }
    );
    const record = asRecord(status);
    const state = typeof record?.state === "string" ? record.state : "";

    if (record?.is_execution_finished === true) {
      if (state === "QUERY_STATE_COMPLETED") {
        return;
      }

      throw new Error(
        `Dune SQL execution failed with state ${state || "unknown"}. ${compactText(record.error ?? status)}`
      );
    }

    if (signal?.aborted) {
      throw new Error("Dune SQL execution was aborted.");
    }

    await delay(pollIntervalMs);
  }

  throw new Error("Dune SQL execution timed out.");
}

function readExecutionId(value: unknown) {
  const record = asRecord(value);
  const executionId = record?.execution_id;

  return typeof executionId === "string" ? executionId : "";
}

function readResultRows(value: unknown) {
  const record = asRecord(value);
  const result = asRecord(record?.result);
  const rows = result?.rows;

  return Array.isArray(rows) ? rows : [];
}

function readDunePerformance() {
  const value = process.env.DUNE_SQL_PERFORMANCE?.trim().toLowerCase();

  return value === "small" || value === "medium" || value === "large"
    ? value
    : undefined;
}

function normalizeDuneChain(chain: string) {
  const normalized = chain.trim().toLowerCase();
  const aliases: Record<string, string> = {
    bnb: "bnb",
    bsc: "bnb",
    eth: "ethereum",
    optimism: "optimism",
    polygon: "polygon",
  };
  const duneChain = aliases[normalized] ?? normalized;
  const supported = new Set([
    "arbitrum",
    "avalanche",
    "base",
    "bnb",
    "celo",
    "ethereum",
    "mantle",
    "optimism",
    "polygon",
  ]);

  if (!supported.has(duneChain)) {
    throw new Error(`Dune dynamic smart-money SQL is not mapped for ${chain}.`);
  }

  return duneChain;
}

function normalizeTokenAddress(value: string | undefined) {
  const address = value?.trim().toLowerCase();

  return address && /^0x[a-f0-9]{40}$/.test(address) ? address : undefined;
}

function extractTokenSymbol(query: string, chain: string) {
  const ticker = query.match(/\$([a-z][a-z0-9._-]{1,23})\b/i)?.[1];
  const explicit = query.match(
    /\b(?:for|of|token|coin|asset)\s+\$?([a-z][a-z0-9._-]{1,23})\b/i
  )?.[1];
  const standalone = query.trim().match(/^([a-z][a-z0-9._-]{1,23})$/i)?.[1];
  const symbol = (ticker ?? explicit ?? standalone)?.trim();

  if (!symbol) {
    return undefined;
  }

  const lower = symbol.toLowerCase();
  const ignored = new Set([
    "accumulation",
    "chain",
    "ethereum",
    "find",
    "flow",
    "mantle",
    "money",
    "on",
    "smart",
    chain,
  ]);

  return ignored.has(lower) ? undefined : symbol;
}

function extractWindowDays(query: string) {
  const compact = query.toLowerCase();
  const explicitDays = compact.match(/\b(?:last|past)?\s*(\d{1,3})\s*(?:d|day|days)\b/);
  const days = explicitDays
    ? Number(explicitDays[1])
    : /\b(?:month|30d)\b/.test(compact)
      ? 30
      : /\b(?:24h|1d|today)\b/.test(compact)
        ? 1
        : 7;

  return clampWindowDays(days || 7);
}

function extractMinUsd(query: string) {
  const match = query.match(
    /(?:\$)\s*(\d+(?:\.\d+)?)\s*([kKmM])?|\b(\d+(?:\.\d+)?)\s*([kKmM])\s*(?:usd|dollars?)?\b|\b(\d+(?:\.\d+)?)\s*(?:usd|dollars?)\b/i
  );

  if (!match) {
    return 10000;
  }

  const amount = Number(match[1] ?? match[3] ?? match[5]);
  const suffix = (match[2] ?? match[4])?.toLowerCase();
  const multiplier = suffix === "m" ? 1000000 : suffix === "k" ? 1000 : 1;
  const value = amount * multiplier;

  return Number.isFinite(value) ? clampMinUsd(value) : 10000;
}

function hasExplicitWindow(query: string) {
  const compact = query.toLowerCase();

  return /\b(?:last|past)?\s*\d{1,3}\s*(?:d|day|days)\b/.test(compact) ||
    /\b(?:24h|1d|today|month|30d)\b/.test(compact);
}

function hasExplicitMinUsd(query: string) {
  return /(?:\$)\s*(\d+(?:\.\d+)?)\s*([kKmM])?|\b(\d+(?:\.\d+)?)\s*([kKmM])\s*(?:usd|dollars?)?\b|\b(\d+(?:\.\d+)?)\s*(?:usd|dollars?)\b/i.test(query);
}

function clampWindowDays(value: number) {
  return Math.min(Math.max(Math.round(value || 7), 1), 90);
}

function clampMinUsd(value: number) {
  return Math.min(Math.max(Math.round(value), 1000), 10000000);
}

function readPositiveInteger(value: string | undefined, fallback: number) {
  const number = Number(value);

  return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback;
}

function sqlStringList(values: string[]) {
  return values.map((value) => `'${escapeSqlLiteral(value)}'`).join(", ");
}

function escapeSqlLiteral(value: string) {
  return value.replace(/'/g, "''");
}

function titleCase(value: string) {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function asRecord(value: unknown) {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const stableSymbols = [
  "APXUSD",
  "DAI",
  "FDUSD",
  "FRAX",
  "GHO",
  "LUSD",
  "PYUSD",
  "SUSDS",
  "SUSDE",
  "TUSD",
  "USDC",
  "USDC.E",
  "USDE",
  "USDT",
  "USDS",
  "USD0",
  "USDP",
  "CRVUSD",
];

const wrappedMajorSymbols = [
  "AETH",
  "BTCB",
  "CBBTC",
  "CBETH",
  "ETH",
  "EZETH",
  "LBTC",
  "PAXG",
  "RETH",
  "STETH",
  "TBTC",
  "WBTC",
  "WEETH",
  "WETH",
  "WSTETH",
  "XAUT",
];
