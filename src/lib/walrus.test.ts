import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createWalrusClient,
  getWalrusBlobUrl,
  getWalrusStorageStatus,
} from "./walrus";
import type { SealEnvelope } from "./memory-types";

// Force the local-disk fallback client so the round trip is fully offline.
function forceLocalMode(storeDir: string) {
  delete process.env.WALRUS_PUBLISHER_URL;
  delete process.env.WALRUS_AGGREGATOR_URL;
  process.env.WALRUS_LOCAL_STORE_DIR = storeDir;
}

function makeEnvelope(): SealEnvelope {
  return {
    schema: "langclaw.seal-envelope.v1",
    ownerAddress: `0x${"33".repeat(32)}`,
    sealPolicyId: "langclaw-private-memory-mainnet",
    sealMode: "local-envelope",
    algorithm: "aes-256-gcm",
    iv: "aXY=",
    authTag: "dGFn",
    ciphertext: "Y2lwaGVy",
    createdAt: "2026-06-17T00:00:00.000Z",
  };
}

test("local client stores then reads back a byte-identical envelope", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "walrus-test-"));
  try {
    forceLocalMode(dir);
    const client = createWalrusClient();
    const envelope = makeEnvelope();

    const stored = await client.storeEnvelope(envelope);
    assert.ok(stored.walrusBlobId, "expected a blob id");
    assert.match(stored.walrusObjectId, /^0x[0-9a-f]+$/);
    assert.match(stored.suiTxDigest ?? "", /^local-/);

    const readBack = await client.readEnvelope(stored.walrusBlobId);
    assert.deepEqual(readBack, envelope);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("storage status reports local mode without publisher/aggregator config", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "walrus-test-"));
  try {
    forceLocalMode(dir);
    const status = getWalrusStorageStatus();
    assert.equal(status.mode, "local");
    assert.equal(status.configured, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("blob URL is undefined in local mode and an https aggregator URL in http mode", () => {
  delete process.env.WALRUS_AGGREGATOR_URL;
  assert.equal(getWalrusBlobUrl("blob123"), undefined);

  process.env.WALRUS_AGGREGATOR_URL = "https://aggregator.walrus-mainnet.walrus.space";
  assert.equal(
    getWalrusBlobUrl("blob123"),
    "https://aggregator.walrus-mainnet.walrus.space/v1/blobs/blob123"
  );
  delete process.env.WALRUS_AGGREGATOR_URL;
});
