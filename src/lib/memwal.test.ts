import assert from "node:assert/strict";
import test from "node:test";

import { createMemWalAdapter, getMemWalIntegrationStatus } from "./memwal";
import type { MemoryIndexRecord, PrivateMemoryArtifact } from "./memory-types";

const OWNER = `0x${"44".repeat(32)}`;

function clearMemWalEnv() {
  delete process.env.MEMWAL_ENABLED;
  delete process.env.MEMWAL_PRIVATE_KEY;
  delete process.env.MEMWAL_ACCOUNT_ID;
  delete process.env.MEMWAL_NAMESPACE;
}

const RECORD: MemoryIndexRecord = {
  id: "mem_test",
  ownerAddress: OWNER,
  runId: "run_test",
  topic: "sui walrus alpha",
  contentHash: "0xhash",
  walrusBlobId: "blob_test",
  walrusObjectId: "0xobj",
  sealPolicyId: "langclaw-private-memory-mainnet",
  tags: ["alpha"],
  createdAt: "2026-06-17T00:00:00.000Z",
};
const ARTIFACT = { memorySummary: "redacted", report: { recommendation: "n/a" } } as unknown as PrivateMemoryArtifact;

test("disabled by default: status is disabled and calls are skipped (no network)", async () => {
  clearMemWalEnv();
  const status = getMemWalIntegrationStatus();
  assert.equal(status.enabled, false);
  assert.equal(status.status, "disabled");

  const adapter = createMemWalAdapter(OWNER);
  assert.equal((await adapter.recall("topic")).status, "skipped");
  assert.equal((await adapter.remember(RECORD, ARTIFACT)).status, "skipped");
});

test("enabled but missing credentials: status is missing_config and calls fail honestly", async () => {
  clearMemWalEnv();
  process.env.MEMWAL_ENABLED = "true";

  const status = getMemWalIntegrationStatus();
  assert.equal(status.status, "missing_config");
  assert.deepEqual(
    [...status.missing].sort(),
    ["MEMWAL_ACCOUNT_ID", "MEMWAL_PRIVATE_KEY"]
  );

  const adapter = createMemWalAdapter(OWNER);
  const recall = await adapter.recall("topic");
  assert.equal(recall.status, "failed");
  assert.match(recall.reason ?? "", /MEMWAL_/);

  clearMemWalEnv();
});

test("namespace is scoped per owner so wallets never share recall pointers", () => {
  clearMemWalEnv();
  process.env.MEMWAL_NAMESPACE = "langclaw-private-memory";

  const status = createMemWalAdapter(OWNER).getStatus();
  assert.equal(status.namespace, `langclaw-private-memory:${OWNER.toLowerCase()}`);

  clearMemWalEnv();
});
