import type { OnChainProviderResponse } from "../types";
import { compactText, fetchJson, readString } from "./http";

/**
 * Sui-native smart-money / holder data via the BlockVision Sui Indexer API.
 *
 * Sui JSON-RPC has no holder-enumeration endpoint (getBalance/getCoins are
 * per-address), so a real "smart-money accumulation" holder table needs an
 * indexer. BlockVision's `coin/holders` returns the ranked top holders of a
 * coin WITH labels (Binance, OKX, …), which maps directly onto the smart-money
 * report table (`collectStructuredRows` reads `data.rows[].account/balance`).
 *
 * Note: BlockVision indexes Sui MAINNET. Holder data is mainnet regardless of
 * the product proof chain. You research real mainnet assets.
 */

const DEFAULT_BASE_URL = "https://api.blockvision.org/v2/sui";

// Verified coin types (mainnet). Used to resolve a bare $SYMBOL in the query.
// Keep entries verified — a wrong coin type returns an empty holder list.
const KNOWN_COIN_TYPES: Record<string, string> = {
  CETUS:
    "0x06864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS",
};

const COIN_TYPE_PATTERN = /0x[0-9a-fA-F]+::[a-zA-Z0-9_]+::[a-zA-Z0-9_]+/;

type BlockVisionHolder = {
  account?: string;
  address?: string;
  balance?: string | number;
  quantity?: string | number;
  percentage?: string | number;
  name?: string;
  website?: string;
};

type BlockVisionActivityCoinChange = {
  amount?: string | number;
  coinAddress?: string;
  decimal?: string | number;
  symbol?: string;
  usdValue?: string | number;
};

type BlockVisionActivityAddress = {
  address?: string;
  name?: string;
  type?: string;
};

type BlockVisionActivity = {
  coinChanges?: BlockVisionActivityCoinChange[];
  digest?: string;
  interactAddresses?: BlockVisionActivityAddress[];
  sender?: string;
  status?: string;
  timestampMs?: string | number;
  type?: string;
};

type SuiCexAddressLabel = {
  sourceCex?: unknown;
  wallet?: unknown;
  walletLabel?: unknown;
};

type CexActivityGroup = {
  amount: number;
  digests: Set<string>;
  firstSeen: number;
  lastSeen: number;
  netUsd: number;
  signal: "CEX deposit" | "CEX withdrawal";
  sourceCex: string;
  tokenSymbol: string;
  wallet: string;
};

export type SuiCoinHoldersInput = {
  chain?: string;
  query?: string;
  rawQuery?: string;
  signal?: AbortSignal;
  tokenAddress?: string;
};

export function isBlockVisionEnabled() {
  return (
    process.env.SUI_BLOCKVISION_ENABLED?.trim().toLowerCase() === "true" &&
    Boolean(process.env.SUI_BLOCKVISION_API_KEY?.trim())
  );
}

export async function getSuiCoinHolders(
  input: SuiCoinHoldersInput
): Promise<OnChainProviderResponse> {
  const apiKey = process.env.SUI_BLOCKVISION_API_KEY?.trim();

  if (process.env.SUI_BLOCKVISION_ENABLED?.trim().toLowerCase() !== "true") {
    throw new Error("SUI_BLOCKVISION_ENABLED is not true.");
  }

  if (!apiKey) {
    throw new Error("SUI_BLOCKVISION_API_KEY is not configured.");
  }

  const baseUrl =
    process.env.SUI_BLOCKVISION_BASE_URL?.trim().replace(/\/+$/, "") ||
    DEFAULT_BASE_URL;
  const { coinType, resolvedFrom } = resolveCoinType(input);

  const url = `${baseUrl}/coin/holders?coinType=${encodeURIComponent(coinType)}&limit=20`;
  const raw = await fetchJson(url, {
    headers: { "x-api-key": apiKey, accept: "application/json" },
    signal: input.signal,
    timeoutMs: 20000,
  });

  const body = raw as {
    code?: number;
    message?: string;
    result?: { data?: BlockVisionHolder[]; total?: number };
  };

  if (body.code !== 200 || !body.result) {
    throw new Error(
      `BlockVision coin/holders error: ${body.message || "unexpected response"}.`
    );
  }

  const holders = Array.isArray(body.result.data) ? body.result.data : [];
  const symbol = coinSymbol(coinType);
  const rows = holders
    .map((holder, index) => {
      const account = (holder.account || holder.address || "").trim();

      if (!account) {
        return undefined;
      }

      const name = (holder.name || "").trim();
      const balance = String(holder.balance ?? holder.quantity ?? "0");
      const percentageNum = Number(holder.percentage);
      const percentage = Number.isFinite(percentageNum) ? percentageNum : 0;
      const isInfrastructure = isBlockVisionInfrastructureLabel(name);
      const smartMoneyStatus = isInfrastructure
        ? "excluded_address"
        : "large_flow_watchlist";

      return {
        // `wallet` becomes the report-table label: prefer the entity label
        // (Binance/OKX/…) and fall back to the raw account address.
        wallet: name || account,
        account,
        amount: balance,
        dataSourceDiagnostic:
          "BlockVision holder snapshot. It provides holder labels, balance, and supply share, not DEX trade flow fields.",
        holderSnapshot: "true",
        name: name || undefined,
        label: name || undefined,
        rank: index + 1,
        balance,
        percentage,
        percentageOfSupply: `${(percentage * 100).toFixed(2)}%`,
        signal: name ? "Labeled holder" : "Top holder",
        smartMoneyStatus,
        sourceChain: "Sui",
        sourceTable: "BlockVision coin/holders",
        tokenCategory: "holder concentration",
        tokenSymbol: symbol,
        walletLabel: name || "unavailable",
        window: "current holder snapshot",
        website: holder.website || undefined,
      };
    })
    .filter((row): row is NonNullable<typeof row> => Boolean(row));

  const totalHolders = Number(body.result.total) || holders.length;
  const labeled = rows.filter((row) => row.name).length;
  const top = rows[0];

  const summary =
    rows.length === 0
      ? `BlockVision returned no holder rows for ${symbol} (${coinType}).`
      : `BlockVision top ${rows.length} holders for ${symbol} on Sui (${totalHolders.toLocaleString()} total holders${labeled ? `, ${labeled} labeled` : ""}). ` +
        (top
          ? `Largest: ${top.wallet} holds ${top.percentageOfSupply} of supply. `
          : "") +
        (resolvedFrom === "default"
          ? "No specific token in the query, so this shows a representative liquid Sui asset — add a coin type or $SYMBOL to target another token. "
          : "") +
        compactText(rows.slice(0, 5));

  return {
    data: {
      rows,
      coinType,
      symbol,
      totalHolders,
      resolvedFrom,
      source: "blockvision",
    },
    summary,
  sourceUrl: `https://suivision.xyz/coin/${coinType}`,
  };
}

export async function getSuiCexTransferActivities(input: {
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
  const apiKey = process.env.SUI_BLOCKVISION_API_KEY?.trim();

  if (process.env.SUI_BLOCKVISION_ENABLED?.trim().toLowerCase() !== "true") {
    throw new Error("SUI_BLOCKVISION_ENABLED is not true.");
  }

  if (!apiKey) {
    throw new Error("SUI_BLOCKVISION_API_KEY is not configured.");
  }

  const baseUrl =
    process.env.SUI_BLOCKVISION_BASE_URL?.trim().replace(/\/+$/, "") ||
    DEFAULT_BASE_URL;
  const addressLimit = Math.max(
    1,
    Math.min(
      readPositiveInteger(process.env.SUI_BLOCKVISION_CEX_ADDRESS_LIMIT, 10),
      25
    )
  );
  const limitPerAddress = Math.max(
    1,
    Math.min(input.limitPerAddress ?? 50, 50)
  );
  const cexAddresses = input.addresses
    .map(normalizeCexAddressLabel)
    .filter((address): address is NonNullable<typeof address> => Boolean(address))
    .slice(0, addressLimit);
  const minTimestamp = Date.now() - input.windowDays * 24 * 60 * 60 * 1000;
  const groups = new Map<string, CexActivityGroup>();

  for (const cexAddress of cexAddresses) {
    const url = `${baseUrl}/account/activities?address=${encodeURIComponent(
      cexAddress.wallet
    )}&limit=${limitPerAddress}`;
    const raw = await fetchJson(url, {
      headers: { "x-api-key": apiKey, accept: "application/json" },
      signal: input.signal,
      timeoutMs: 20000,
    });
    const body = raw as {
      code?: number;
      message?: string;
      result?: { data?: BlockVisionActivity[] };
    };

    if (body.code !== 200 || !body.result) {
      throw new Error(
        `BlockVision account/activities error: ${body.message || "unexpected response"}.`
      );
    }

    const activities = Array.isArray(body.result.data) ? body.result.data : [];

    for (const activity of activities) {
      addCexActivityGroups({
        activity,
        cexAddress,
        groups,
        minTimestamp,
        symbol: input.symbol,
      });
    }
  }

  const rows = [...groups.values()]
    .filter((group) => group.netUsd >= input.minUsd)
    .sort((a, b) => {
      if (a.signal !== b.signal) {
        return a.signal === "CEX withdrawal" ? -1 : 1;
      }

      return b.netUsd - a.netUsd;
    })
    .slice(0, 25)
    .map((group) => ({
      amount: roundNumber(group.amount, 6),
      dataSourceDiagnostic:
        "BlockVision account/activities joined with Dune cex.addresses | exchange address activity | retention unavailable",
      netUsd: roundNumber(group.netUsd, 2),
      retentionAfterBuy: "unavailable",
      sellPressureAfterBuy: "unavailable",
      signal: group.signal,
      smartMoneyStatus:
        group.signal === "CEX withdrawal"
          ? "candidate_smart_money"
          : "sell_pressure_watchlist",
      sourceCex: group.sourceCex,
      sourceChain: "Sui",
      sourceTable: "BlockVision account/activities + Dune cex.addresses",
      tokenCategory:
        group.signal === "CEX withdrawal"
          ? "cex exchange outflow"
          : "cex sell-pressure flow",
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
    sourceUrl: `${baseUrl}/account/activities`,
  };
}

function resolveCoinType(input: SuiCoinHoldersInput): {
  coinType: string;
  resolvedFrom: "param" | "query-cointype" | "query-symbol" | "default";
} {
  // 1) explicit Sui coin type passed as the token param
  if (input.tokenAddress && COIN_TYPE_PATTERN.test(input.tokenAddress)) {
    return { coinType: input.tokenAddress.trim(), resolvedFrom: "param" };
  }

  const text = `${input.rawQuery ?? ""} ${input.query ?? ""}`;

  // 2) a coin type written inline in the query
  const inlineCoinType = text.match(COIN_TYPE_PATTERN)?.[0];
  if (inlineCoinType) {
    return { coinType: inlineCoinType, resolvedFrom: "query-cointype" };
  }

  // 3) a known $SYMBOL / SYMBOL in the query
  const symbolMatch =
    text.match(/\$([a-zA-Z][a-zA-Z0-9_]{1,15})\b/)?.[1] ||
    text.match(/\b([A-Z]{2,15})\b/)?.[1];
  if (symbolMatch) {
    const mapped = KNOWN_COIN_TYPES[symbolMatch.toUpperCase()];
    if (mapped) {
      return { coinType: mapped, resolvedFrom: "query-symbol" };
    }
  }

  // 4) representative default (configurable) so a generic "accumulation on Sui"
  //    query still returns a real labeled holder table instead of an empty gap.
  const fallback =
    process.env.SUI_BLOCKVISION_DEFAULT_COINTYPE?.trim() ||
    KNOWN_COIN_TYPES.CETUS;
  return { coinType: fallback, resolvedFrom: "default" };
}

function coinSymbol(coinType: string) {
  const tail = coinType.split("::").pop();
  return (tail || coinType).toUpperCase();
}

function isBlockVisionInfrastructureLabel(label: string) {
  return /\b(?:binance|coinbase|okx|kucoin|mexc|gate|bybit|bitget|upbit|kraken|exchange|router|bridge|pool|market maker|custody|vault|treasury)\b/i.test(
    label
  );
}

function normalizeCexAddressLabel(label: SuiCexAddressLabel) {
  const wallet = readString(label.wallet);

  if (!wallet) {
    return undefined;
  }

  return {
    sourceCex: readString(label.sourceCex) || readString(label.walletLabel) || "CEX",
    wallet,
    walletLabel: readString(label.walletLabel),
  };
}

function addCexActivityGroups({
  activity,
  cexAddress,
  groups,
  minTimestamp,
  symbol,
}: {
  activity: BlockVisionActivity;
  cexAddress: NonNullable<ReturnType<typeof normalizeCexAddressLabel>>;
  groups: Map<string, CexActivityGroup>;
  minTimestamp: number;
  symbol: string;
}) {
  if (activity.status && activity.status !== "success") {
    return;
  }

  const type = String(activity.type ?? "");
  const signal = type === "Send"
    ? "CEX withdrawal"
    : type === "Receive"
      ? "CEX deposit"
      : undefined;

  if (!signal) {
    return;
  }

  const timestampMs = Number(activity.timestampMs);

  if (!Number.isFinite(timestampMs) || timestampMs < minTimestamp) {
    return;
  }

  const counterparty = resolveActivityCounterparty(activity, cexAddress.wallet);

  if (!counterparty) {
    return;
  }

  const coinChanges = Array.isArray(activity.coinChanges)
    ? activity.coinChanges
    : [];

  for (const coin of coinChanges) {
    const tokenSymbol = readString(coin.symbol).toUpperCase();

    if (!tokenSymbol || (symbol && tokenSymbol !== symbol.toUpperCase())) {
      continue;
    }

    const amount = Math.abs(toTokenAmount(coin.amount, coin.decimal));
    const netUsd = Math.abs(Number(coin.usdValue));

    if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(netUsd) || netUsd <= 0) {
      continue;
    }

    const key = [
      counterparty.toLowerCase(),
      cexAddress.sourceCex.toLowerCase(),
      tokenSymbol,
      signal,
    ].join("|");
    const group = groups.get(key) ?? {
      amount: 0,
      digests: new Set<string>(),
      firstSeen: timestampMs,
      lastSeen: timestampMs,
      netUsd: 0,
      signal,
      sourceCex: cexAddress.sourceCex,
      tokenSymbol,
      wallet: counterparty,
    };

    group.amount += amount;
    group.netUsd += netUsd;
    group.firstSeen = Math.min(group.firstSeen, timestampMs);
    group.lastSeen = Math.max(group.lastSeen, timestampMs);

    if (activity.digest) {
      group.digests.add(activity.digest);
    }

    groups.set(key, group);
  }
}

function resolveActivityCounterparty(
  activity: BlockVisionActivity,
  cexAddress: string
) {
  const lowerCex = cexAddress.toLowerCase();
  const interactAddresses = Array.isArray(activity.interactAddresses)
    ? activity.interactAddresses
    : [];
  const interact = interactAddresses.find((entry) => {
    const address = readString(entry.address).toLowerCase();

    return address && address !== lowerCex;
  });
  const interactAddress = readString(interact?.address);

  if (interactAddress) {
    return interactAddress;
  }

  const sender = readString(activity.sender);

  return sender.toLowerCase() !== lowerCex ? sender : "";
}

function toTokenAmount(
  rawAmount: string | number | undefined,
  rawDecimals: string | number | undefined
) {
  const amount = Number(rawAmount);
  const decimals = Number(rawDecimals);

  if (!Number.isFinite(amount)) {
    return 0;
  }

  if (!Number.isFinite(decimals) || decimals <= 0) {
    return amount;
  }

  return amount / 10 ** decimals;
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
