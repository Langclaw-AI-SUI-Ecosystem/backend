import { getEtherscanChainId } from "../chains";
import type { OnChainProviderResponse } from "../types";
import { compactText, fetchJson, requireEnv } from "./http";

const baseUrl = "https://api.etherscan.io/v2/api";

type EtherscanOptions = {
  chain: string;
  signal?: AbortSignal;
  tokenAddress?: string;
  walletAddress?: string;
};

export async function getAccountBalance(
  options: EtherscanOptions
): Promise<OnChainProviderResponse> {
  const walletAddress = requireWallet(options.walletAddress);
  const url = buildUrl(options.chain, {
    action: "balance",
    address: walletAddress,
    module: "account",
    tag: "latest",
  });
  const data = await fetchJson(url.fetchUrl, { signal: options.signal });

  return {
    data,
    sourceUrl: url.sourceUrl,
    summary: `Fetched native account balance for ${short(walletAddress)}. ${summarizeEtherscan(data)}`,
  };
}

export async function getTokenTransfers(
  options: EtherscanOptions
): Promise<OnChainProviderResponse> {
  const walletAddress = options.walletAddress;
  const tokenAddress = options.tokenAddress;

  if (!walletAddress && !tokenAddress) {
    throw new Error("A wallet address or token address is required.");
  }

  const params: Record<string, string> = {
    action: "tokentx",
    module: "account",
    offset: "20",
    page: "1",
    sort: "desc",
  };

  if (walletAddress) {
    params.address = walletAddress;
  }

  if (tokenAddress) {
    params.contractaddress = tokenAddress;
  }

  const url = buildUrl(options.chain, params);
  const data = await fetchJson(url.fetchUrl, { signal: options.signal });

  return {
    data,
    sourceUrl: url.sourceUrl,
    summary: `Fetched token transfer activity. ${summarizeTokenTransfers(data)}`,
  };
}

export async function getTxList(
  options: EtherscanOptions
): Promise<OnChainProviderResponse> {
  const walletAddress = requireWallet(options.walletAddress);
  const url = buildUrl(options.chain, {
    action: "txlist",
    address: walletAddress,
    module: "account",
    offset: "20",
    page: "1",
    sort: "desc",
  });
  const data = await fetchJson(url.fetchUrl, { signal: options.signal });

  return {
    data,
    sourceUrl: url.sourceUrl,
    summary: `Fetched recent account transactions for ${short(walletAddress)}. ${summarizeEtherscan(data)}`,
  };
}

export async function getTokenBalance(
  options: EtherscanOptions
): Promise<OnChainProviderResponse> {
  const walletAddress = requireWallet(options.walletAddress);
  const tokenAddress = requireToken(options.tokenAddress);
  const url = buildUrl(options.chain, {
    action: "tokenbalance",
    address: walletAddress,
    contractaddress: tokenAddress,
    module: "account",
    tag: "latest",
  });
  const data = await fetchJson(url.fetchUrl, { signal: options.signal });

  return {
    data,
    sourceUrl: url.sourceUrl,
    summary: `Fetched token balance for ${short(walletAddress)} and ${short(tokenAddress)}. ${summarizeEtherscan(data)}`,
  };
}

export async function getCode(
  options: EtherscanOptions
): Promise<OnChainProviderResponse> {
  const tokenAddress = requireToken(options.tokenAddress);
  const url = buildUrl(options.chain, {
    action: "eth_getCode",
    address: tokenAddress,
    module: "proxy",
    tag: "latest",
  });
  const data = await fetchJson(url.fetchUrl, { signal: options.signal });

  return {
    data,
    sourceUrl: url.sourceUrl,
    summary: `Fetched contract bytecode status for ${short(tokenAddress)}. ${summarizeEtherscan(data)}`,
  };
}

function buildUrl(chain: string, params: Record<string, string>) {
  const url = new URL(baseUrl);

  url.searchParams.set("chainid", String(getEtherscanChainId(chain)));
  url.searchParams.set("apikey", requireEnv("ETHERSCAN_API_KEY"));

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const redacted = new URL(url);
  redacted.searchParams.set("apikey", "redacted");

  return {
    fetchUrl: url.toString(),
    sourceUrl: redacted.toString(),
  };
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

function summarizeEtherscan(value: unknown) {
  if (!value || typeof value !== "object") {
    return compactText(value);
  }

  const record = value as { message?: unknown; result?: unknown; status?: unknown };
  const result = record.result;

  if (Array.isArray(result)) {
    return `${result.length} records returned.`;
  }

  if (typeof result === "string") {
    return `${String(record.message || "Result")}: ${result.slice(0, 80)}.`;
  }

  return compactText(value);
}

function summarizeTokenTransfers(value: unknown) {
  if (!value || typeof value !== "object") {
    return compactText(value);
  }

  const record = value as { result?: unknown };
  const transfers = Array.isArray(record.result)
    ? record.result.filter(isTransferRecord)
    : [];

  if (!transfers.length) {
    return summarizeEtherscan(value);
  }

  const latest = transfers[0];
  const largest = [...transfers].sort(
    (a, b) => compareTransferValue(b, a)
  )[0];
  const uniqueSenders = new Set(transfers.map((item) => item.from.toLowerCase()));
  const uniqueReceivers = new Set(transfers.map((item) => item.to.toLowerCase()));

  return [
    `${transfers.length} records returned`,
    `latest ${formatTransfer(latest)}`,
    largest && largest !== latest ? `largest ${formatTransfer(largest)}` : "",
    `${uniqueSenders.size} unique sender(s), ${uniqueReceivers.size} unique receiver(s)`,
  ]
    .filter(Boolean)
    .join(". ") + ".";
}

type TransferRecord = {
  from: string;
  hash?: string;
  timeStamp?: string;
  to: string;
  tokenDecimal?: string;
  tokenSymbol?: string;
  value: string;
};

function isTransferRecord(value: unknown): value is TransferRecord {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    typeof record.from === "string" &&
    typeof record.to === "string" &&
    typeof record.value === "string"
  );
}

function compareTransferValue(a: TransferRecord, b: TransferRecord) {
  const left = parseRawTokenValue(a.value);
  const right = parseRawTokenValue(b.value);

  if (left > right) {
    return 1;
  }

  if (left < right) {
    return -1;
  }

  return 0;
}

function formatTransfer(transfer: TransferRecord) {
  const symbol = transfer.tokenSymbol || "token";
  const amount = formatTokenAmount(
    parseRawTokenValue(transfer.value),
    readTokenDecimals(transfer.tokenDecimal)
  );
  const tx = transfer.hash ? ` tx ${short(transfer.hash)}` : "";

  return `${amount} ${symbol} from ${short(transfer.from)} to ${short(transfer.to)}${tx}`;
}

function parseRawTokenValue(value: string) {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function readTokenDecimals(value: string | undefined) {
  const parsed = Number.parseInt(value ?? "", 10);

  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(parsed, 36) : 18;
}

function formatTokenAmount(value: bigint, decimals: number) {
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = value % base;

  if (fraction === 0n) {
    return formatBigInt(whole);
  }

  const fractionText = fraction
    .toString()
    .padStart(decimals, "0")
    .slice(0, 4)
    .replace(/0+$/, "");

  return `${formatBigInt(whole)}${fractionText ? `.${fractionText}` : ""}`;
}

function formatBigInt(value: bigint) {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function short(value: string) {
  return value.length > 12 ? `${value.slice(0, 6)}...${value.slice(-4)}` : value;
}
