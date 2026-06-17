import assert from "node:assert/strict";
import test from "node:test";

import {
  SealAccessDeniedError,
  decryptAgentHandoff,
  decryptPrivateMemory,
  encryptAgentHandoff,
  encryptPrivateMemory,
  getSealIntegrationStatus,
} from "./seal";
import type { PrivateMemoryArtifact } from "./memory-types";

const OWNER = `0x${"11".repeat(32)}`;
const OTHER = `0x${"22".repeat(32)}`;

// Force the offline local-envelope path so these tests never touch the network
// or a key server, regardless of any ambient SEAL_* env.
function forceLocalEnvelopeMode() {
  process.env.SEAL_MOCK_MODE = "true";
  delete process.env.SEAL_PACKAGE_ID;
  delete process.env.SEAL_KEY_SERVER_OBJECT_IDS;
  delete process.env.SEAL_KEY_SERVER_WEIGHTS;
  delete process.env.SEAL_KEY_SERVER_API_KEY_NAME;
  delete process.env.SEAL_KEY_SERVER_API_KEY;
  delete process.env.SEAL_KEY_SERVER_AGGREGATOR_URL;
  delete process.env.SEAL_KEY_SERVER_CONFIGS_JSON;
}

function makeArtifact(): PrivateMemoryArtifact {
  return {
    schema: "langclaw.sui-walrus.private-memory.v1",
    runId: "run_test",
    ownerAddress: OWNER,
    topic: "sui walrus alpha",
    prompt: "sui walrus alpha",
    generatedAt: "2026-06-17T00:00:00.000Z",
    reusedMemoryIds: [],
    memorySummary: "a private memory summary",
    report: {
      title: "Title",
      answer: "Answer",
      bullets: ["one", "two"],
      recommendation: "hold",
    },
    evidence: { sources: [], providerTrace: [] },
  };
}

test("status reports local-envelope mode (owner-gated AES) when mock mode is on", () => {
  forceLocalEnvelopeMode();
  const status = getSealIntegrationStatus();
  assert.equal(status.mode, "local-envelope");
  assert.equal(status.ready, true);
  assert.equal(status.mockMode, true);
});

test("status enables real Seal mode for a configured Sui mainnet provider", () => {
  forceLocalEnvelopeMode();
  process.env.SEAL_MOCK_MODE = "false";
  process.env.SUI_NETWORK = "mainnet";
  process.env.SEAL_PACKAGE_ID = `0x${"33".repeat(32)}`;
  process.env.SEAL_KEY_SERVER_OBJECT_IDS = `0x${"44".repeat(32)}`;
  process.env.SEAL_KEY_SERVER_API_KEY_NAME = "x-api-key";
  process.env.SEAL_KEY_SERVER_API_KEY = "provider-secret";

  const status = getSealIntegrationStatus();
  assert.equal(status.mode, "seal-sdk-configured");
  assert.equal(status.ready, true);
  assert.equal(status.mockMode, false);
  assert.equal(status.network, "mainnet");
  assert.equal(status.keyServerCount, 1);
  assert.equal(status.keyServerConfigSource, "object-ids");
  assert.equal(status.keyServerAuthConfigured, true);
});

test("status reports JSON key-server config errors without enabling real Seal", () => {
  forceLocalEnvelopeMode();
  process.env.SEAL_MOCK_MODE = "false";
  process.env.SEAL_PACKAGE_ID = `0x${"33".repeat(32)}`;
  process.env.SEAL_KEY_SERVER_CONFIGS_JSON = JSON.stringify([{ weight: 1 }]);

  const status = getSealIntegrationStatus();
  assert.equal(status.mode, "local-envelope");
  assert.equal(status.ready, false);
  assert.equal(status.keyServerConfigSource, "json");
  assert.deepEqual(status.errors, ["SEAL_KEY_SERVER_CONFIGS_JSON[0] is missing objectId"]);
});

test("encrypt -> decrypt round trip returns the same artifact for the owner", async () => {
  forceLocalEnvelopeMode();
  const artifact = makeArtifact();

  const envelope = await encryptPrivateMemory(artifact, OWNER);
  assert.equal(envelope.sealMode, "local-envelope");
  assert.ok(envelope.ciphertext, "envelope should carry ciphertext");

  const decrypted = await decryptPrivateMemory(envelope, OWNER);
  assert.deepEqual(decrypted, artifact);
});

test("decrypt denies a requester that is not the owner", async () => {
  forceLocalEnvelopeMode();
  const envelope = await encryptPrivateMemory(makeArtifact(), OWNER);

  await assert.rejects(
    () => decryptPrivateMemory(envelope, OTHER),
    SealAccessDeniedError
  );
});

test("agent handoff envelope round trips independent of owner gating", () => {
  forceLocalEnvelopeMode();
  const value = { schema: "langclaw.agent-handoff-bundle.v1", handoffs: [{ role: "planner" }] };

  const envelope = encryptAgentHandoff(value);
  const decoded = decryptAgentHandoff<typeof value>(envelope);

  assert.deepEqual(decoded, value);
});
