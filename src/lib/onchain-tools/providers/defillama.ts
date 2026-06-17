import type { OnChainProviderResponse } from "../types";
import { compactText, fetchJson } from "./http";

const apiUrl = "https://api.llama.fi";
const yieldsUrl = "https://yields.llama.fi";
const stablecoinsUrl = "https://stablecoins.llama.fi";

type DefiLlamaOptions = {
  chain: string;
  protocolSlug?: string;
  query?: string;
  signal?: AbortSignal;
};

export async function getProtocols(
  options: DefiLlamaOptions
): Promise<OnChainProviderResponse> {
  const sourceUrl = `${apiUrl}/protocols`;
  const data = await fetchJson(sourceUrl, { signal: options.signal });

  return {
    data,
    sourceUrl,
    summary: `Fetched DeFiLlama protocol TVL list. ${summarizeCount(data)}`,
  };
}

export async function getChains(
  options: DefiLlamaOptions
): Promise<OnChainProviderResponse> {
  const sourceUrl = `${apiUrl}/v2/chains`;
  const data = await fetchJson(sourceUrl, { signal: options.signal });

  return {
    data,
    sourceUrl,
    summary: `Fetched DeFiLlama chain TVL list. ${summarizeCount(data)}`,
  };
}

export async function getProtocol(
  options: DefiLlamaOptions
): Promise<OnChainProviderResponse> {
  const slug = options.protocolSlug || normalizeProtocolSlug(options.query);

  if (!slug) {
    throw new Error("A protocol slug or query is required.");
  }

  const sourceUrl = `${apiUrl}/protocol/${encodeURIComponent(slug)}`;
  const data = await fetchJson(sourceUrl, { signal: options.signal });

  return {
    data,
    sourceUrl,
    summary: `Fetched DeFiLlama protocol TVL detail for ${slug}. ${compactText(data)}`,
  };
}

export async function getYieldPools(
  options: DefiLlamaOptions
): Promise<OnChainProviderResponse> {
  const sourceUrl = `${yieldsUrl}/pools`;
  const data = await fetchJson(sourceUrl, { signal: options.signal });
  const chain = options.chain.toLowerCase();
  const filtered = filterPools(data, chain);

  return {
    data: filtered.length ? { data: filtered } : data,
    sourceUrl,
    summary: filtered.length
      ? `Fetched ${filtered.length} yield pools matching ${options.chain}.`
      : `Fetched DeFiLlama yield pools. ${compactText(data)}`,
  };
}

export async function getStablecoins(
  options: DefiLlamaOptions
): Promise<OnChainProviderResponse> {
  const sourceUrl = `${stablecoinsUrl}/stablecoins?includePrices=true`;
  const data = await fetchJson(sourceUrl, { signal: options.signal });

  return {
    data,
    sourceUrl,
    summary: `Fetched DeFiLlama stablecoin supply data. ${summarizeStablecoins(data)}`,
  };
}

export function normalizeProtocolSlug(query: string | undefined) {
  const text = query?.trim().toLowerCase() || "";
  const patterns = [
    /\bprotocol(?:\s+(?:slug|detail|tvl))?\s+([a-z0-9-]{2,40})\b/i,
    /\b(?:slug|for)\s+([a-z0-9-]{2,40})\b/i,
    /\b([a-z0-9-]{2,40})\s+protocol\b/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const slug = match?.[1] || "";

    if (slug && !isGenericProtocolWord(slug)) {
      return slug;
    }
  }

  if (/^[a-z0-9-]{2,40}$/.test(text) && !isGenericProtocolWord(text)) {
    return text;
  }

  return "";
}

function isGenericProtocolWord(value: string) {
  return new Set([
    "by",
    "detail",
    "for",
    "list",
    "mantle",
    "momentum",
    "protocol",
    "protocols",
    "rank",
    "tvl",
    "yield",
  ]).has(value);
}

function filterPools(value: unknown, chain: string) {
  const pools =
    value && typeof value === "object" && Array.isArray((value as { data?: unknown }).data)
      ? (value as { data: Array<Record<string, unknown>> }).data
      : [];

  return pools
    .filter((pool) => String(pool.chain ?? "").toLowerCase() === chain)
    .slice(0, 20);
}

function summarizeCount(value: unknown) {
  if (Array.isArray(value)) {
    return `${value.length} records returned.`;
  }

  return compactText(value);
}

function summarizeStablecoins(value: unknown) {
  const assets =
    value &&
    typeof value === "object" &&
    Array.isArray((value as { peggedAssets?: unknown }).peggedAssets)
      ? (value as { peggedAssets: Array<Record<string, unknown>> }).peggedAssets
      : [];

  if (!assets.length) {
    return "No pegged asset records were returned.";
  }

  const top = assets
    .slice(0, 3)
    .map((asset) => asset.symbol || asset.name)
    .filter(Boolean)
    .join(", ");

  return top
    ? `${assets.length} pegged asset records returned. Top assets: ${top}.`
    : `${assets.length} pegged asset records returned.`;
}
