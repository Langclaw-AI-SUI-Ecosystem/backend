import type { StrategyMarketBar } from "./types";
import { parseDuneHistoricalRows } from "./backtest";

const duneBaseUrl = "https://api.dune.com/api/v1";

export type DuneStrategyBars = {
  bars: StrategyMarketBar[];
  queryId: string;
  sourceUrl: string;
};

export async function fetchStrategyBarsFromDune({
  queryId,
  signal,
}: {
  queryId?: string;
  signal?: AbortSignal;
}): Promise<DuneStrategyBars> {
  const resolvedQueryId =
    queryId?.trim() ||
    process.env.DUNE_STRATEGY_QUERY_ID?.trim() ||
    process.env.DUNE_DEFAULT_QUERY_ID?.trim();

  if (!resolvedQueryId) {
    throw new Error("Set DUNE_STRATEGY_QUERY_ID or include a Dune query id.");
  }

  const apiKey = process.env.DUNE_API_KEY?.trim();

  if (!apiKey) {
    throw new Error("Set DUNE_API_KEY to run Strategy Lab backtests.");
  }

  const sourceUrl = `${duneBaseUrl}/query/${encodeURIComponent(
    resolvedQueryId
  )}/results`;
  const response = await fetch(sourceUrl, {
    headers: {
      "X-Dune-API-Key": apiKey,
    },
    signal,
  });

  if (!response.ok) {
    throw new Error(`Dune strategy query failed with status ${response.status}.`);
  }

  const payload = await response.json();
  const bars = parseDuneHistoricalRows(payload);

  if (!bars.length) {
    throw new Error(
      "Dune strategy query returned no rows matching timestamp, pair_address, price_usd, liquidity_usd, and volume_usd."
    );
  }

  return {
    bars,
    queryId: resolvedQueryId,
    sourceUrl,
  };
}
