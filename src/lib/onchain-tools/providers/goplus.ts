import { getGoPlusChainId } from "../chains";
import type { OnChainProviderResponse } from "../types";
import { compactText, fetchJson } from "./http";

const baseUrl = "https://api.gopluslabs.io/api/v1";

type GoPlusOptions = {
  chain: string;
  signal?: AbortSignal;
  tokenAddress?: string;
  walletAddress?: string;
};

export async function getTokenSecurity(
  options: GoPlusOptions
): Promise<OnChainProviderResponse> {
  const tokenAddress = requireToken(options.tokenAddress);
  const sourceUrl = `${baseUrl}/token_security/${getGoPlusChainId(
    options.chain
  )}?contract_addresses=${encodeURIComponent(tokenAddress)}`;
  const data = await fetchJson(sourceUrl, {
    headers: buildHeaders(),
    signal: options.signal,
  });

  return {
    data,
    sourceUrl,
    summary: `Fetched GoPlus token security for ${short(tokenAddress)}. ${summarizeSecurity(data, tokenAddress)}`,
  };
}

export async function getAddressSecurity(
  options: GoPlusOptions
): Promise<OnChainProviderResponse> {
  const walletAddress = requireWallet(options.walletAddress);
  const url = new URL(`${baseUrl}/address_security/${walletAddress}`);
  url.searchParams.set("chain_id", String(getGoPlusChainId(options.chain)));
  const sourceUrl = url.toString();
  const data = await fetchJson(sourceUrl, {
    headers: buildHeaders(),
    signal: options.signal,
  });

  return {
    data,
    sourceUrl,
    summary: `Fetched GoPlus address security for ${short(walletAddress)}. ${compactText(data)}`,
  };
}

function buildHeaders() {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  const key = process.env.GOPLUS_API_KEY?.trim();
  const secret = process.env.GOPLUS_API_SECRET?.trim();

  if (key) {
    headers["X-API-KEY"] = key;
  }

  if (secret) {
    headers["X-API-SECRET"] = secret;
  }

  return headers;
}

function requireToken(tokenAddress: string | undefined) {
  if (!tokenAddress) {
    throw new Error("A token address is required.");
  }

  return tokenAddress;
}

function requireWallet(walletAddress: string | undefined) {
  if (!walletAddress) {
    throw new Error("A wallet address is required.");
  }

  return walletAddress;
}

function summarizeSecurity(value: unknown, tokenAddress: string) {
  if (!value || typeof value !== "object") {
    return compactText(value);
  }

  const result = (value as { result?: Record<string, Record<string, unknown>> }).result;
  const token = result?.[tokenAddress.toLowerCase()] || result?.[tokenAddress];

  if (!token) {
    return compactText(value);
  }

  const flags = [
    readFlag(token, "is_honeypot", "honeypot"),
    readFlag(token, "is_blacklisted", "blacklist"),
    readFlag(token, "is_mintable", "mintable"),
    readFlag(token, "can_take_back_ownership", "ownership reclaim"),
    readFlag(token, "is_proxy", "proxy"),
  ].filter(Boolean);
  const buyTax = token.buy_tax ? `buy tax ${token.buy_tax}` : "";
  const sellTax = token.sell_tax ? `sell tax ${token.sell_tax}` : "";

  return [flags.length ? `Flags: ${flags.join(", ")}.` : "No critical flag summary returned.", buyTax, sellTax]
    .filter(Boolean)
    .join(" ");
}

function readFlag(
  token: Record<string, unknown>,
  key: string,
  label: string
) {
  return token[key] === "1" || token[key] === 1 || token[key] === true
    ? label
    : "";
}

function short(value: string) {
  return value.length > 12 ? `${value.slice(0, 6)}...${value.slice(-4)}` : value;
}
