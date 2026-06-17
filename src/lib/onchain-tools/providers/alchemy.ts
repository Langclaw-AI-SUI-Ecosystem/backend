import { getAlchemyNetwork } from "../chains";
import type { OnChainProviderResponse } from "../types";
import { compactText, fetchJson, requireEnv } from "./http";

type AlchemyOptions = {
  chain: string;
  signal?: AbortSignal;
  tokenAddress?: string;
  walletAddress?: string;
};

export async function getTokenBalances(
  options: AlchemyOptions
): Promise<OnChainProviderResponse> {
  const walletAddress = requireWallet(options.walletAddress);
  const url = buildRpcUrl(options.chain);
  const data = await rpc(url.fetchUrl, "alchemy_getTokenBalances", [
    walletAddress,
    "erc20",
    { maxCount: 20 },
  ], options.signal);

  return {
    data,
    sourceUrl: url.sourceUrl,
    summary: `Fetched ERC-20 balances through Alchemy for ${short(walletAddress)}. ${compactText(data)}`,
  };
}

export async function getAssetTransfers(
  options: AlchemyOptions
): Promise<OnChainProviderResponse> {
  const walletAddress = requireWallet(options.walletAddress);
  const url = buildRpcUrl(options.chain);
  const data = await rpc(
    url.fetchUrl,
    "alchemy_getAssetTransfers",
    [
      {
        category: ["external", "erc20"],
        fromBlock: "0x0",
        maxCount: "0x14",
        order: "desc",
        toAddress: walletAddress,
        withMetadata: true,
      },
    ],
    options.signal
  );

  return {
    data,
    sourceUrl: url.sourceUrl,
    summary: `Fetched inbound transfers through Alchemy for ${short(walletAddress)}. ${compactText(data)}`,
  };
}

export async function getTokenMetadata(
  options: AlchemyOptions
): Promise<OnChainProviderResponse> {
  const tokenAddress = requireToken(options.tokenAddress);
  const url = buildRpcUrl(options.chain);
  const data = await rpc(
    url.fetchUrl,
    "alchemy_getTokenMetadata",
    [tokenAddress],
    options.signal
  );

  return {
    data,
    sourceUrl: url.sourceUrl,
    summary: `Fetched token metadata through Alchemy for ${short(tokenAddress)}. ${compactText(data)}`,
  };
}

function buildRpcUrl(chain: string) {
  const network = getAlchemyNetwork(chain);

  if (!network) {
    throw new Error(`Alchemy is not configured for ${chain}.`);
  }

  return {
    fetchUrl: `https://${network}.g.alchemy.com/v2/${requireEnv("ALCHEMY_API_KEY")}`,
    sourceUrl: `https://${network}.g.alchemy.com/v2/redacted`,
  };
}

async function rpc(
  sourceUrl: string,
  method: string,
  params: unknown[],
  signal: AbortSignal | undefined
) {
  return fetchJson(sourceUrl, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method,
      params,
    }),
    headers: {
      "Content-Type": "application/json",
    },
    method: "POST",
    signal,
  });
}

function requireWallet(walletAddress: string | undefined) {
  if (!walletAddress) {
    throw new Error("A wallet address is required.");
  }

  return walletAddress;
}

function requireToken(tokenAddress: string | undefined) {
  if (!tokenAddress) {
    throw new Error("A token address is required.");
  }

  return tokenAddress;
}

function short(value: string) {
  return value.length > 12 ? `${value.slice(0, 6)}...${value.slice(-4)}` : value;
}
