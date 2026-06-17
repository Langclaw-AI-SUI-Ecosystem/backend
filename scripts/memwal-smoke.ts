// MemWal live round-trip smoke test.
//
// Proves the configured MemWal relayer actually accepts a write (remember) and
// returns it on a semantic read (recall) — i.e. the Walrus-backed memory pointer
// store is live, not just config-parsed. Run from backend/:
//
//   node --import tsx --env-file=.env scripts/memwal-smoke.ts
//
// Exits non-zero if the round trip does not recall the freshly written pointer.

import { createMemWalAdapter, getMemWalIntegrationStatus } from "../src/lib/memwal";
import type { MemoryIndexRecord, PrivateMemoryArtifact } from "../src/lib/memory-types";

const DEMO_OWNER =
  "0x00000000000000000000000000000000000000000000000000000000deadbeef";

async function main() {
  const status = getMemWalIntegrationStatus();
  console.log("MemWal status:", JSON.stringify(status, null, 2));

  if (status.status !== "ready") {
    throw new Error(`MemWal is not ready (status=${status.status}). Check MEMWAL_* env.`);
  }

  const adapter = createMemWalAdapter(DEMO_OWNER);
  const marker = `smoke-${Date.now()}`;
  const topic = `MemWal smoke test ${marker} - Sui Walrus alpha memory`;

  const record: MemoryIndexRecord = {
    id: `smoke_${marker}`,
    ownerAddress: DEMO_OWNER,
    runId: `run_${marker}`,
    topic,
    contentHash: `0x${marker.replace(/[^a-f0-9]/g, "0").padEnd(64, "0").slice(0, 64)}`,
    walrusBlobId: `blob_${marker}`,
    walrusObjectId: `0x${"a".repeat(64)}`,
    sealPolicyId: "langclaw-private-memory-mainnet",
    tags: ["smoke", "memwal"],
    createdAt: new Date().toISOString(),
  };

  // allowPrivateSummary is false in the demo, so the artifact body is not read
  // by buildMemWalText, so a minimal stub is sufficient for the round trip.
  const artifact = {
    memorySummary: "redacted in smoke test",
    report: { recommendation: "n/a" },
  } as unknown as PrivateMemoryArtifact;

  console.log(`\n-> remember: "${topic}"`);
  const remembered = await adapter.remember(record, artifact);
  console.log("remember result:", JSON.stringify(remembered, null, 2));

  if (remembered.status !== "remembered") {
    throw new Error(`remember failed: ${remembered.reason ?? "unknown"}`);
  }

  console.log(`\n-> recall by topic marker "${marker}"`);
  const recalled = await adapter.recall(topic);
  console.log(
    "recall result:",
    JSON.stringify(
      {
        status: recalled.status,
        blobIds: recalled.blobIds,
        hits: recalled.memories.map((m) => ({
          distance: m.distance,
          blobId: m.blobId,
          textPreview: m.text.slice(0, 120),
        })),
      },
      null,
      2
    )
  );

  if (recalled.status !== "recalled") {
    throw new Error(`recall failed: ${recalled.reason ?? "unknown"}`);
  }

  const foundMarker = recalled.memories.some((m) => m.text.includes(marker));
  const foundBlob =
    Boolean(remembered.blobId) && recalled.blobIds.includes(remembered.blobId!);

  if (!foundMarker && !foundBlob) {
    throw new Error(
      "Round trip incomplete: freshly remembered pointer was not returned by recall."
    );
  }

  console.log(
    `\nOK MemWal live round trip — wrote blob ${remembered.blobId ?? "(n/a)"}, ` +
      `recalled ${recalled.memories.length} memory(ies); marker match=${foundMarker}, blob match=${foundBlob}.`
  );
}

main().catch((error) => {
  console.error("\nFAIL MemWal smoke test:", error instanceof Error ? error.message : error);
  process.exit(1);
});
