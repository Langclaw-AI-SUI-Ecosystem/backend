/* One-shot proof that the verifiable-memory pipeline works against Walrus
 * mainnet. Runs runPrivateMemoryWorkflow with a deterministic stub
 * research runner (no OpenAI / no auth needed), then independently re-fetches the
 * stored blob from the public aggregator to confirm retrievability. Prints the
 * values used to fill the "Current Walrus Verification" table in README.md.
 *
 * Run from backend/:
 *   node --import tsx scripts/walrus-mainnet-proof.ts "Sui liquid staking risk"
 *
 * Override endpoints via WALRUS_PUBLISHER_URL / WALRUS_AGGREGATOR_URL.
 * Mainnet publishing needs your own authenticated publisher or upload relay.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { runPrivateMemoryWorkflow } from "../src/lib/memory-workflow";

process.env.WALRUS_AGGREGATOR_URL ||=
  "https://aggregator.walrus-mainnet.walrus.space";
process.env.WALRUS_EPOCHS ||= "5";
// Use a throwaway local index so this probe never touches real state.
process.env.LANGCLAW_LOCAL_STATE_DIR ||= mkdtempSync(
  path.join(tmpdir(), "walrus-proof-")
);

const OWNER = "0x" + "ab".repeat(32);

function stubResearch(t: string): any {
  return {
    topic: t,
    generatedAt: new Date().toISOString(),
    sources: [
      {
        id: "s1",
        type: "docs_page",
        title: "Walrus docs",
        url: "https://docs.wal.app",
        excerpt: "Walrus is a decentralized storage and data-availability network.",
        provider: "Tavily",
      },
    ],
    errors: [],
    providerTrace: [
      { provider: "tavily", status: "success", scope: "topic", message: "ok" },
    ],
    orchestration: { runtime: "typescript", steps: [] },
    finalConclusion: {
      headline: "Verifiable memory demo",
      summary: `Encrypted research memory for "${t}" stored on Walrus.`,
      keySignals: [{ label: "Storage", text: "Stored on Walrus", sourceIds: [] }],
      recommendation: "Keep monitoring.",
      qualityNote: "",
      generatedBy: "walrus-mainnet-proof",
    },
    finalAnswer: {
      answer: "Demo answer persisted as a Seal-encrypted blob on Walrus.",
      bullets: ["Stored on Walrus mainnet", "Re-fetched and hash-verified"],
      recommendation: "Keep monitoring.",
      generatedBy: "walrus-mainnet-proof",
    },
    finalAnswerMeta: { synthesis: "deterministic-fallback" },
    agentOutputs: {
      planner: { plan: 1 },
      trend: { trend: 2 },
      evidence: { evidence: 3 },
      verifier: { verifier: 4 },
    },
  };
}

async function main() {
  const topic =
    process.argv.slice(2).join(" ").trim() ||
    "Sui liquid staking risk - verifiable memory demo";

  console.log("Walrus publisher :", process.env.WALRUS_PUBLISHER_URL);
  console.log("Walrus aggregator:", process.env.WALRUS_AGGREGATOR_URL);
  console.log("Topic            :", topic, "\n");

  const run = await runPrivateMemoryWorkflow(
    { topic, ownerAddress: OWNER },
    { runResearch: (async (t: string) => stubResearch(t)) as never }
  );

  const proof = run.walrusMemory;

  if (!proof) {
    console.error("No walrusMemory proof produced.");
    process.exit(1);
  }

  // Independent retrievability check: GET the blob straight from the public
  // aggregator, bypassing our own client, to prove it is really there.
  let independent = "skipped (no public blobUrl)";
  if (proof.walrusBlobUrl) {
    try {
      const res = await fetch(proof.walrusBlobUrl);
      const body = await res.text();
      independent = `${res.status} ${res.ok ? "OK" : "FAIL"} - ${body.length} bytes`;
    } catch (error) {
      independent = `error: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }

  console.log("=== walrusMemory proof ===");
  console.log(JSON.stringify(proof, null, 2));

  console.log("\n=== independent aggregator GET (proves public retrievability) ===");
  console.log("url   :", proof.walrusBlobUrl);
  console.log("result:", independent);

  console.log("\n=== values for the README table ===");
  console.log("walrusStorageMode :", proof.walrusStorageMode);
  console.log("storageStatus     :", proof.storageStatus);
  console.log("retrievalStatus   :", proof.retrievalStatus);
  console.log("hashVerified      :", proof.hashVerified);
  console.log("blobId            :", proof.walrusBlobId);
  console.log("blobUrl           :", proof.walrusBlobUrl);
  console.log("sealMode          :", proof.sealMode);
  console.log("suiNetwork        :", proof.suiNetwork);
  console.log(
    "suiTxDigest       :",
    proof.suiTxDigest ?? "(none - local Seal, no on-chain anchor)"
  );
  console.log("suiTxUrl          :", proof.suiTxUrl ?? "(none)");
  console.log(
    "agentHandoffs     :",
    (proof.agentPipeline ?? []).map((h) => h.role).join(", ")
  );
}

main().catch((error) => {
  console.error("WALRUS MAINNET PROOF FAILED:", error);
  process.exit(1);
});
