import type { SuiNetwork } from "./memory-types";

/**
 * Shared Sui on-chain helper used by the billing / proof / journal subsystems.
 *
 * It centralizes the "submit a Move call" write recipe and the on-chain READ
 * recipes (read a tx's events, query events, read a balance) on top of the same
 * `SuiJsonRpcClient` from `@mysten/sui/jsonRpc` that `sui-registry.ts` already
 * uses for writes. Every `@mysten/sui` import is lazy so the backend runs offline
 * and degrades to "not configured" instead of crashing.
 */

export const DEFAULT_SUI_RPC_URL = "https://fullnode.mainnet.sui.io:443";
export const DEFAULT_SUI_EXPLORER_URL = "https://suivision.xyz";

export type SuiEvent = {
  type: string;
  parsedJson?: unknown;
  sender?: string;
  id?: { txDigest?: string; eventSeq?: string };
  timestampMs?: string;
};

export type SuiTransactionBlock = {
  digest?: string;
  checkpoint?: string;
  timestampMs?: string;
  effects?: {
    status?: { status?: string; error?: string };
  };
  events?: SuiEvent[];
};

export type SuiQueryEventsResult = {
  data?: SuiEvent[];
  hasNextPage?: boolean;
  nextCursor?: unknown;
};

export type SuiBalance = {
  totalBalance?: string;
};

export type SuiObjectResponse = {
  data?: {
    objectId?: string;
    owner?: unknown;
    type?: string;
  };
  error?: {
    code?: string;
    object_id?: string;
  };
};

export type SuiTransaction = {
  pure: {
    string(value: string): unknown;
    address(value: string): unknown;
    u64(value: number | bigint | string): unknown;
    bool(value: boolean): unknown;
    vector(type: string, value: unknown): unknown;
  };
  object(value: string): unknown;
  setGasBudget(value: number | bigint | string): void;
  moveCall(input: { target: string; arguments: unknown[] }): unknown;
};

export type SuiReadClient = {
  signAndExecuteTransaction(input: {
    transaction: unknown;
    signer: unknown;
    options?: Record<string, boolean>;
  }): Promise<{ digest?: string; events?: SuiEvent[] }>;
  getTransactionBlock(input: {
    digest: string;
    options?: Record<string, boolean>;
  }): Promise<SuiTransactionBlock>;
  queryEvents(input: {
    query: Record<string, unknown>;
    limit?: number;
    order?: "ascending" | "descending";
  }): Promise<SuiQueryEventsResult>;
  getBalance(input: { owner: string; coinType?: string }): Promise<SuiBalance>;
  getChainIdentifier(): Promise<string>;
  getObject(input: {
    id: string;
    options?: Record<string, boolean>;
  }): Promise<SuiObjectResponse>;
};

type SuiRuntime = {
  jsonRpc: {
    SuiJsonRpcClient: new (input: { url: string; network: string }) => SuiReadClient;
  };
  transactions: {
    Transaction: new () => SuiTransaction;
  };
  keypairs: {
    Ed25519Keypair: {
      fromSecretKey(secretKey: Uint8Array | string): unknown;
    };
  };
};

let runtimePromise: Promise<SuiRuntime> | null = null;

export async function loadSuiRuntime(): Promise<SuiRuntime> {
  if (!runtimePromise) {
    runtimePromise = Promise.all([
      import("@mysten/sui/jsonRpc"),
      import("@mysten/sui/transactions"),
      import("@mysten/sui/keypairs/ed25519"),
    ]).then(
      ([jsonRpc, transactions, keypairs]) =>
        ({ jsonRpc, transactions, keypairs }) as unknown as SuiRuntime
    );
  }

  return runtimePromise;
}

export async function createSuiClient(
  rpcUrl: string,
  network: SuiNetwork
): Promise<SuiReadClient> {
  const runtime = await loadSuiRuntime();
  return new runtime.jsonRpc.SuiJsonRpcClient({ url: rpcUrl, network });
}

export function parseSuiPrivateKey(privateKey: string): Uint8Array | string {
  const cleaned = privateKey.trim();

  if (cleaned.startsWith("suiprivkey")) {
    return cleaned;
  }

  return Uint8Array.from(Buffer.from(cleaned.replace(/^0x/, ""), "hex"));
}

export function readSuiNetwork(value: string | undefined): SuiNetwork {
  const cleaned = value?.trim();

  if (
    cleaned === "mainnet" ||
    cleaned === "testnet" ||
    cleaned === "devnet" ||
    cleaned === "localnet"
  ) {
    return cleaned;
  }

  return "mainnet";
}

export function cleanSuiEnv(value: string | undefined) {
  const cleaned = value?.trim();
  return cleaned || undefined;
}

export function readSuiBoolean(value: string | undefined, fallback: boolean) {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function readSuiNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export type SubmitMoveCallInput = {
  rpcUrl: string;
  network: SuiNetwork;
  privateKey: string;
  gasBudget: number;
  target: string;
  buildArgs: (tx: SuiTransaction) => unknown[];
};

export type SubmitMoveCallResult = {
  status: "ok" | "failed";
  digest?: string;
  events?: SuiEvent[];
  reason?: string;
};

/**
 * The canonical Sui write path: build a SuiJsonRpcClient + Ed25519 signer +
 * Transaction, add a single moveCall, sign and execute. Never throws — returns
 * a `{ status: 'failed', reason }` so callers preserve the honest fallback shape.
 */
export async function submitMoveCall(
  input: SubmitMoveCallInput
): Promise<SubmitMoveCallResult> {
  try {
    const runtime = await loadSuiRuntime();
    const client = new runtime.jsonRpc.SuiJsonRpcClient({
      url: input.rpcUrl,
      network: input.network,
    });
    const signer = runtime.keypairs.Ed25519Keypair.fromSecretKey(
      parseSuiPrivateKey(input.privateKey)
    );
    const tx = new runtime.transactions.Transaction();
    tx.setGasBudget(input.gasBudget);
    tx.moveCall({ target: input.target, arguments: input.buildArgs(tx) });

    const result = await client.signAndExecuteTransaction({
      transaction: tx,
      signer,
      options: { showEffects: true, showEvents: true },
    });

    if (!result.digest) {
      return { status: "failed", reason: "Sui transaction returned no digest." };
    }

    return { status: "ok", digest: result.digest, events: result.events };
  } catch (error) {
    return {
      status: "failed",
      reason:
        error instanceof Error ? error.message : "Sui transaction failed.",
    };
  }
}

/** True when a fetched transaction block executed successfully. */
export function isSuiTxSuccess(block: SuiTransactionBlock): boolean {
  return block.effects?.status?.status === "success";
}

/** Find the first event of a given fully-qualified Move type in a tx block. */
export function findSuiEvent(
  block: SuiTransactionBlock,
  eventType: string
): SuiEvent | undefined {
  return (block.events ?? []).find((event) => event.type === eventType);
}

/**
 * Normalize a Sui package/object id to its canonical 0x + 64-hex (lowercase,
 * zero-padded) form. Sui RPC always returns addresses canonicalized this way in
 * `event.type` and accepts them in `MoveEventType` filters, so building Move type
 * strings from a normalized package id makes event matching reliable even when an
 * operator pastes a short / non-padded id. Returns the input unchanged if it is
 * not a plausible hex address (so it never silently corrupts a valid value).
 */
export function normalizeSuiPackageId(value: string): string {
  const cleaned = value.trim().toLowerCase();
  const hex = cleaned.startsWith("0x") ? cleaned.slice(2) : cleaned;

  if (hex.length === 0 || hex.length > 64 || !/^[0-9a-f]+$/.test(hex)) {
    return value.trim();
  }

  return `0x${hex.padStart(64, "0")}`;
}
