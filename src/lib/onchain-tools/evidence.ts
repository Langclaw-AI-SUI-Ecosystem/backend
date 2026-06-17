import type {
  OnChainCommand,
  OnChainProvider,
  OnChainToolResult,
} from "./types";

const smartMoneyRowPaths = [
  "data",
  "rows",
  "result",
  "result.rows",
  "results",
  "items",
  "tokenBalances",
  "transfers",
  "assetTransfers",
  "balances",
];

export function hasUsableSmartMoneyEvidence(value: unknown) {
  return readSmartMoneyRows(value).length > 0;
}

export function shouldRejectEmptySmartMoneyEvidence({
  command,
  data,
  provider,
}: {
  command: OnChainCommand;
  data: unknown;
  provider: OnChainProvider;
}) {
  return (
    command.domain === "smart_money" &&
    provider !== "local" &&
    !hasUsableSmartMoneyEvidence(data)
  );
}

export function isDirectProviderResult(tool: OnChainToolResult) {
  return tool.provider !== "local";
}

export function isEmptyDirectSmartMoneyResult(tool: OnChainToolResult) {
  return (
    isDirectProviderResult(tool) &&
    tool.domain === "smart_money" &&
    tool.status === "success" &&
    !hasUsableSmartMoneyEvidence(tool.data)
  );
}

export function isUsableDirectProviderResult(tool: OnChainToolResult) {
  if (!isDirectProviderResult(tool) || tool.status !== "success") {
    return false;
  }

  if (tool.domain !== "smart_money") {
    return true;
  }

  return hasUsableSmartMoneyEvidence(tool.data);
}

export function isDirectProviderIssue(tool: OnChainToolResult) {
  return (
    isDirectProviderResult(tool) &&
    (tool.status === "failed" || isEmptyDirectSmartMoneyResult(tool))
  );
}

export function describeEmptySmartMoneyEvidence(provider: OnChainProvider) {
  return `${providerLabel(provider)} did not return row-level smart-money rows.`;
}

function readSmartMoneyRows(value: unknown) {
  const rows: unknown[] = [];

  for (const path of smartMoneyRowPaths) {
    rows.push(...readArrayPath(value, path));
  }

  return rows.filter(isSubstantiveRow);
}

function readArrayPath(value: unknown, path: string) {
  const parts = path.split(".");
  let current = value;

  for (const part of parts) {
    if (!current || typeof current !== "object") {
      return [];
    }

    current = (current as Record<string, unknown>)[part];
  }

  if (Array.isArray(current)) {
    return current;
  }

  return [];
}

function isSubstantiveRow(value: unknown) {
  if (value === null || value === undefined) {
    return false;
  }

  if (typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  const walletValue = readStringField(record, [
    "account",
    "address",
    "from",
    "label",
    "owner",
    "to",
    "wallet",
    "walletAddress",
  ]);
  const tokenValue = readStringField(record, [
    "symbol",
    "token",
    "tokenAddress",
    "tokenSymbol",
  ]);

  if (!walletValue && !tokenValue) {
    return false;
  }

  return [
    "amount_usd",
    "amount",
    "balance",
    "netAmount",
    "net_flow_7d_usd",
    "net_flow_30d_usd",
    "netFlowUsd",
    "netMnt",
    "netToken",
    "netTokenRaw",
    "netUsd",
    "normalizedTokenAmount",
    "signal",
    "tokenFlow",
    "trades",
    "transfers",
    "txHash",
    "usd",
    "value",
    "window",
  ].some((key) => hasUsableField(record[key]));
}

function readStringField(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];

    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

function hasUsableField(value: unknown) {
  if (value === null || value === undefined) {
    return false;
  }

  if (Array.isArray(value)) {
    return value.length > 0;
  }

  if (typeof value === "object") {
    return Object.keys(value).length > 0;
  }

  return String(value).trim().length > 0;
}

function providerLabel(provider: OnChainProvider) {
  switch (provider) {
    case "dune":
      return "Dune";
    case "nansen":
      return "Nansen";
    case "surf":
      return "Surf";
    default:
      return provider;
  }
}
