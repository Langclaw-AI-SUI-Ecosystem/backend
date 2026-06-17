import { getChainLookupTerms } from "../chains";
import type { OnChainProviderResponse } from "../types";
import { compactText, fetchJson } from "./http";

const baseUrl = "https://api.coingecko.com/api/v3/onchain";
const authHeaderName = "x-cg-demo-api-key";
const networkCacheTtlMs = 10 * 60 * 1000;

type GeckoTerminalOptions = {
  chain: string;
  pairAddress?: string;
  signal?: AbortSignal;
  tokenAddress?: string;
};

type SupportedNetwork = {
  id: string;
  name: string;
  coingeckoAssetPlatformId?: string;
};

let cachedNetworks:
  | {
      expiresAt: number;
      value: SupportedNetwork[];
    }
  | undefined;

export async function getNetworkTrendingPools(
  options: GeckoTerminalOptions
): Promise<OnChainProviderResponse> {
  const network = await resolveNetworkId(options.chain, options.signal);
  const url = new URL(`${baseUrl}/networks/${encodeURIComponent(network.id)}/trending_pools`);
  url.searchParams.set("include", "base_token,quote_token,dex");
  url.searchParams.set("duration", "24h");
  const sourceUrl = url.toString();
  const data = await fetchJson(sourceUrl, {
    headers: coinGeckoHeaders(),
    signal: options.signal,
  });

  return {
    data,
    sourceUrl,
    summary: `Fetched GeckoTerminal trending pools for ${network.name}. ${summarizePools(data)}`,
  };
}

export async function getNetworkNewPools(
  options: GeckoTerminalOptions
): Promise<OnChainProviderResponse> {
  const network = await resolveNetworkId(options.chain, options.signal);
  const url = new URL(`${baseUrl}/networks/${encodeURIComponent(network.id)}/new_pools`);
  url.searchParams.set("include", "base_token,quote_token,dex");
  const sourceUrl = url.toString();
  const data = await fetchJson(sourceUrl, {
    headers: coinGeckoHeaders(),
    signal: options.signal,
  });

  return {
    data,
    sourceUrl,
    summary: `Fetched GeckoTerminal new pools for ${network.name}. ${summarizePools(data)}`,
  };
}

export async function getPoolData(
  options: GeckoTerminalOptions
): Promise<OnChainProviderResponse> {
  const pairAddress = requireAddress(
    options.pairAddress || options.tokenAddress,
    "pool"
  );
  const network = await resolveNetworkId(options.chain, options.signal);
  const url = new URL(
    `${baseUrl}/networks/${encodeURIComponent(network.id)}/pools/${encodeURIComponent(pairAddress)}`
  );
  url.searchParams.set("include", "base_token,quote_token,dex");
  const sourceUrl = url.toString();
  const data = await fetchJson(sourceUrl, {
    headers: coinGeckoHeaders(),
    signal: options.signal,
  });

  return {
    data,
    sourceUrl,
    summary: `Fetched GeckoTerminal pool data for ${short(pairAddress)} on ${network.name}.`,
  };
}

export async function getTokenData(
  options: GeckoTerminalOptions
): Promise<OnChainProviderResponse> {
  const tokenAddress = requireAddress(options.tokenAddress, "token");
  const network = await resolveNetworkId(options.chain, options.signal);
  const sourceUrl = `${baseUrl}/networks/${encodeURIComponent(network.id)}/tokens/${encodeURIComponent(tokenAddress)}`;
  const data = await fetchJson(sourceUrl, {
    headers: coinGeckoHeaders(),
    signal: options.signal,
  });

  return {
    data,
    sourceUrl,
    summary: `Fetched GeckoTerminal token data for ${short(tokenAddress)} on ${network.name}.`,
  };
}

export async function getTokenInfo(
  options: GeckoTerminalOptions
): Promise<OnChainProviderResponse> {
  const tokenAddress = requireAddress(options.tokenAddress, "token");
  const network = await resolveNetworkId(options.chain, options.signal);
  const sourceUrl = `${baseUrl}/networks/${encodeURIComponent(network.id)}/tokens/${encodeURIComponent(tokenAddress)}/info`;
  const data = await fetchJson(sourceUrl, {
    headers: coinGeckoHeaders(),
    signal: options.signal,
  });

  return {
    data,
    sourceUrl,
    summary: `Fetched GeckoTerminal token info for ${short(tokenAddress)} on ${network.name}.`,
  };
}

export async function getTokenTopHolders(
  options: GeckoTerminalOptions
): Promise<OnChainProviderResponse> {
  const tokenAddress = requireAddress(options.tokenAddress, "token");
  const network = await resolveNetworkId(options.chain, options.signal);
  const sourceUrl = `${baseUrl}/networks/${encodeURIComponent(network.id)}/tokens/${encodeURIComponent(tokenAddress)}/top_holders`;
  const data = await fetchJson(sourceUrl, {
    headers: coinGeckoHeaders(),
    signal: options.signal,
  });

  return {
    data,
    sourceUrl,
    summary: `Fetched GeckoTerminal holder concentration data for ${short(tokenAddress)} on ${network.name}.`,
  };
}

async function resolveNetworkId(chain: string, signal?: AbortSignal) {
  const networks = await getSupportedNetworks(signal);
  const terms = new Set(getChainLookupTerms(chain));

  if (!networks.length) {
    const [fallbackId] = getChainLookupTerms(chain);

    return {
      id: fallbackId,
      name: chain,
    };
  }

  const direct = networks.find((network) => terms.has(network.id.toLowerCase()));

  if (direct) {
    return direct;
  }

  const byPlatform = networks.find((network) =>
    network.coingeckoAssetPlatformId
      ? terms.has(network.coingeckoAssetPlatformId.toLowerCase())
      : false
  );

  if (byPlatform) {
    return byPlatform;
  }

  const byName = networks.find((network) =>
    terms.has(network.name.trim().toLowerCase())
  );

  if (byName) {
    return byName;
  }

  throw new Error(`GeckoTerminal network mapping was not found for ${chain}.`);
}

async function getSupportedNetworks(signal?: AbortSignal) {
  const now = Date.now();

  if (cachedNetworks && cachedNetworks.expiresAt > now) {
    return cachedNetworks.value;
  }

  const sourceUrl = `${baseUrl}/networks`;
  const payload = await fetchJson(sourceUrl, {
    headers: coinGeckoHeaders(),
    signal,
  });
  const value = readNetworks(payload);

  cachedNetworks = {
    expiresAt: now + networkCacheTtlMs,
    value,
  };

  return value;
}

function readNetworks(payload: unknown): SupportedNetwork[] {
  const rows = Array.isArray((payload as { data?: unknown[] })?.data)
    ? ((payload as { data: unknown[] }).data)
    : [];
  const networks: SupportedNetwork[] = [];

  for (const row of rows) {
    if (!row || typeof row !== "object") {
      continue;
    }

    const item = row as {
      id?: unknown;
      attributes?: {
        name?: unknown;
        coingecko_asset_platform_id?: unknown;
      };
    };
    const id = readString(item.id);
    const name = readString(item.attributes?.name);

    if (!id || !name) {
      continue;
    }

    networks.push({
      coingeckoAssetPlatformId: readString(
        item.attributes?.coingecko_asset_platform_id
      ),
      id,
      name,
    });
  }

  return networks;
}

function summarizePools(payload: unknown) {
  const pools = Array.isArray((payload as { data?: unknown[] })?.data)
    ? ((payload as { data: unknown[] }).data)
    : [];

  if (!pools.length) {
    return "No pools returned.";
  }

  const first = pools[0] as {
    attributes?: {
      name?: unknown;
      reserve_in_usd?: unknown;
      volume_usd?: unknown;
    };
  };
  const name = readString(first.attributes?.name) || "Unnamed pool";
  const reserve = readString(first.attributes?.reserve_in_usd);
  const volume = readString(first.attributes?.volume_usd);

  return `${pools.length} pools returned. Top pool: ${name}${reserve ? ` reserve $${reserve}` : ""}${volume ? ` volume $${volume}` : ""}.`;
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

function requireAddress(value: string | undefined, label: string) {
  if (!value) {
    throw new Error(`A ${label} address is required.`);
  }

  return value;
}

function readString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function short(value: string) {
  return value.length > 12 ? `${value.slice(0, 6)}...${value.slice(-4)}` : value;
}

export function summarizeGeckoTerminalPayload(value: unknown) {
  return compactText(value);
}
