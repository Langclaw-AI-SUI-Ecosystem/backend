import type { OnChainProviderResponse } from "../types";
import { compactText, fetchJson } from "./http";

const baseUrl = "https://api.coingecko.com/api/v3";
const authHeaderName = "x-cg-demo-api-key";

type CoinGeckoOptions = {
  query?: string;
  signal?: AbortSignal;
};

type CoinSearchResult = {
  id: string;
  name: string;
  symbol: string;
  marketCapRank?: number;
};

export async function searchCoin(
  options: CoinGeckoOptions
): Promise<OnChainProviderResponse> {
  const search = await resolveCoinSearch(options.query, options.signal);

  return {
    data: search.bestMatch
      ? {
          bestMatch: search.bestMatch,
          query: search.term,
          raw: search.payload,
        }
      : {
          query: search.term,
          raw: search.payload,
        },
    sourceUrl: search.sourceUrl,
    summary: search.bestMatch
      ? `Resolved "${search.term}" to CoinGecko coin id ${search.bestMatch.id}.`
      : `CoinGecko search returned no listed asset match for "${search.term}".`,
  };
}

export async function getCoinMarkets(
  options: CoinGeckoOptions
): Promise<OnChainProviderResponse> {
  const search = await resolveCoinSearch(options.query, options.signal);

  if (!search.bestMatch?.id) {
    throw new Error(`CoinGecko search did not resolve a listed asset for "${search.term}".`);
  }

  const url = new URL(`${baseUrl}/coins/markets`);
  url.searchParams.set("vs_currency", "usd");
  url.searchParams.set("ids", search.bestMatch.id);
  url.searchParams.set("order", "market_cap_desc");
  url.searchParams.set("per_page", "1");
  url.searchParams.set("page", "1");
  url.searchParams.set("sparkline", "false");
  const sourceUrl = url.toString();
  const data = await fetchJson(sourceUrl, {
    headers: coinGeckoHeaders(),
    signal: options.signal,
  });
  const market = Array.isArray(data) ? data[0] : undefined;

  return {
    data: {
      coin: search.bestMatch,
      market,
    },
    sourceUrl,
    summary: market
      ? `Fetched CoinGecko market data for ${search.bestMatch.name} (${search.bestMatch.symbol.toUpperCase()}).`
      : `CoinGecko returned no market rows for ${search.bestMatch.name}.`,
  };
}

async function resolveCoinSearch(query: string | undefined, signal?: AbortSignal) {
  const term = extractCoinSearchTerm(query);

  if (!term) {
    throw new Error("A coin name or symbol is required for CoinGecko search.");
  }

  const url = new URL(`${baseUrl}/search`);
  url.searchParams.set("query", term);
  const sourceUrl = url.toString();
  const payload = await fetchJson(sourceUrl, {
    headers: coinGeckoHeaders(),
    signal,
  });
  const bestMatch = pickBestCoinMatch(payload);

  return {
    bestMatch,
    payload,
    sourceUrl,
    term,
  };
}

function pickBestCoinMatch(payload: unknown): CoinSearchResult | undefined {
  const coins = Array.isArray((payload as { coins?: unknown[] })?.coins)
    ? ((payload as { coins: unknown[] }).coins)
    : [];

  const candidates: CoinSearchResult[] = [];

  for (const coin of coins) {
    if (!coin || typeof coin !== "object") {
      continue;
    }

    const item = coin as Record<string, unknown>;
    const id = readString(item.id);
    const name = readString(item.name);
    const symbol = readString(item.symbol);

    if (!id || !name || !symbol) {
      continue;
    }

    candidates.push({
      id,
      marketCapRank:
        typeof item.market_cap_rank === "number" ? item.market_cap_rank : undefined,
      name,
      symbol,
    });
  }

  if (!candidates.length) {
    return undefined;
  }

  candidates.sort((left, right) => {
    const leftRank = left.marketCapRank ?? Number.MAX_SAFE_INTEGER;
    const rightRank = right.marketCapRank ?? Number.MAX_SAFE_INTEGER;

    return leftRank - rightRank;
  });

  return candidates[0];
}

function extractCoinSearchTerm(query: string | undefined) {
  const value = query?.trim();

  if (!value) {
    return "";
  }

  const uppercaseTicker = Array.from(value.matchAll(/\b[A-Z][A-Z0-9]{1,9}\b/g))
    .map((match) => match[0])
    .find((ticker) => !tickerStopwords.has(ticker));

  if (uppercaseTicker) {
    return uppercaseTicker;
  }

  const cleaned = value
    .replace(/\b(find|show|get|detect|analy[sz]e?|check|track|rank|watch|screen)\b/gi, " ")
    .replace(/\b(price|market|markets|liquidity|signal|signals|token|tokens|coin|coins|pair|pairs|pool|pools|smart[-\s]?money|yield|tvl|protocol|protocols|holders|security|risk|trending|new)\b/gi, " ")
    .replace(/\b(on|for|of|and|with|the|a|an)\b/gi, " ")
    .replace(/[.,:;()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned;
}

function coinGeckoHeaders(): Record<string, string> {
  const apiKey = readCoinGeckoApiKey();

  if (!apiKey) {
    return {};
  }

  return {
    [authHeaderName]: apiKey,
  };
}

function readCoinGeckoApiKey() {
  return process.env.COINGECKO_API_KEY?.trim() || process.env.CG_API_KEY?.trim();
}

function readString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

const tickerStopwords = new Set(["DEX", "EVM", "TVL", "USD"]);

export function summarizeCoinGeckoPayload(value: unknown) {
  return compactText(value);
}
