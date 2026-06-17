// Public demo memory — a deliberately UNENCRYPTED sample so judges can run the
// full Walrus loop themselves: store -> public aggregator GET -> read the actual
// remembered content (no owner Seal key needed).
//
// This is demo-only and clearly labelled public. Real user memories go through
// the Seal-encrypted, owner-gated path (see memory-workflow.ts); this script
// exists purely so an auditor can read plaintext from a public Walrus blob.
//
//   cd backend && node --import tsx --env-file=.env scripts/walrus-public-demo.ts
//
// Prints the blob id, the public aggregator URL, and a store->read-back hash
// check. Exits non-zero if the round trip is not byte-identical.

import { createWalrusClient, getWalrusBlobUrl, getWalrusStorageStatus } from "../src/lib/walrus";
import { contentHash } from "../src/lib/hash";
import { stableStringify } from "../src/lib/stable-json";
import type { SealEnvelope } from "../src/lib/memory-types";

// A readable, public sample memory. Shape mirrors the private artifact's report
// so judges see what a real remembered run looks like — minus anything private.
const PUBLIC_SAMPLE = {
  schema: "langclaw.walrus.public-demo-memory.v1",
  notice:
    "PUBLIC DEMO MEMORY — intentionally unencrypted for judges. Real user memories are Seal-encrypted and owner-gated.",
  runId: "public-demo",
  topic: "Is SUI staking yield attractive right now?",
  generatedAt: "2026-06-17T00:00:00.000Z",
  report: {
    title: "SUI staking yield — public demo memory",
    recommendation: "Neutral / monitor",
    bullets: [
      "Demo memory written to Walrus so the full retrieve-and-read loop is publicly auditable.",
      "On the live product this exact artifact would be Seal-encrypted before it touches Walrus.",
      "The on-chain MemoryRecorded event would carry only this blob id + hashes, never the content.",
    ],
  },
};

async function main() {
  const status = getWalrusStorageStatus();
  console.log("Walrus storage mode:", status.mode);

  if (status.mode !== "http") {
    throw new Error(
      "Walrus is in local fallback mode. Set WALRUS_PUBLISHER_URL + WALRUS_AGGREGATOR_URL to publish a publicly retrievable blob."
    );
  }

  const walrus = createWalrusClient();
  // The Walrus client serializes whatever object it is given; this public sample
  // stands in for the encrypted envelope on the normal path.
  const envelope = PUBLIC_SAMPLE as unknown as SealEnvelope;
  const expectedHash = contentHash(stableStringify(envelope));

  console.log("\n-> storing public sample on Walrus mainnet...");
  const stored = await walrus.storeEnvelope(envelope);
  const url = getWalrusBlobUrl(stored.walrusBlobId);

  console.log("blob id   :", stored.walrusBlobId);
  console.log("object id :", stored.walrusObjectId);
  console.log("public URL:", url ?? "(none — not in http mode)");

  console.log("\n-> reading the blob back from the public aggregator...");
  const readBack = await walrus.readEnvelope(stored.walrusBlobId);
  const readHash = contentHash(stableStringify(readBack));
  const ok = readHash === expectedHash;

  console.log("hash match:", ok ? "yes (byte-identical)" : "NO");
  console.log("\nAnyone can now read the remembered content with:");
  console.log(`  curl -s ${url}`);

  if (!ok) {
    throw new Error("Walrus round trip was not byte-identical.");
  }

  console.log("\nOK public demo memory is live and byte-stable on Walrus mainnet.");
}

main().catch((error) => {
  console.error("\nFAIL walrus public demo:", error instanceof Error ? error.message : error);
  process.exit(1);
});
