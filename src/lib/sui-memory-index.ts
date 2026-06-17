// Recall-from-chain: rebuild an owner's private-memory pointer index purely from
// Sui `MemoryRecorded` events, so memory is NOT trapped in a local on-disk index.
//
// The `memory_registry::record_memory` call (see move/langclaw_memory) emits a
// metadata-only `MemoryRecorded` event for every encrypted Walrus artifact. By
// querying those events for an owner we can reconstruct the pointer set on any
// device — the chain becomes the portable source of truth for *which* encrypted
// blobs belong to an owner. (Decrypting the content still needs the owner's Seal
// key; this module only restores the verifiable pointers, never plaintext.)

import type { MemoryIndexRecord, SuiNetwork } from "./memory-types";
import {
  cleanSuiEnv,
  createSuiClient,
  normalizeSuiPackageId,
  readSuiBoolean,
  readSuiNetwork,
} from "./sui-onchain";

const MEMORY_RECORDED_EVENT = "MemoryRecorded";
const DEFAULT_REGISTRY_MODULE = "memory_registry";
const DEFAULT_RPC_URL = "https://fullnode.mainnet.sui.io:443";
const DEFAULT_QUERY_LIMIT = 50;
const MAX_QUERY_LIMIT = 200;

/** A memory pointer reconstructed from an on-chain `MemoryRecorded` event. */
export type ChainMemoryPointer = {
  runId: string;
  contentHash: string;
  walrusBlobId: string;
  walrusObjectId: string;
  sealPolicyId: string;
  ownerAddress: string;
  recorder: string;
  suiTxDigest?: string;
  createdAt: string;
};

export type ChainMemoryIndexStatus = {
  enabled: boolean;
  configured: boolean;
  eventType?: string;
  reason?: string;
};

/** Minimal structural shape of the Sui event objects we read (avoids depending
 * on the lazily-loaded @mysten/sui types at module scope). */
type ChainEventLike = {
  parsedJson?: unknown;
  id?: { txDigest?: string };
  timestampMs?: string | number | null;
  sender?: string;
};

/**
 * The `MemoryRecorded` struct is qualified by its *defining* package id, which
 * differs from the runtime package id after a package upgrade. We therefore read
 * an explicit `SUI_REGISTRY_EVENT_PACKAGE_ID` first (the original publish id) and
 * fall back to the runtime `SUI_REGISTRY_PACKAGE_ID` for never-upgraded packages.
 */
function resolveEventType(): string | undefined {
  const packageRaw =
    cleanSuiEnv(process.env.SUI_REGISTRY_EVENT_PACKAGE_ID) ||
    cleanSuiEnv(process.env.SUI_REGISTRY_PACKAGE_ID);

  if (!packageRaw) {
    return undefined;
  }

  const packageId = normalizeSuiPackageId(packageRaw);
  const moduleName =
    cleanSuiEnv(process.env.SUI_REGISTRY_MODULE) || DEFAULT_REGISTRY_MODULE;

  return `${packageId}::${moduleName}::${MEMORY_RECORDED_EVENT}`;
}

export function getChainMemoryIndexStatus(): ChainMemoryIndexStatus {
  const enabled = readSuiBoolean(process.env.SUI_MEMORY_RECALL_FROM_CHAIN, true);
  const eventType = resolveEventType();

  return {
    enabled,
    configured: Boolean(eventType),
    eventType,
    reason: eventType
      ? undefined
      : "SUI_REGISTRY_PACKAGE_ID (or SUI_REGISTRY_EVENT_PACKAGE_ID) is not configured.",
  };
}

function readEventString(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "bigint") {
    return value.toString();
  }

  return undefined;
}

function normalizeOwner(address: string): string {
  return address.trim().toLowerCase();
}

/** Pure mapper from a raw Sui event to a memory pointer. Exported for tests. */
export function mapMemoryEvent(event: ChainEventLike): ChainMemoryPointer | null {
  const fields = event.parsedJson;

  if (!fields || typeof fields !== "object") {
    return null;
  }

  const f = fields as Record<string, unknown>;
  const walrusBlobId = readEventString(f.walrus_blob_id);
  const owner = readEventString(f.owner);

  // A pointer is only useful if it locates a blob and names its owner.
  if (!walrusBlobId || !owner) {
    return null;
  }

  const timestampMs = Number(event.timestampMs);

  return {
    runId: readEventString(f.run_id) ?? "",
    contentHash: readEventString(f.content_hash) ?? "",
    walrusBlobId,
    walrusObjectId: readEventString(f.walrus_object_id) ?? "",
    sealPolicyId: readEventString(f.seal_policy_id) ?? "",
    ownerAddress: owner,
    recorder: readEventString(f.recorder) ?? event.sender ?? "",
    suiTxDigest: event.id?.txDigest,
    createdAt: Number.isFinite(timestampMs)
      ? new Date(timestampMs).toISOString()
      : new Date(0).toISOString(),
  };
}

/**
 * Query Sui for an owner's `MemoryRecorded` events and return de-duplicated
 * memory pointers (newest first). Never throws — returns `[]` when the registry
 * is unconfigured, recall-from-chain is disabled, or the RPC call fails, so it
 * is safe to merge into the existing recall path as an additive source.
 */
export async function fetchOwnerMemoryPointersFromChain(
  ownerAddress: string,
  opts: { limit?: number; rpcUrl?: string; network?: SuiNetwork } = {}
): Promise<ChainMemoryPointer[]> {
  const status = getChainMemoryIndexStatus();

  if (!status.enabled || !status.eventType) {
    return [];
  }

  const rpcUrl =
    opts.rpcUrl || cleanSuiEnv(process.env.SUI_RPC_URL) || DEFAULT_RPC_URL;
  const network = opts.network || readSuiNetwork(process.env.SUI_NETWORK);
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_QUERY_LIMIT, 1), MAX_QUERY_LIMIT);
  const wantOwner = normalizeOwner(ownerAddress);

  try {
    const client = await createSuiClient(rpcUrl, network);
    const result = await client.queryEvents({
      query: { MoveEventType: status.eventType },
      limit,
      order: "descending",
    });

    const pointers: ChainMemoryPointer[] = [];
    const seenBlobIds = new Set<string>();

    for (const event of result.data ?? []) {
      const pointer = mapMemoryEvent(event as ChainEventLike);

      if (!pointer || normalizeOwner(pointer.ownerAddress) !== wantOwner) {
        continue;
      }

      if (seenBlobIds.has(pointer.walrusBlobId)) {
        continue;
      }

      seenBlobIds.add(pointer.walrusBlobId);
      pointers.push(pointer);
    }

    return pointers;
  } catch {
    // Chain recall is a best-effort additive source; a failed RPC must never
    // break recall — the local/Supabase index still applies.
    return [];
  }
}

/** Adapt a chain pointer to the existing `MemoryIndexRecord` shape. `topic`/`tags`
 * are empty because they are never stored on-chain (privacy invariant) — they are
 * recovered after the encrypted artifact is fetched and decrypted. */
export function chainPointerToIndexRecord(
  pointer: ChainMemoryPointer
): MemoryIndexRecord {
  return {
    id: `chain_${pointer.runId || pointer.walrusBlobId}`,
    ownerAddress: pointer.ownerAddress,
    runId: pointer.runId,
    topic: "",
    contentHash: pointer.contentHash,
    walrusBlobId: pointer.walrusBlobId,
    walrusObjectId: pointer.walrusObjectId,
    sealPolicyId: pointer.sealPolicyId,
    suiTxDigest: pointer.suiTxDigest,
    tags: [],
    createdAt: pointer.createdAt,
  };
}
