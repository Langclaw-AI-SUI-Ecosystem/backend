import assert from "node:assert/strict";
import test from "node:test";

import {
  chainPointerToIndexRecord,
  mapMemoryEvent,
} from "./sui-memory-index";

const OWNER = `0x${"ab".repeat(32)}`;

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    parsedJson: {
      run_id: "run_abc",
      content_hash: "0xhash",
      walrus_blob_id: "blob_xyz",
      walrus_object_id: "0xobj",
      seal_policy_id: "langclaw-private-memory-mainnet",
      owner: OWNER,
      recorder: `0x${"cd".repeat(32)}`,
      ...overrides,
    },
    id: { txDigest: "DIGEST123" },
    timestampMs: "1750000000000",
    sender: `0x${"ef".repeat(32)}`,
  };
}

test("maps a MemoryRecorded event to a chain pointer", () => {
  const pointer = mapMemoryEvent(makeEvent());

  assert.ok(pointer);
  assert.equal(pointer?.runId, "run_abc");
  assert.equal(pointer?.contentHash, "0xhash");
  assert.equal(pointer?.walrusBlobId, "blob_xyz");
  assert.equal(pointer?.walrusObjectId, "0xobj");
  assert.equal(pointer?.ownerAddress, OWNER);
  assert.equal(pointer?.suiTxDigest, "DIGEST123");
  // timestampMs is converted to an ISO calendar timestamp.
  assert.equal(pointer?.createdAt, new Date(1750000000000).toISOString());
});

test("returns null when the blob id is missing (useless pointer)", () => {
  assert.equal(mapMemoryEvent(makeEvent({ walrus_blob_id: undefined })), null);
});

test("returns null when the owner is missing", () => {
  assert.equal(mapMemoryEvent(makeEvent({ owner: undefined })), null);
});

test("returns null when parsedJson is not an object", () => {
  assert.equal(mapMemoryEvent({ parsedJson: "nope" }), null);
  assert.equal(mapMemoryEvent({}), null);
});

test("falls back to the event sender when recorder is absent", () => {
  const sender = `0x${"ef".repeat(32)}`;
  const pointer = mapMemoryEvent(makeEvent({ recorder: undefined }));
  assert.equal(pointer?.recorder, sender);
});

test("adapts a chain pointer to a MemoryIndexRecord with empty topic/tags", () => {
  const pointer = mapMemoryEvent(makeEvent());
  assert.ok(pointer);
  const record = chainPointerToIndexRecord(pointer!);

  assert.equal(record.id, "chain_run_abc");
  assert.equal(record.ownerAddress, OWNER);
  assert.equal(record.walrusBlobId, "blob_xyz");
  assert.equal(record.suiTxDigest, "DIGEST123");
  // topic/tags are never stored on-chain (privacy invariant).
  assert.equal(record.topic, "");
  assert.deepEqual(record.tags, []);
});
