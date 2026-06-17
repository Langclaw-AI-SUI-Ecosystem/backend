import { keccak256, toBytes } from "viem";

import {
  defaultProductChain,
  getProductChain,
  type ProductChainId,
} from "../chain-config";
import type {
  StrategyBacktestParams,
  StrategyBacktestPayload,
  StrategyEquityPoint,
  StrategyMarketBar,
  StrategyMetrics,
  StrategyPaperTradePayload,
  StrategyScanCandidate,
  StrategyScanPayload,
  StrategySignal,
  StrategyTrade,
} from "./types";

export const liquidityMomentumStrategyId = "sui-liquidity-momentum-v1";
export const liquidityMomentumTitle = "Sui Liquidity Momentum Strategy";

export const defaultStrategyParams: StrategyBacktestParams = {
  initialCapitalUsd: 10_000,
  maxHoldHours: 24,
  minLiquidityUsd: 50_000,
  minMomentumBps: 50,
  minVolumeMultiple: 1.1,
  stopLossBps: 500,
  takeProfitBps: 1000,
};

type BacktestInput = {
  bars: StrategyMarketBar[];
  chain?: ProductChainId;
  generatedAt?: string;
  pairAddress?: string;
  params?: Partial<StrategyBacktestParams>;
  queryId: string;
  runId?: string;
  sourceUrl: string;
};

type PaperTradeInput = {
  backtest: StrategyBacktestPayload;
  generatedAt?: string;
  notionalUsd?: number;
  runId?: string;
};

type ScanInput = {
  bars: StrategyMarketBar[];
  candidateLimit?: number;
  chain?: ProductChainId;
  generatedAt?: string;
  params?: Partial<StrategyBacktestParams>;
  queryId: string;
  sourceUrl: string;
};

export function parseDuneHistoricalRows(value: unknown): StrategyMarketBar[] {
  const rows = readRows(value);

  return rows.map(parseDuneRow).filter((row): row is StrategyMarketBar => Boolean(row));
}

export function scanLiquidityMomentumPairs({
  bars,
  candidateLimit = 12,
  chain = defaultProductChain,
  generatedAt = new Date().toISOString(),
  params,
  queryId,
  sourceUrl,
}: ScanInput): StrategyScanPayload {
  const chainConfig = getProductChain(chain);
  const pairStats = summarizePairs(bars);
  const candidates: Array<StrategyScanCandidate & { backtest: StrategyBacktestPayload }> = [];

  for (const pair of pairStats.slice(0, clamp(Math.round(candidateLimit), 1, 25))) {
    try {
      const backtest = runLiquidityMomentumBacktest({
        bars,
        chain,
        generatedAt,
        pairAddress: pair.pairAddress,
        params,
        queryId,
        runId: `scan_${pair.pairAddress.slice(2, 8)}`,
        sourceUrl,
      });
      const score = scoreScanCandidate(backtest.metrics, backtest.latestSignal);

      candidates.push({
        backtest,
        latestSignal: backtest.latestSignal,
        latestTimestamp: pair.latestTimestamp,
        market: backtest.market,
        metrics: backtest.metrics,
        pairAddress: backtest.pairAddress,
        rank: 0,
        rowCount: pair.rowCount,
        score,
        scoreReason: buildScoreReason(backtest.metrics, backtest.latestSignal),
        totalVolumeUsd: roundUsd(pair.totalVolumeUsd),
      });
    } catch {
      // Skip sparse or malformed pair groups; the scan still reports viable pairs.
    }
  }

  const ranked = candidates
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      if (right.metrics.totalPnlBps !== left.metrics.totalPnlBps) {
        return right.metrics.totalPnlBps - left.metrics.totalPnlBps;
      }

      return right.totalVolumeUsd - left.totalVolumeUsd;
    })
    .map((candidate, index) => ({
      ...candidate,
      rank: index + 1,
    }));
  const [best] = ranked;

  if (!best) {
    throw new Error("Dune strategy query did not contain enough pair history to scan.");
  }

  return {
    bestBacktest: best.backtest,
    chain: chainConfig.id,
    chainId: chainConfig.chainId,
    chainName: chainConfig.name,
    candidates: ranked.map(({ backtest, ...candidate }) => candidate),
    generatedAt,
    queryId,
    scannedPairs: candidates.length,
    selectedPairAddress: best.pairAddress,
    sourceUrl,
  };
}

export function runLiquidityMomentumBacktest({
  bars,
  chain = defaultProductChain,
  generatedAt = new Date().toISOString(),
  pairAddress,
  params,
  queryId,
  runId = buildRunId("bt"),
  sourceUrl,
}: BacktestInput): StrategyBacktestPayload {
  const chainConfig = getProductChain(chain);
  const mergedParams = {
    ...defaultStrategyParams,
    ...sanitizeParams(params),
  };
  const filteredBars = normalizeBars(bars, pairAddress);

  if (filteredBars.length < 2) {
    throw new Error(
      `Dune strategy query returned fewer than 2 usable ${chainConfig.name} price rows.`
    );
  }

  const marketPair = pairAddress || filteredBars[0].pairAddress;
  const market = `${chainConfig.id}:${marketPair}`;
  const trades: StrategyTrade[] = [];
  const equityCurve: StrategyEquityPoint[] = [];
  let cash = mergedParams.initialCapitalUsd;
  let open:
    | {
        entryAt: string;
        entryPriceUsd: number;
        entryCapitalUsd: number;
      }
    | undefined;

  for (let index = 1; index < filteredBars.length; index += 1) {
    const previous = filteredBars[index - 1];
    const current = filteredBars[index];

    if (!open && shouldEnter(filteredBars, index, mergedParams)) {
      open = {
        entryAt: current.timestamp,
        entryCapitalUsd: cash,
        entryPriceUsd: current.priceUsd,
      };
    } else if (open) {
      const pnlBps = calculatePnlBps(open.entryPriceUsd, current.priceUsd);
      const holdHours = diffHours(open.entryAt, current.timestamp);
      const exitReason = exitReasonFor({
        bars: filteredBars,
        index,
        maxHoldHours: mergedParams.maxHoldHours,
        open,
        pnlBps,
        stopLossBps: mergedParams.stopLossBps,
        takeProfitBps: mergedParams.takeProfitBps,
      });

      if (exitReason) {
        const pnlUsd = roundUsd(open.entryCapitalUsd * (pnlBps / 10_000));
        cash = roundUsd(open.entryCapitalUsd + pnlUsd);
        trades.push({
          entryAt: open.entryAt,
          entryPriceUsd: open.entryPriceUsd,
          exitAt: current.timestamp,
          exitPriceUsd: current.priceUsd,
          holdHours,
          pnlBps,
          pnlUsd,
          reason: exitReason,
        });
        open = undefined;
      }
    }

    equityCurve.push({
      equityUsd: open
        ? roundUsd(open.entryCapitalUsd * (current.priceUsd / open.entryPriceUsd))
        : cash,
      timestamp: current.timestamp,
    });
  }

  if (open) {
    const last = filteredBars[filteredBars.length - 1];
    const pnlBps = calculatePnlBps(open.entryPriceUsd, last.priceUsd);
    const pnlUsd = roundUsd(open.entryCapitalUsd * (pnlBps / 10_000));
    cash = roundUsd(open.entryCapitalUsd + pnlUsd);
    trades.push({
      entryAt: open.entryAt,
      entryPriceUsd: open.entryPriceUsd,
      exitAt: last.timestamp,
      exitPriceUsd: last.priceUsd,
      holdHours: diffHours(open.entryAt, last.timestamp),
      pnlBps,
      pnlUsd,
      reason: "end-of-sample",
    });
    equityCurve.push({
      equityUsd: cash,
      timestamp: last.timestamp,
    });
  }

  const metrics = buildMetrics({
    equityCurve,
    finalEquityUsd: cash,
    initialCapitalUsd: mergedParams.initialCapitalUsd,
    trades,
  });
  const latestSignal = buildLatestSignal(filteredBars, mergedParams);

  return {
    bars: filteredBars,
    chain: chainConfig.id,
    chainId: chainConfig.chainId,
    chainName: chainConfig.name,
    equityCurve,
    generatedAt,
    latestSignal,
    market,
    metrics,
    pairAddress: marketPair,
    params: mergedParams,
    queryId,
    runId,
    sourceUrl,
    strategyId: `${chainConfig.id}-liquidity-momentum-v1`,
    title: `${chainConfig.name} Liquidity Momentum Strategy`,
    trades,
  };
}

export function buildPaperTrade({
  backtest,
  generatedAt = new Date().toISOString(),
  notionalUsd = 1_000,
  runId = buildRunId("paper"),
}: PaperTradeInput): StrategyPaperTradePayload {
  const latestSignal = backtest.latestSignal;

  return {
    action: latestSignal.action,
    chain: backtest.chain,
    chainId: backtest.chainId,
    chainName: backtest.chainName,
    confidence: latestSignal.confidence,
    generatedAt,
    market: backtest.market,
    notionalUsd,
    pairAddress: backtest.pairAddress,
    proof: {
      action: latestSignal.action,
      agentId: "0",
      chain: backtest.chain,
      chainId: backtest.chainId,
      chainName: backtest.chainName,
      decisionHash: hashJson({
        action: latestSignal.action,
        confidence: latestSignal.confidence,
        market: backtest.market,
        priceUsd: latestSignal.priceUsd,
        strategyId: backtest.strategyId,
      }),
      evidenceUri: buildEvidenceUri(runId),
      pnlBps: 0,
      resultHash: hashJson({
        generatedAt,
        notionalUsd,
        referenceBacktestRunId: backtest.runId,
        runId,
      }),
      status: "prepared",
      strategyStatus: "paper-opened",
    },
    rationale: latestSignal.rationale,
    referenceBacktestRunId: backtest.runId,
    runId,
    strategyId: backtest.strategyId,
  };
}

export function buildBacktestJournalHashes(backtest: StrategyBacktestPayload) {
  return {
    decisionHash: hashJson({
      latestSignal: backtest.latestSignal,
      market: backtest.market,
      params: backtest.params,
      strategyId: backtest.strategyId,
    }),
    evidenceUri: buildEvidenceUri(backtest.runId),
    resultHash: hashJson({
      metrics: backtest.metrics,
      tradeCount: backtest.trades.length,
      trades: backtest.trades,
    }),
  };
}

export function buildPaperJournalHashes(paperTrade: StrategyPaperTradePayload) {
  return {
    decisionHash: hashJson({
      action: paperTrade.action,
      confidence: paperTrade.confidence,
      market: paperTrade.market,
      rationale: paperTrade.rationale,
      strategyId: paperTrade.strategyId,
    }),
    evidenceUri: buildEvidenceUri(paperTrade.runId),
    resultHash: hashJson({
      generatedAt: paperTrade.generatedAt,
      notionalUsd: paperTrade.notionalUsd,
      referenceBacktestRunId: paperTrade.referenceBacktestRunId,
      runId: paperTrade.runId,
    }),
  };
}

function shouldEnter(
  bars: StrategyMarketBar[],
  index: number,
  params: StrategyBacktestParams
) {
  const current = bars[index];
  const previous = bars[index - 1];
  const momentumBps = calculatePnlBps(previous.priceUsd, current.priceUsd);
  const volumeBaseline = average(
    bars.slice(Math.max(0, index - 6), index).map((bar) => bar.volumeUsd)
  );
  const volumeOk =
    volumeBaseline <= 0 || current.volumeUsd >= volumeBaseline * params.minVolumeMultiple;
  const liquidityOk = current.liquidityUsd >= params.minLiquidityUsd;
  const flowOk = current.netWhaleFlowUsd === undefined || current.netWhaleFlowUsd >= 0;

  return (
    momentumBps >= params.minMomentumBps &&
    volumeOk &&
    liquidityOk &&
    flowOk
  );
}

function exitReasonFor({
  bars,
  index,
  maxHoldHours,
  open,
  pnlBps,
  stopLossBps,
  takeProfitBps,
}: {
  bars: StrategyMarketBar[];
  index: number;
  maxHoldHours: number;
  open: { entryAt: string; entryPriceUsd: number };
  pnlBps: number;
  stopLossBps: number;
  takeProfitBps: number;
}) {
  const current = bars[index];
  const previous = bars[index - 1];

  if (pnlBps >= takeProfitBps) {
    return "take-profit";
  }

  if (pnlBps <= -stopLossBps) {
    return "stop-loss";
  }

  if (diffHours(open.entryAt, current.timestamp) >= maxHoldHours) {
    return "max-hold";
  }

  if (calculatePnlBps(previous.priceUsd, current.priceUsd) < -100) {
    return "momentum-reversal";
  }

  return "";
}

function buildLatestSignal(
  bars: StrategyMarketBar[],
  params: StrategyBacktestParams
): StrategySignal {
  const lastIndex = bars.length - 1;
  const latest = bars[lastIndex];
  const previous = bars[lastIndex - 1] ?? latest;
  const momentumBps = calculatePnlBps(previous.priceUsd, latest.priceUsd);
  const liquidityScore = latest.liquidityUsd >= params.minLiquidityUsd ? 30 : 0;
  const momentumScore = momentumBps >= params.minMomentumBps ? 35 : Math.max(0, momentumBps / 2);
  const volumeBaseline = average(
    bars.slice(Math.max(0, lastIndex - 6), lastIndex).map((bar) => bar.volumeUsd)
  );
  const volumeScore =
    volumeBaseline <= 0 || latest.volumeUsd >= volumeBaseline * params.minVolumeMultiple
      ? 25
      : 10;
  const flowScore =
    latest.netWhaleFlowUsd === undefined
      ? 10
      : latest.netWhaleFlowUsd >= 0
        ? 10
        : 0;
  const confidence = clamp(Math.round(liquidityScore + momentumScore + volumeScore + flowScore), 0, 100);
  const action =
    confidence >= 70 && momentumBps >= params.minMomentumBps
      ? "buy"
      : momentumBps < -params.minMomentumBps
        ? "sell"
        : "hold";

  return {
    action,
    confidence,
    liquidityUsd: latest.liquidityUsd,
    momentumBps,
    priceUsd: latest.priceUsd,
    rationale: `Momentum ${momentumBps} bps, liquidity $${Math.round(latest.liquidityUsd).toLocaleString("en-US")}, 24h-style volume proxy $${Math.round(latest.volumeUsd).toLocaleString("en-US")}.`,
    volumeUsd: latest.volumeUsd,
  };
}

function buildMetrics({
  equityCurve,
  finalEquityUsd,
  initialCapitalUsd,
  trades,
}: {
  equityCurve: StrategyEquityPoint[];
  finalEquityUsd: number;
  initialCapitalUsd: number;
  trades: StrategyTrade[];
}): StrategyMetrics {
  const winningTrades = trades.filter((trade) => trade.pnlUsd > 0).length;

  return {
    finalEquityUsd,
    initialCapitalUsd,
    maxDrawdownBps: calculateMaxDrawdownBps(equityCurve, initialCapitalUsd),
    totalPnlBps: Math.round(((finalEquityUsd - initialCapitalUsd) / initialCapitalUsd) * 10_000),
    totalPnlUsd: roundUsd(finalEquityUsd - initialCapitalUsd),
    tradeCount: trades.length,
    winRate: trades.length ? Math.round((winningTrades / trades.length) * 100) : 0,
  };
}

function calculateMaxDrawdownBps(
  equityCurve: StrategyEquityPoint[],
  initialCapitalUsd: number
) {
  let peak = initialCapitalUsd;
  let maxDrawdownBps = 0;

  for (const point of equityCurve) {
    peak = Math.max(peak, point.equityUsd);

    if (peak > 0) {
      maxDrawdownBps = Math.max(
        maxDrawdownBps,
        Math.round(((peak - point.equityUsd) / peak) * 10_000)
      );
    }
  }

  return maxDrawdownBps;
}

function readRows(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (!value || typeof value !== "object") {
    return [];
  }

  const record = value as Record<string, unknown>;
  const result = readRecord(record.result);

  if (Array.isArray(result?.rows)) {
    return result.rows;
  }

  if (Array.isArray(record.rows)) {
    return record.rows;
  }

  const data = readRecord(record.data);

  if (Array.isArray(data?.rows)) {
    return data.rows;
  }

  if (Array.isArray(data?.result)) {
    return data.result;
  }

  return [];
}

function parseDuneRow(value: unknown): StrategyMarketBar | undefined {
  const row = readRecord(value);

  if (!row) {
    return undefined;
  }

  const timestamp = readString(row.timestamp ?? row.block_time ?? row.hour ?? row.time);
  const pairAddress = readString(row.pair_address ?? row.pair ?? row.market);
  const priceUsd = readNumber(row.price_usd ?? row.priceUsd ?? row.close);
  const liquidityUsd = readNumber(row.liquidity_usd ?? row.liquidityUsd ?? row.liquidity);
  const volumeUsd = readNumber(row.volume_usd ?? row.volumeUsd ?? row.volume);

  if (!timestamp || !pairAddress || priceUsd <= 0 || liquidityUsd < 0 || volumeUsd < 0) {
    return undefined;
  }

  return {
    liquidityUsd,
    netWhaleFlowUsd: readOptionalNumber(row.net_whale_flow_usd ?? row.netWhaleFlowUsd),
    pairAddress,
    priceUsd,
    timestamp: new Date(timestamp).toISOString(),
    txCount: readOptionalNumber(row.tx_count ?? row.txCount),
    volumeUsd,
  };
}

function normalizeBars(bars: StrategyMarketBar[], pairAddress: string | undefined) {
  const normalizedPair = pairAddress?.toLowerCase() || pickDefaultPairAddress(bars);
  const filtered = bars
    .filter((bar) =>
      normalizedPair ? bar.pairAddress.toLowerCase() === normalizedPair : true
    )
    .filter((bar) => Number.isFinite(Date.parse(bar.timestamp)))
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));

  return filtered.map((bar) => ({
    ...bar,
    liquidityUsd: roundUsd(bar.liquidityUsd),
    priceUsd: roundPrice(bar.priceUsd),
    volumeUsd: roundUsd(bar.volumeUsd),
  }));
}

function pickDefaultPairAddress(bars: StrategyMarketBar[]) {
  const scores = new Map<string, { lastTimestamp: number; rows: number; volumeUsd: number }>();

  for (const bar of bars) {
    const pair = bar.pairAddress.toLowerCase();
    const current = scores.get(pair) ?? {
      lastTimestamp: 0,
      rows: 0,
      volumeUsd: 0,
    };
    current.lastTimestamp = Math.max(current.lastTimestamp, Date.parse(bar.timestamp) || 0);
    current.rows += 1;
    current.volumeUsd += Number.isFinite(bar.volumeUsd) ? bar.volumeUsd : 0;
    scores.set(pair, current);
  }

  return [...scores.entries()].sort(([, left], [, right]) => {
    if (right.volumeUsd !== left.volumeUsd) {
      return right.volumeUsd - left.volumeUsd;
    }

    if (right.rows !== left.rows) {
      return right.rows - left.rows;
    }

    return right.lastTimestamp - left.lastTimestamp;
  })[0]?.[0];
}

function summarizePairs(bars: StrategyMarketBar[]) {
  const scores = new Map<
    string,
    {
      latestTimestamp: string;
      latestTimestampMs: number;
      pairAddress: string;
      rowCount: number;
      totalVolumeUsd: number;
    }
  >();

  for (const bar of bars) {
    const pair = bar.pairAddress.toLowerCase();
    const timestampMs = Date.parse(bar.timestamp) || 0;
    const current = scores.get(pair) ?? {
      latestTimestamp: bar.timestamp,
      latestTimestampMs: timestampMs,
      pairAddress: pair,
      rowCount: 0,
      totalVolumeUsd: 0,
    };

    current.rowCount += 1;
    current.totalVolumeUsd += Number.isFinite(bar.volumeUsd) ? bar.volumeUsd : 0;

    if (timestampMs >= current.latestTimestampMs) {
      current.latestTimestamp = bar.timestamp;
      current.latestTimestampMs = timestampMs;
    }

    scores.set(pair, current);
  }

  return [...scores.values()].sort((left, right) => {
    if (right.totalVolumeUsd !== left.totalVolumeUsd) {
      return right.totalVolumeUsd - left.totalVolumeUsd;
    }

    if (right.rowCount !== left.rowCount) {
      return right.rowCount - left.rowCount;
    }

    return right.latestTimestampMs - left.latestTimestampMs;
  });
}

function scoreScanCandidate(
  metrics: StrategyMetrics,
  latestSignal: StrategySignal
) {
  const tradeScore = Math.min(metrics.tradeCount, 30) * 8;
  const pnlScore = clamp(metrics.totalPnlBps, -2_000, 2_000) * 0.4;
  const winRateScore = metrics.winRate * 10;
  const drawdownPenalty = Math.min(metrics.maxDrawdownBps, 3_000) * 0.35;
  const latestSignalBonus =
    latestSignal.action === "buy"
      ? 300
      : latestSignal.action === "sell"
        ? 180
        : latestSignal.action === "exit"
          ? 80
          : 0;
  const confidenceBonus = latestSignal.confidence * 2;

  return Math.round(
    tradeScore +
      pnlScore +
      winRateScore +
      latestSignalBonus +
      confidenceBonus -
      drawdownPenalty
  );
}

function buildScoreReason(
  metrics: StrategyMetrics,
  latestSignal: StrategySignal
) {
  return [
    `${metrics.tradeCount} trade(s)`,
    `${formatSignedBps(metrics.totalPnlBps)} PnL`,
    `${metrics.winRate}% win rate`,
    `${metrics.maxDrawdownBps} bps drawdown`,
    `${latestSignal.action.toUpperCase()} latest signal`,
  ].join(" / ");
}

function sanitizeParams(
  params: Partial<StrategyBacktestParams> | undefined
): Partial<StrategyBacktestParams> {
  if (!params) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(params).filter(([, value]) => Number.isFinite(value) && value > 0)
  ) as Partial<StrategyBacktestParams>;
}

function calculatePnlBps(entryPrice: number, exitPrice: number) {
  return Math.round(((exitPrice - entryPrice) / entryPrice) * 10_000);
}

function formatSignedBps(value: number) {
  return `${value >= 0 ? "+" : ""}${value} bps`;
}

function diffHours(start: string, end: string) {
  return Math.max(0, (Date.parse(end) - Date.parse(start)) / 3_600_000);
}

function average(values: number[]) {
  const usable = values.filter((value) => Number.isFinite(value));

  if (!usable.length) {
    return 0;
  }

  return usable.reduce((total, value) => total + value, 0) / usable.length;
}

function readRecord(value: unknown) {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function readString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function readNumber(value: unknown) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.replace(/,/g, ""));

    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function readOptionalNumber(value: unknown) {
  const parsed = readNumber(value);

  return parsed || parsed === 0 ? parsed : undefined;
}

function roundUsd(value: number) {
  return Math.round(value * 100) / 100;
}

function roundPrice(value: number) {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function buildRunId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function buildEvidenceUri(runId: string) {
  const baseUri =
    process.env.LANGCLAW_STRATEGY_EVIDENCE_BASE_URI?.trim() ||
    process.env.LANGCLAW_EVIDENCE_BASE_URI?.trim() ||
    "langclaw://strategy";

  return `${baseUri.replace(/\/+$/, "")}/${encodeURIComponent(runId)}`;
}

function hashJson(value: unknown) {
  return keccak256(toBytes(stableStringify(value)));
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value), null, 2);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;

    return Object.keys(record)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        const item = record[key];

        if (item !== undefined) {
          acc[key] = sortJson(item);
        }

        return acc;
      }, {});
  }

  return value;
}
