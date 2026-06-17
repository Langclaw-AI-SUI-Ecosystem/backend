import {
  buildBacktestJournalHashes,
  buildPaperJournalHashes,
  buildPaperTrade,
  runLiquidityMomentumBacktest,
  scanLiquidityMomentumPairs,
} from "../lib/strategy/backtest";
import { fetchStrategyBarsFromDune } from "../lib/strategy/dune";
import {
  persistTradingJournalRecord,
  readTradingJournalRuns,
} from "../lib/strategy/journal";
import { readProductChainId } from "../lib/chain-config";
import type {
  StrategyBacktestParams,
  StrategyBacktestPayload,
} from "../lib/strategy/types";

type StrategyBody = {
  backtest?: StrategyBacktestPayload;
  chain?: unknown;
  limit?: unknown;
  notionalUsd?: unknown;
  pairAddress?: unknown;
  params?: Partial<StrategyBacktestParams>;
  queryId?: unknown;
};

export async function handleStrategyBacktest(request: Request) {
  const body = await readStrategyBody(request);

  if ("response" in body) {
    return body.response;
  }

  try {
    const queryId = readOptionalString(body.queryId);
    const chain = readProductChainId(body.chain);
    const pairAddress = readOptionalString(body.pairAddress);
    const source = await fetchStrategyBarsFromDune({
      queryId,
      signal: request.signal,
    });
    const backtest = runLiquidityMomentumBacktest({
      bars: source.bars,
      chain,
      pairAddress,
      params: body.params,
      queryId: source.queryId,
      sourceUrl: source.sourceUrl,
    });
    const journal = buildBacktestJournalHashes(backtest);

    backtest.proof = await persistTradingJournalRecord({
      action: backtest.latestSignal.action,
      chain,
      decisionHash: journal.decisionHash,
      evidenceUri: journal.evidenceUri,
      market: backtest.market,
      pnlBps: backtest.metrics.totalPnlBps,
      resultHash: journal.resultHash,
      runId: backtest.runId,
      status: "backtested",
      strategyId: backtest.strategyId,
    });

    return Response.json({
      configured: true,
      backtest,
    });
  } catch (error) {
    return strategyErrorResponse(error);
  }
}

export async function handleStrategyPaperTrade(request: Request) {
  const body = await readStrategyBody(request);

  if ("response" in body) {
    return body.response;
  }

  try {
    const backtest = body.backtest ?? (await createBacktestFromBody(body, request));
    const chain = readProductChainId(body.chain ?? backtest.chain);
    const paperTrade = buildPaperTrade({
      backtest,
      notionalUsd: readPositiveNumber(body.notionalUsd, 1_000),
    });
    const journal = buildPaperJournalHashes(paperTrade);

    paperTrade.proof = await persistTradingJournalRecord({
      action: paperTrade.action,
      chain,
      decisionHash: journal.decisionHash,
      evidenceUri: journal.evidenceUri,
      market: paperTrade.market,
      pnlBps: 0,
      resultHash: journal.resultHash,
      runId: paperTrade.runId,
      status: "paper-opened",
      strategyId: paperTrade.strategyId,
    });

    return Response.json({
      configured: true,
      paperTrade,
    });
  } catch (error) {
    return strategyErrorResponse(error);
  }
}

export async function handleStrategyScanPairs(request: Request) {
  const body = await readStrategyBody(request);

  if ("response" in body) {
    return body.response;
  }

  try {
    const source = await fetchStrategyBarsFromDune({
      queryId: readOptionalString(body.queryId),
      signal: request.signal,
    });
    const chain = readProductChainId(body.chain);
    const scan = scanLiquidityMomentumPairs({
      bars: source.bars,
      chain,
      candidateLimit: readPositiveNumber(body.limit, 12),
      params: body.params,
      queryId: source.queryId,
      sourceUrl: source.sourceUrl,
    });

    return Response.json({
      configured: true,
      scan,
    });
  } catch (error) {
    return strategyErrorResponse(error);
  }
}

export async function handleStrategyRuns(request: Request) {
  const body = await readStrategyBody(request);

  if ("response" in body) {
    return body.response;
  }

  try {
    return Response.json(
      await readTradingJournalRuns(
        readPositiveNumber(body.limit, 25),
        readProductChainId(body.chain)
      )
    );
  } catch (error) {
    return strategyErrorResponse(error);
  }
}

async function createBacktestFromBody(
  body: StrategyBody,
  request: Request
): Promise<StrategyBacktestPayload> {
  const source = await fetchStrategyBarsFromDune({
    queryId: readOptionalString(body.queryId),
    signal: request.signal,
  });

  return runLiquidityMomentumBacktest({
    bars: source.bars,
    chain: readProductChainId(body.chain),
    pairAddress: readOptionalString(body.pairAddress),
    params: body.params,
    queryId: source.queryId,
    sourceUrl: source.sourceUrl,
  });
}

async function readStrategyBody(
  request: Request
): Promise<StrategyBody | { response: Response }> {
  try {
    const body = (await request.json().catch(() => ({}))) as StrategyBody;

    return body && typeof body === "object" ? body : {};
  } catch {
    return {
      response: Response.json(
        { configured: false, error: "Request body must be valid JSON." },
        { status: 400 }
      ),
    };
  }
}

function strategyErrorResponse(error: unknown) {
  const message =
    error instanceof Error ? error.message : "Strategy request failed.";
  const status =
    /DUNE_|Dune strategy query|LANGCLAW_TRADING_JOURNAL_ADDRESS|Set /.test(message)
      ? 503
      : 400;

  return Response.json(
    {
      configured: false,
      error: message,
    },
    { status }
  );
}

function readOptionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readPositiveNumber(value: unknown, fallback: number) {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value)
        : Number.NaN;

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
