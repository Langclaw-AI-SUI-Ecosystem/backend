const apiBase = process.env.LANGCLAW_API_URL || "http://localhost:3001";
const pairAddress =
  process.env.LANGCLAW_STRATEGY_SAMPLE_PAIR ||
  "0x365722f12ceb2063286a268b03c654df81b7c00f";

const backtestPayload = await postJson("/api/strategy/backtest", {
  pairAddress,
});
const backtest = backtestPayload.backtest;

if (!backtest) {
  throw new Error(`Backtest response did not include backtest: ${JSON.stringify(backtestPayload)}`);
}

const paperPayload = await postJson("/api/strategy/paper-trade", {
  backtest,
  notionalUsd: 1000,
});
const paperTrade = paperPayload.paperTrade;

if (!paperTrade) {
  throw new Error(`Paper trade response did not include paperTrade: ${JSON.stringify(paperPayload)}`);
}

console.log(
  JSON.stringify(
    {
      backtest: {
        bars: backtest.bars.length,
        explorerUrl: backtest.proof.explorerUrl,
        latestAction: backtest.latestSignal.action,
        market: backtest.market,
        maxDrawdownBps: backtest.metrics.maxDrawdownBps,
        proofStatus: backtest.proof.status,
        runId: backtest.runId,
        totalPnlBps: backtest.metrics.totalPnlBps,
        totalPnlUsd: backtest.metrics.totalPnlUsd,
        trades: backtest.trades.length,
        txHash: backtest.proof.txHash,
        winRate: backtest.metrics.winRate,
      },
      paperTrade: {
        action: paperTrade.action,
        confidence: paperTrade.confidence,
        explorerUrl: paperTrade.proof.explorerUrl,
        notionalUsd: paperTrade.notionalUsd,
        proofStatus: paperTrade.proof.status,
        runId: paperTrade.runId,
        txHash: paperTrade.proof.txHash,
      },
    },
    null,
    2
  )
);

async function postJson(path, body) {
  const response = await fetch(`${apiBase}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`${path} failed ${response.status}: ${text}`);
  }

  return JSON.parse(text);
}
