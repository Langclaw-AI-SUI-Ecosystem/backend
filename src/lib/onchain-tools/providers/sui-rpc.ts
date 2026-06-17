import { fetchJson, readString } from "./http";

const DEFAULT_SUI_MAINNET_RPC_URL = "https://fullnode.mainnet.sui.io:443";
const COINGECKO_BASE_URL = "https://api.coingecko.com/api/v3";

type SuiCexAddressLabel = {
  sourceCex?: unknown;
  wallet?: unknown;
  walletLabel?: unknown;
};

type SuiBalanceChange = {
  amount?: string;
  coinType?: string;
  owner?: {
    AddressOwner?: string;
  };
};

type SuiTransactionBlock = {
  balanceChanges?: SuiBalanceChange[];
  digest?: string;
  timestampMs?: string;
};

type SuiCoinMetadata = {
  decimals?: number;
  symbol?: string;
};

type RpcCexAddress = {
  sourceCex: string;
  wallet: string;
};

type RpcWithdrawalGroup = {
  amount: number;
  digests: Set<string>;
  firstSeen: number;
  lastSeen: number;
  netUsd: number;
  sourceCex: string;
  tokenSymbol: string;
  wallet: string;
};

const stableSymbols = new Set(["USDC", "USDT", "USDY", "USDS"]);
const coinGeckoIdsBySymbol: Record<string, string> = {
  CETUS: "cetus-protocol",
  SUI: "sui",
};

export async function getSuiCexWithdrawalsFromRpc(input: {
  addresses: SuiCexAddressLabel[];
  limitPerAddress?: number;
  minUsd: number;
  signal?: AbortSignal;
  symbol: string;
  windowDays: number;
}): Promise<{
  checkedAddresses: number;
  rows: Array<Record<string, unknown>>;
  sourceUrl: string;
}> {
  const rpcUrl =
    process.env.SUI_ANALYTICS_RPC_URL?.trim() ||
    process.env.SUI_MAINNET_RPC_URL?.trim() ||
    DEFAULT_SUI_MAINNET_RPC_URL;
  const addressLimit = Math.max(
    1,
    Math.min(readPositiveInteger(process.env.SUI_RPC_CEX_ADDRESS_LIMIT, 10), 25)
  );
  const limitPerAddress = Math.max(
    1,
    Math.min(input.limitPerAddress ?? 50, 50)
  );
  const cexAddresses = input.addresses
    .map(normalizeCexAddressLabel)
    .filter((address): address is RpcCexAddress => Boolean(address))
    .slice(0, addressLimit);
  const minTimestamp = Date.now() - input.windowDays * 24 * 60 * 60 * 1000;
  const metadataCache = new Map<string, SuiCoinMetadata>();
  const priceCache = new Map<string, number>();
  const groups = new Map<string, RpcWithdrawalGroup>();

  for (const cexAddress of cexAddresses) {
    const transactions = await queryTransactionBlocks({
      address: cexAddress.wallet,
      limit: limitPerAddress,
      rpcUrl,
      signal: input.signal,
    });

    for (const transaction of transactions) {
      const timestampMs = Number(transaction.timestampMs);

      if (!Number.isFinite(timestampMs) || timestampMs < minTimestamp) {
        continue;
      }

      await addRpcWithdrawalGroups({
        cexAddress,
        groups,
        metadataCache,
        priceCache,
        rpcUrl,
        signal: input.signal,
        symbol: input.symbol,
        timestampMs,
        transaction,
      });
    }
  }

  const rows = [...groups.values()]
    .filter((group) => group.netUsd >= input.minUsd)
    .sort((left, right) => right.netUsd - left.netUsd)
    .slice(0, 25)
    .map((group) => ({
      amount: roundNumber(group.amount, 6),
      dataSourceDiagnostic:
        "Sui RPC transaction blocks joined with Dune cex.addresses | withdrawal-only | USD estimated from current price",
      netUsd: roundNumber(group.netUsd, 2),
      retentionAfterBuy: "unavailable",
      sellPressureAfterBuy: "unavailable",
      signal: "CEX withdrawal",
      smartMoneyStatus: "candidate_smart_money",
      sourceCex: group.sourceCex,
      sourceChain: "Sui",
      sourceTable: "Sui RPC transaction blocks + Dune cex.addresses",
      tokenCategory: "cex exchange outflow",
      tokenSymbol: group.tokenSymbol,
      transfers: group.digests.size,
      wallet: group.wallet,
      walletLabel: "unavailable",
      walletNetWorth: "unavailable",
      walletType: "unavailable",
      window: `${formatDate(group.firstSeen)} to ${formatDate(group.lastSeen)}`,
    }));

  return {
    checkedAddresses: cexAddresses.length,
    rows,
    sourceUrl: rpcUrl,
  };
}

async function queryTransactionBlocks({
  address,
  limit,
  rpcUrl,
  signal,
}: {
  address: string;
  limit: number;
  rpcUrl: string;
  signal?: AbortSignal;
}) {
  const payload = await suiRpcCall<{
    data?: SuiTransactionBlock[];
  }>({
    method: "suix_queryTransactionBlocks",
    params: [
      {
        filter: { FromAddress: address },
        options: { showBalanceChanges: true, showInput: true },
      },
      null,
      limit,
      true,
    ],
    rpcUrl,
    signal,
  });

  return Array.isArray(payload.data) ? payload.data : [];
}

async function addRpcWithdrawalGroups({
  cexAddress,
  groups,
  metadataCache,
  priceCache,
  rpcUrl,
  signal,
  symbol,
  timestampMs,
  transaction,
}: {
  cexAddress: RpcCexAddress;
  groups: Map<string, RpcWithdrawalGroup>;
  metadataCache: Map<string, SuiCoinMetadata>;
  priceCache: Map<string, number>;
  rpcUrl: string;
  signal?: AbortSignal;
  symbol: string;
  timestampMs: number;
  transaction: SuiTransactionBlock;
}) {
  const cexLower = cexAddress.wallet.toLowerCase();
  const balanceChanges = Array.isArray(transaction.balanceChanges)
    ? transaction.balanceChanges
    : [];
  const outgoing = balanceChanges.filter((change) => {
    const owner = readOwnerAddress(change).toLowerCase();
    const amount = readBigInt(change.amount);

    return owner === cexLower && amount < 0n && Boolean(change.coinType);
  });

  for (const change of outgoing) {
    const coinType = readString(change.coinType);
    const recipient = findRecipientChange(balanceChanges, coinType, cexLower);

    if (!recipient) {
      continue;
    }

    const metadata = await getCoinMetadata({
      cache: metadataCache,
      coinType,
      rpcUrl,
      signal,
    });
    const tokenSymbol = readString(metadata.symbol).toUpperCase() ||
      coinType.split("::").pop()?.toUpperCase() ||
      "TOKEN";

    if (symbol && tokenSymbol !== symbol.toUpperCase()) {
      continue;
    }

    const decimals = Number(metadata.decimals);
    const rawAmount = readBigInt(recipient.amount);
    const amount = toTokenAmount(rawAmount, decimals);
    const priceUsd = await getUsdPrice({
      cache: priceCache,
      signal,
      symbol: tokenSymbol,
    });

    if (!Number.isFinite(amount) || amount <= 0 || priceUsd <= 0) {
      continue;
    }

    const wallet = readOwnerAddress(recipient);
    const key = [
      wallet.toLowerCase(),
      cexAddress.sourceCex.toLowerCase(),
      tokenSymbol,
      "CEX withdrawal",
    ].join("|");
    const group = groups.get(key) ?? {
      amount: 0,
      digests: new Set<string>(),
      firstSeen: timestampMs,
      lastSeen: timestampMs,
      netUsd: 0,
      sourceCex: cexAddress.sourceCex,
      tokenSymbol,
      wallet,
    };

    group.amount += amount;
    group.netUsd += amount * priceUsd;
    group.firstSeen = Math.min(group.firstSeen, timestampMs);
    group.lastSeen = Math.max(group.lastSeen, timestampMs);

    if (transaction.digest) {
      group.digests.add(transaction.digest);
    }

    groups.set(key, group);
  }
}

function findRecipientChange(
  balanceChanges: SuiBalanceChange[],
  coinType: string,
  cexLower: string
) {
  return balanceChanges
    .filter((change) => {
      const owner = readOwnerAddress(change).toLowerCase();
      const amount = readBigInt(change.amount);

      return owner && owner !== cexLower && change.coinType === coinType && amount > 0n;
    })
    .sort((left, right) => {
      const leftAmount = readBigInt(left.amount);
      const rightAmount = readBigInt(right.amount);

      return leftAmount === rightAmount ? 0 : leftAmount > rightAmount ? -1 : 1;
    })[0];
}

async function getCoinMetadata({
  cache,
  coinType,
  rpcUrl,
  signal,
}: {
  cache: Map<string, SuiCoinMetadata>;
  coinType: string;
  rpcUrl: string;
  signal?: AbortSignal;
}) {
  const cached = cache.get(coinType);

  if (cached) {
    return cached;
  }

  const metadata = await suiRpcCall<SuiCoinMetadata>({
    method: "suix_getCoinMetadata",
    params: [coinType],
    rpcUrl,
    signal,
  });

  cache.set(coinType, metadata);

  return metadata;
}

async function getUsdPrice({
  cache,
  signal,
  symbol,
}: {
  cache: Map<string, number>;
  signal?: AbortSignal;
  symbol: string;
}) {
  if (stableSymbols.has(symbol)) {
    return 1;
  }

  const cached = cache.get(symbol);

  if (cached !== undefined) {
    return cached;
  }

  const coinId = coinGeckoIdsBySymbol[symbol];

  if (!coinId) {
    cache.set(symbol, 0);

    return 0;
  }

  const url = new URL(`${COINGECKO_BASE_URL}/simple/price`);
  url.searchParams.set("ids", coinId);
  url.searchParams.set("vs_currencies", "usd");
  const headers = coinGeckoHeaders();
  const payload = await fetchJson(url.toString(), {
    headers,
    signal,
    timeoutMs: 12000,
  });
  const price = Number((payload as Record<string, Record<string, unknown>>)[coinId]?.usd);
  const resolved = Number.isFinite(price) && price > 0 ? price : 0;

  cache.set(symbol, resolved);

  return resolved;
}

async function suiRpcCall<T>({
  method,
  params,
  rpcUrl,
  signal,
}: {
  method: string;
  params: unknown[];
  rpcUrl: string;
  signal?: AbortSignal;
}) {
  const payload = await fetchJson(rpcUrl, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method,
      params,
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    signal,
    timeoutMs: 20000,
  });
  const error = (payload as { error?: { message?: string } }).error;

  if (error) {
    throw new Error(`Sui RPC ${method} error: ${error.message || "unexpected response"}.`);
  }

  return (payload as { result?: T }).result ?? ({} as T);
}

function normalizeCexAddressLabel(label: SuiCexAddressLabel) {
  const wallet = readString(label.wallet);

  if (!wallet) {
    return undefined;
  }

  return {
    sourceCex: readString(label.sourceCex) || readString(label.walletLabel) || "CEX",
    wallet,
  };
}

function readOwnerAddress(change: SuiBalanceChange) {
  return readString(change.owner?.AddressOwner);
}

function readBigInt(value: string | undefined) {
  try {
    return BigInt(value ?? "0");
  } catch {
    return 0n;
  }
}

function toTokenAmount(rawAmount: bigint, decimals: number) {
  const amount = Number(rawAmount);

  if (!Number.isFinite(amount)) {
    return 0;
  }

  if (!Number.isFinite(decimals) || decimals <= 0) {
    return amount;
  }

  return amount / 10 ** decimals;
}

function coinGeckoHeaders(): Record<string, string> {
  const apiKey = process.env.COINGECKO_API_KEY?.trim() || process.env.CG_API_KEY?.trim();

  return apiKey ? { "x-cg-demo-api-key": apiKey } : {};
}

function readPositiveInteger(value: string | undefined, fallback: number) {
  const number = Number(value);

  return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback;
}

function roundNumber(value: number, decimals: number) {
  const factor = 10 ** decimals;

  return Math.round(value * factor) / factor;
}

function formatDate(timestampMs: number) {
  return new Date(timestampMs).toISOString().slice(0, 10);
}
