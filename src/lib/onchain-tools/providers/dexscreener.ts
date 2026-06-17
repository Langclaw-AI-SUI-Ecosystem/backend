import { getDexScreenerChainId } from "../chains";
import type { OnChainProviderResponse } from "../types";
import { compactText, fetchJson } from "./http";

const baseUrl = "https://api.dexscreener.com";

type DexOptions = {
  chain: string;
  pairAddress?: string;
  query?: string;
  signal?: AbortSignal;
  tokenAddress?: string;
};

export async function getLatestTokenProfiles(
  options: DexOptions
): Promise<OnChainProviderResponse> {
  const sourceUrl = `${baseUrl}/token-profiles/latest/v1`;
  const data = await fetchJson(sourceUrl, { signal: options.signal });

  return {
    data,
    sourceUrl,
    summary: `Fetched latest DEX Screener token profiles. ${summarizeArray(data)}`,
  };
}

export async function getLatestBoostedTokens(
  options: DexOptions
): Promise<OnChainProviderResponse> {
  const sourceUrl = `${baseUrl}/token-boosts/latest/v1`;
  const data = await fetchJson(sourceUrl, { signal: options.signal });

  return {
    data,
    sourceUrl,
    summary: `Fetched latest boosted tokens. ${summarizeArray(data)}`,
  };
}

export async function getTopBoostedTokens(
  options: DexOptions
): Promise<OnChainProviderResponse> {
  const sourceUrl = `${baseUrl}/token-boosts/top/v1`;
  const data = await fetchJson(sourceUrl, { signal: options.signal });

  return {
    data,
    sourceUrl,
    summary: `Fetched tokens with the most active boosts. ${summarizeArray(data)}`,
  };
}

export async function searchPairs(
  options: DexOptions
): Promise<OnChainProviderResponse> {
  const query = options.query?.trim();

  if (!query) {
    throw new Error("A search query is required.");
  }

  const url = new URL(`${baseUrl}/latest/dex/search`);
  url.searchParams.set("q", query);
  const sourceUrl = url.toString();
  const rawData = await fetchJson(sourceUrl, { signal: options.signal });
  const chainId = getDexScreenerChainId(options.chain);
  const data = filterPairsByChain(rawData, chainId);

  return {
    data,
    sourceUrl,
    summary: `Searched DEX pairs for "${query}" and filtered to ${chainId}. ${summarizePairs(data)}`,
  };
}

export async function getTokenPairs(
  options: DexOptions
): Promise<OnChainProviderResponse> {
  const tokenAddress = requireTokenAddress(options.tokenAddress);
  const chainId = getDexScreenerChainId(options.chain);
  const sourceUrl = `${baseUrl}/token-pairs/v1/${encodeURIComponent(
    chainId
  )}/${encodeURIComponent(tokenAddress)}`;
  const data = await fetchJson(sourceUrl, { signal: options.signal });

  return {
    data,
    sourceUrl,
    summary: `Fetched pools for token ${short(tokenAddress)} on ${chainId}. ${summarizePairs(data)}`,
  };
}

export async function getTokenSnapshot(
  options: DexOptions
): Promise<OnChainProviderResponse> {
  const tokenAddress = requireTokenAddress(options.tokenAddress);
  const chainId = getDexScreenerChainId(options.chain);
  const sourceUrl = `${baseUrl}/tokens/v1/${encodeURIComponent(
    chainId
  )}/${encodeURIComponent(tokenAddress)}`;
  const data = await fetchJson(sourceUrl, { signal: options.signal });

  return {
    data,
    sourceUrl,
    summary: `Fetched token market snapshot for ${short(tokenAddress)} on ${chainId}. ${summarizePairs(data)}`,
  };
}

export async function getPairSnapshot(
  options: DexOptions
): Promise<OnChainProviderResponse> {
  const pairAddress = options.pairAddress || options.tokenAddress;

  if (!pairAddress) {
    throw new Error("A pair address is required.");
  }

  const chainId = getDexScreenerChainId(options.chain);
  const sourceUrl = `${baseUrl}/latest/dex/pairs/${encodeURIComponent(
    chainId
  )}/${encodeURIComponent(pairAddress)}`;
  const data = await fetchJson(sourceUrl, { signal: options.signal });

  return {
    data,
    sourceUrl,
    summary: `Fetched pair snapshot for ${short(pairAddress)} on ${chainId}. ${summarizePairs(data)}`,
  };
}

export async function getPaidOrders(
  options: DexOptions
): Promise<OnChainProviderResponse> {
  const tokenAddress = requireTokenAddress(options.tokenAddress);
  const chainId = getDexScreenerChainId(options.chain);
  const sourceUrl = `${baseUrl}/orders/v1/${encodeURIComponent(
    chainId
  )}/${encodeURIComponent(tokenAddress)}`;
  const data = await fetchJson(sourceUrl, { signal: options.signal });

  return {
    data,
    sourceUrl,
    summary: `Checked DEX Screener paid order metadata for ${short(tokenAddress)}. ${summarizeArray(data)}`,
  };
}

function requireTokenAddress(tokenAddress: string | undefined) {
  if (!tokenAddress) {
    throw new Error("A token address is required.");
  }

  return tokenAddress;
}

function summarizeArray(value: unknown) {
  if (Array.isArray(value)) {
    return `${value.length} records returned.`;
  }

  return compactText(value);
}

function summarizePairs(value: unknown) {
  const pairs = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { pairs?: unknown }).pairs)
      ? ((value as { pairs: unknown[] }).pairs)
      : [];

  if (!pairs.length) {
    return "No pairs returned.";
  }

  const first = pairs[0] as {
    baseToken?: { symbol?: string };
    chainId?: string;
    dexId?: string;
    liquidity?: { usd?: number };
    priceUsd?: string;
  };
  const symbol = first.baseToken?.symbol || "token";
  const price = first.priceUsd ? ` price ${first.priceUsd}` : "";
  const liquidity =
    typeof first.liquidity?.usd === "number"
      ? ` liquidity $${Math.round(first.liquidity.usd).toLocaleString("en-US")}`
      : "";

  return `${pairs.length} pairs returned. Top pair: ${symbol} on ${first.dexId || first.chainId || "DEX"}${price}${liquidity}.`;
}

function filterPairsByChain(value: unknown, chainId: string) {
  const pairs = readPairs(value);
  const filtered = pairs.filter((pair) => {
    const pairChain = readPairChain(pair);

    return pairChain ? pairChain.toLowerCase() === chainId.toLowerCase() : false;
  });

  if (Array.isArray(value)) {
    return filtered;
  }

  if (value && typeof value === "object") {
    return {
      ...(value as Record<string, unknown>),
      pairs: filtered,
    };
  }

  return value;
}

function readPairs(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (
    value &&
    typeof value === "object" &&
    Array.isArray((value as { pairs?: unknown }).pairs)
  ) {
    return (value as { pairs: unknown[] }).pairs;
  }

  return [];
}

function readPairChain(value: unknown) {
  if (!value || typeof value !== "object") {
    return "";
  }

  const chainId = (value as { chainId?: unknown }).chainId;

  return typeof chainId === "string" ? chainId : "";
}

function short(value: string) {
  return value.length > 12 ? `${value.slice(0, 6)}...${value.slice(-4)}` : value;
}
