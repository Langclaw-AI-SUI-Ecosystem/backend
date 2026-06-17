import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPaperTrade,
  parseDuneHistoricalRows,
  runLiquidityMomentumBacktest,
  scanLiquidityMomentumPairs,
} from "./backtest";

const pairAddress = "0xeAfc4D6d4c3391Cd4Fc10c85D2f5f972d58C0dD5";

test("parses Dune historical rows", () => {
  const rows = parseDuneHistoricalRows({
    result: {
      rows: [
        {
          liquidity_usd: "100000",
          net_whale_flow_usd: "2500",
          pair_address: pairAddress,
          price_usd: "1.02",
          timestamp: "2026-05-19T00:00:00Z",
          tx_count: "42",
          volume_usd: "25000",
        },
      ],
    },
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].pairAddress, pairAddress);
  assert.equal(rows[0].priceUsd, 1.02);
  assert.equal(rows[0].liquidityUsd, 100000);
  assert.equal(rows[0].volumeUsd, 25000);
  assert.equal(rows[0].txCount, 42);
});

test("backtest computes trades, PnL, win rate, and drawdown", () => {
  const backtest = runLiquidityMomentumBacktest({
    bars: parseDuneHistoricalRows({
      result: {
        rows: [
          row("2026-05-19T00:00:00Z", "1.00", "10000"),
          row("2026-05-19T01:00:00Z", "1.02", "20000"),
          row("2026-05-19T02:00:00Z", "1.08", "22000"),
          row("2026-05-19T03:00:00Z", "1.14", "23000"),
        ],
      },
    }),
    generatedAt: "2026-05-19T04:00:00Z",
    pairAddress,
    queryId: "123456",
    runId: "bt-test",
    sourceUrl: "https://api.dune.com/api/v1/query/123456/results",
  });

  assert.equal(backtest.trades.length, 1);
  assert.equal(backtest.trades[0].reason, "take-profit");
  assert.ok(backtest.metrics.totalPnlUsd > 0);
  assert.ok(backtest.metrics.totalPnlBps > 0);
  assert.equal(backtest.metrics.winRate, 100);
  assert.equal(backtest.metrics.maxDrawdownBps, 0);
});

test("backtest scopes market and strategy IDs to the selected chain", () => {
  const backtest = runLiquidityMomentumBacktest({
    bars: parseDuneHistoricalRows({
      result: {
        rows: [
          row("2026-05-19T00:00:00Z", "1.00", "10000"),
          row("2026-05-19T01:00:00Z", "1.02", "20000"),
        ],
      },
    }),
    chain: "sui-testnet",
    generatedAt: "2026-05-19T02:00:00Z",
    pairAddress,
    queryId: "123456",
    runId: "bt-sui",
    sourceUrl: "https://api.dune.com/api/v1/query/123456/results",
  });

  assert.equal(backtest.chain, "sui-testnet");
  assert.equal(backtest.chainId, 1);
  assert.equal(backtest.market, `sui-testnet:${pairAddress}`);
  assert.equal(backtest.strategyId, "sui-testnet-liquidity-momentum-v1");
  assert.equal(backtest.title, "Sui Testnet Liquidity Momentum Strategy");
});

test("backtest without pair selects one liquid market instead of mixing pairs", () => {
  const liquidPair = "0x48c1a89af1102cad358549e9bb16ae5f96cddfec";
  const quietPair = "0x1606c79be3ebd70d8d40bac6287e23005cfbefa2";
  const backtest = runLiquidityMomentumBacktest({
    bars: parseDuneHistoricalRows({
      result: {
        rows: [
          row("2026-05-19T00:00:00Z", "1.00", "100", quietPair),
          row("2026-05-19T01:00:00Z", "1.01", "120", quietPair),
          row("2026-05-19T00:00:00Z", "1.00", "10000", liquidPair),
          row("2026-05-19T01:00:00Z", "1.02", "20000", liquidPair),
          row("2026-05-19T02:00:00Z", "1.08", "22000", liquidPair),
        ],
      },
    }),
    generatedAt: "2026-05-19T03:00:00Z",
    queryId: "123456",
    runId: "bt-default-pair",
    sourceUrl: "https://api.dune.com/api/v1/query/123456/results",
  });

  assert.equal(backtest.pairAddress, liquidPair);
  assert.ok(backtest.bars.every((bar) => bar.pairAddress === liquidPair));
});

test("pair scan ranks candidates and returns the best isolated backtest", () => {
  const winningPair = "0x365722f12ceb2063286a268b03c654df81b7c00f";
  const noisyPair = "0x1606c79be3ebd70d8d40bac6287e23005cfbefa2";
  const scan = scanLiquidityMomentumPairs({
    bars: parseDuneHistoricalRows({
      result: {
        rows: [
          row("2026-05-19T00:00:00Z", "1.00", "25000", winningPair),
          row("2026-05-19T01:00:00Z", "1.02", "26000", winningPair),
          row("2026-05-19T02:00:00Z", "1.08", "27000", winningPair),
          row("2026-05-19T03:00:00Z", "1.14", "28000", winningPair),
          row("2026-05-19T00:00:00Z", "2.00", "30000", noisyPair),
          row("2026-05-19T01:00:00Z", "1.80", "31000", noisyPair),
          row("2026-05-19T02:00:00Z", "1.60", "32000", noisyPair),
        ],
      },
    }),
    candidateLimit: 4,
    generatedAt: "2026-05-19T04:00:00Z",
    queryId: "123456",
    sourceUrl: "https://api.dune.com/api/v1/query/123456/results",
  });

  assert.equal(scan.selectedPairAddress, winningPair);
  assert.equal(scan.bestBacktest.pairAddress, winningPair);
  assert.equal(scan.candidates[0].rank, 1);
  assert.equal(scan.candidates[0].pairAddress, winningPair);
  assert.ok(scan.candidates[0].score > scan.candidates[1].score);
});

test("paper trade creates deterministic evidence hashes for identical inputs", () => {
  const backtest = runLiquidityMomentumBacktest({
    bars: parseDuneHistoricalRows({
      result: {
        rows: [
          row("2026-05-19T00:00:00Z", "1.00", "10000"),
          row("2026-05-19T01:00:00Z", "1.02", "20000"),
        ],
      },
    }),
    generatedAt: "2026-05-19T02:00:00Z",
    pairAddress,
    queryId: "123456",
    runId: "bt-paper",
    sourceUrl: "https://api.dune.com/api/v1/query/123456/results",
  });
  const left = buildPaperTrade({
    backtest,
    generatedAt: "2026-05-19T02:10:00Z",
    notionalUsd: 1000,
    runId: "paper-test",
  });
  const right = buildPaperTrade({
    backtest,
    generatedAt: "2026-05-19T02:10:00Z",
    notionalUsd: 1000,
    runId: "paper-test",
  });

  assert.equal(left.proof.decisionHash, right.proof.decisionHash);
  assert.equal(left.proof.resultHash, right.proof.resultHash);
  assert.equal(left.proof.evidenceUri, right.proof.evidenceUri);
});

function row(
  timestamp: string,
  price: string,
  volume: string,
  address = pairAddress
) {
  return {
    liquidity_usd: "100000",
    net_whale_flow_usd: "1000",
    pair_address: address,
    price_usd: price,
    timestamp,
    volume_usd: volume,
  };
}
