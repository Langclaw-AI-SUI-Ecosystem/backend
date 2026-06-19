import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { jsonResponse, mockFetch, withEnv } from "../test/helpers";
import type { MemoryIndexRecord, SealEnvelope } from "./memory-types";
import { getWalrusReadiness } from "./readiness";

const OWNER = `0x${"12".repeat(32)}`;

function makeRecord(input: {
  id: string;
  blobId: string;
  createdAt: string;
}): MemoryIndexRecord {
  return {
    id: input.id,
    ownerAddress: OWNER,
    runId: `run_${input.id}`,
    topic: "Sui readiness proof",
    contentHash: `0x${"34".repeat(32)}`,
    walrusBlobId: input.blobId,
    walrusObjectId: `0x${"56".repeat(32)}`,
    sealPolicyId: "langclaw-private-memory-mainnet",
    tags: ["readiness"],
    createdAt: input.createdAt,
  };
}

function makeEnvelope(): SealEnvelope {
  return {
    schema: "langclaw.seal-envelope.v1",
    ownerAddress: OWNER,
    sealPolicyId: "langclaw-private-memory-mainnet",
    sealMode: "local-envelope",
    algorithm: "aes-256-gcm",
    iv: "aXY=",
    authTag: "dGFn",
    ciphertext: "Y2lwaGVy",
    createdAt: "2026-06-19T00:00:00.000Z",
  };
}

test("readiness skips local fallback blobs when HTTP Walrus is configured", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "langclaw-readiness-"));
  const stateDir = path.join(dir, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    path.join(stateDir, "memory-index.json"),
    JSON.stringify(
      [
        makeRecord({
          id: "local-newer",
          blobId: "walrus_2817d95f267fdccb04cc0e0522ba73a0",
          createdAt: "2026-06-19T08:53:51.882Z",
        }),
        makeRecord({
          id: "public-older",
          blobId: "B1-tCgsFYKKvmiKqsRIJs7WZE6rOFFW0KglbAWmAk2U",
          createdAt: "2026-06-19T08:04:54.117Z",
        }),
      ],
      null,
      2
    )
  );

  const fetchedUrls: string[] = [];
  const restoreFetch = mockFetch((url) => {
    fetchedUrls.push(url);

    if (url.endsWith("/v1/blobs/B1-tCgsFYKKvmiKqsRIJs7WZE6rOFFW0KglbAWmAk2U")) {
      return jsonResponse(makeEnvelope());
    }

    return jsonResponse({ error: "not found" }, { status: 400 });
  });

  try {
    await withEnv(
      {
        LANGCLAW_LOCAL_STATE_DIR: stateDir,
        SUPABASE_URL: undefined,
        SUPABASE_SERVICE_ROLE_KEY: undefined,
        WALRUS_PUBLISHER_URL: "https://publisher.test",
        WALRUS_AGGREGATOR_URL: "https://aggregator.test",
        WALRUS_TIMEOUT_MS: "1000",
        SEAL_MOCK_MODE: "true",
        MEMWAL_ENABLED: "false",
        SUI_REGISTRY_ENABLED: "false",
      },
      async () => {
        const report = await getWalrusReadiness();
        const proofCheck = report.checks.find(
          (check) => check.name === "latestMemoryProof"
        );

        assert.equal(report.ready, true);
        assert.equal(
          report.latest?.walrusBlobId,
          "B1-tCgsFYKKvmiKqsRIJs7WZE6rOFFW0KglbAWmAk2U"
        );
        assert.equal(proofCheck?.status, "ready");
        assert.equal(proofCheck?.details?.retrievalSource, "aggregator");
        assert.equal(proofCheck?.details?.skippedProofCount, 1);
        assert.deepEqual(fetchedUrls, [
          "https://aggregator.test/v1/blobs/B1-tCgsFYKKvmiKqsRIJs7WZE6rOFFW0KglbAWmAk2U",
        ]);
      }
    );
  } finally {
    restoreFetch();
    rmSync(dir, { recursive: true, force: true });
  }
});
