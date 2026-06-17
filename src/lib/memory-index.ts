import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { MemoryIndexRecord } from "./memory-types";

export type MemoryIndex = {
  listForOwner(ownerAddress: string): Promise<MemoryIndexRecord[]>;
  latest(ownerAddress?: string): Promise<MemoryIndexRecord | undefined>;
  save(record: MemoryIndexRecord): Promise<void>;
};

export type MemoryIndexStatus = {
  mode: "supabase" | "local";
  configured: boolean;
};

export function createMemoryIndex(): MemoryIndex {
  if (process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    return new SupabaseMemoryIndex();
  }

  return new LocalMemoryIndex();
}

export function getMemoryIndexStatus(): MemoryIndexStatus {
  if (process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    return { mode: "supabase", configured: true };
  }

  return { mode: "local", configured: true };
}

export function pickRelevantMemories(
  records: MemoryIndexRecord[],
  topic: string,
  limit = 3
) {
  const topicTokens = tokenize(topic);

  return records
    .map((record) => ({
      record,
      score: scoreRecord(record, topicTokens),
    }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return right.record.createdAt.localeCompare(left.record.createdAt);
    })
    .slice(0, limit)
    .map(({ record }) => record);
}

class LocalMemoryIndex implements MemoryIndex {
  async listForOwner(ownerAddress: string): Promise<MemoryIndexRecord[]> {
    const records = await readLocalRecords();
    return records.filter((record) => record.ownerAddress === ownerAddress);
  }

  async latest(ownerAddress?: string): Promise<MemoryIndexRecord | undefined> {
    const records = await readLocalRecords();
    const filtered = ownerAddress
      ? records.filter((record) => record.ownerAddress === ownerAddress)
      : records;

    return filtered.sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  }

  async save(record: MemoryIndexRecord): Promise<void> {
    const records = await readLocalRecords();
    const nextRecords = [
      ...records.filter((item) => item.id !== record.id),
      record,
    ].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const file = getLocalIndexPath();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(nextRecords, null, 2));
  }
}

class SupabaseMemoryIndex implements MemoryIndex {
  async listForOwner(ownerAddress: string): Promise<MemoryIndexRecord[]> {
    const client = await getSupabaseClient();
    const { data, error } = await client
      .from("langclaw_private_memory_index")
      .select("*")
      .eq("owner_address", ownerAddress)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) {
      throw new Error(error.message);
    }

    return (data ?? []).map(rowToRecord);
  }

  async latest(ownerAddress?: string): Promise<MemoryIndexRecord | undefined> {
    const client = await getSupabaseClient();
    let query = client
      .from("langclaw_private_memory_index")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(1);

    if (ownerAddress) {
      query = query.eq("owner_address", ownerAddress);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(error.message);
    }

    return data?.[0] ? rowToRecord(data[0]) : undefined;
  }

  async save(record: MemoryIndexRecord): Promise<void> {
    const client = await getSupabaseClient();
    const { error } = await client.from("langclaw_private_memory_index").upsert({
      id: record.id,
      owner_address: record.ownerAddress,
      run_id: record.runId,
      topic: record.topic,
      content_hash: record.contentHash,
      walrus_blob_id: record.walrusBlobId,
      walrus_object_id: record.walrusObjectId,
      seal_policy_id: record.sealPolicyId,
      sui_tx_digest: record.suiTxDigest ?? null,
      tags: record.tags,
      created_at: record.createdAt,
    });

    if (error) {
      throw new Error(error.message);
    }
  }
}

async function getSupabaseClient() {
  const { createClient } = await import("@supabase/supabase-js");
  const url = process.env.SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!url || !serviceRoleKey) {
    throw new Error("Supabase metadata index is not configured.");
  }

  return createClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
    },
  });
}

async function readLocalRecords(): Promise<MemoryIndexRecord[]> {
  try {
    return JSON.parse(await readFile(getLocalIndexPath(), "utf8")) as MemoryIndexRecord[];
  } catch {
    return [];
  }
}

function getLocalIndexPath() {
  return path.resolve(
    process.cwd(),
    process.env.LANGCLAW_LOCAL_STATE_DIR?.trim() || ".langclaw-state",
    "memory-index.json"
  );
}

function rowToRecord(row: Record<string, unknown>): MemoryIndexRecord {
  return {
    id: String(row.id),
    ownerAddress: String(row.owner_address),
    runId: String(row.run_id),
    topic: String(row.topic),
    contentHash: String(row.content_hash),
    walrusBlobId: String(row.walrus_blob_id),
    walrusObjectId: String(row.walrus_object_id),
    sealPolicyId: String(row.seal_policy_id),
    suiTxDigest: typeof row.sui_tx_digest === "string" ? row.sui_tx_digest : undefined,
    tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
    createdAt: String(row.created_at),
  };
}

function tokenize(value: string) {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .filter((token) => token.length > 2)
  );
}

function scoreRecord(record: MemoryIndexRecord, topicTokens: Set<string>) {
  const recordTokens = tokenize(`${record.topic} ${record.tags.join(" ")}`);
  let score = 0;

  for (const token of topicTokens) {
    if (recordTokens.has(token)) {
      score += 1;
    }
  }

  return score;
}
