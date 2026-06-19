import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import test from "node:test";

import { withEnv } from "../test/helpers";
import {
  SealAccessDeniedError,
  decryptAgentHandoff,
  decryptPrivateMemory,
  encryptAgentHandoff,
  encryptPrivateMemory,
  getSealIntegrationStatus,
} from "./seal";
import type { PrivateMemoryArtifact, SealEnvelope } from "./memory-types";

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
  delete process.env.SEAL_DECRYPT_TIMEOUT_MS;
  delete process.env.SEAL_ENCRYPTION_KEY;
  delete process.env.SEAL_STRICT_MODE;
  delete process.env.WALRUS_PUBLISHER_URL;
  process.env.NODE_ENV = "test";
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
  assert.equal(status.strictMode, true);
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
  assert.equal(envelope.aadVersion, 1);
  assert.ok(envelope.ciphertext, "envelope should carry ciphertext");

  const decrypted = await decryptPrivateMemory(envelope, OWNER);
  assert.deepEqual(decrypted, artifact);
});

test("local envelope rejects owner metadata tampering", async () => {
  forceLocalEnvelopeMode();
  const envelope = await encryptPrivateMemory(makeArtifact(), OWNER);
  const tampered: SealEnvelope = { ...envelope, ownerAddress: OTHER };

  await assert.rejects(() => decryptPrivateMemory(tampered, OTHER));
});

test("legacy local envelope rejects plaintext owner rebinding", async () => {
  forceLocalEnvelopeMode();
  const legacy = encryptLegacyLocalEnvelope(makeArtifact(), OTHER);

  await assert.rejects(
    () => decryptPrivateMemory(legacy, OTHER),
    SealAccessDeniedError
  );
});

test("strict non-mock Seal mode rejects incomplete key-server config instead of fallback", async () => {
  forceLocalEnvelopeMode();

  await withEnv(
    {
      SEAL_MOCK_MODE: "false",
      SEAL_PACKAGE_ID: undefined,
      SEAL_KEY_SERVER_OBJECT_IDS: undefined,
      SEAL_KEY_SERVER_CONFIGS_JSON: undefined,
      SEAL_STRICT_MODE: "true",
    },
    async () => {
      await assert.rejects(
        () => encryptPrivateMemory(makeArtifact(), OWNER),
        /Seal strict mode requires configured Seal SDK key servers/
      );
    }
  );
});

test("local envelope requires an explicit encryption key outside offline development", async () => {
  forceLocalEnvelopeMode();

  await withEnv(
    {
      SEAL_ENCRYPTION_KEY: undefined,
      WALRUS_PUBLISHER_URL: "http://127.0.0.1:31415",
    },
    async () => {
      await assert.rejects(
        () => encryptPrivateMemory(makeArtifact(), OWNER),
        /SEAL_ENCRYPTION_KEY is required/
      );
    }
  );
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

function encryptLegacyLocalEnvelope(
  artifact: PrivateMemoryArtifact,
  envelopeOwnerAddress: string
): SealEnvelope {
  const key = createHash("sha256")
    .update("langclaw-local-seal-development-key")
    .digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(artifact), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return {
    schema: "langclaw.seal-envelope.v1",
    ownerAddress: envelopeOwnerAddress,
    sealPolicyId: "langclaw-private-memory-mainnet",
    sealMode: "local-envelope",
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    createdAt: new Date().toISOString(),
  };
}
