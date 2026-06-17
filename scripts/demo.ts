// End-to-end demo of Langclaw's durable private verifiable memory on Sui + Walrus.
//
// Runs two related research topics for the same wallet IN-PROCESS (no HTTP /
// Supabase / billing needed). Run 2 recalls and decrypts run 1's Seal-encrypted
// Walrus memory and feeds it back into the research pipeline — proving durable
// private recall across sessions. Everything works offline via local fallbacks;
// set WALRUS_*/SEAL_*/SUI_REGISTRY_*/MEMWAL_* env for the live mainnet path.
//
// Run from backend/: node --import tsx scripts/demo.ts
import "../src/env";

import { runPrivateMemoryWorkflow } from "../src/lib/memory-workflow";
import type { DiscoverPayload } from "../src/lib/langclaw/types";

const OWNER = (process.env.DEMO_WALLET_ADDRESS || `0x${"11".repeat(32)}`).trim();
const AGGREGATOR =
  process.env.WALRUS_AGGREGATOR_URL ||
  "https://aggregator.walrus-mainnet.walrus.space";
const EXPLORER_TX = (digest: string) => `https://suivision.xyz/txblock/${digest}`;

const TOPIC_1 = "Walrus durable memory for autonomous Sui trading agents";
const TOPIC_2 = "How should a Sui trading agent reuse its prior Walrus memory?";

async function main() {
  // Default to the fully-local path so the demo runs offline with no DB. Set
  // DEMO_USE_SUPABASE=true to persist the metadata index to Supabase instead
  // (requires the langclaw_private_memory_index table; see supabase/migrations).
  if (process.env.DEMO_USE_SUPABASE !== "true") {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  }

  banner("Langclaw — durable private verifiable agent memory (Sui Walrus)");
  console.log(`Wallet (owner): ${OWNER}\n`);

  const first = await runPrivateMemoryWorkflow({ topic: TOPIC_1, ownerAddress: OWNER });
  printRun("RUN 1 — new private memory", first);

  const second = await runPrivateMemoryWorkflow({ topic: TOPIC_2, ownerAddress: OWNER });
  printRun("RUN 2 — related topic (durable recall)", second);

  banner("What just happened");
  const reused = second.reusedMemories?.length ?? 0;
  console.log("• Run 1 researched a topic, encrypted the evidence with Seal, and");
  console.log("  stored it on Walrus with a metadata-only proof.");
  console.log("• Run 2 recalled run 1 from the index + MemWal, decrypted it with Seal");
  console.log(`  (${reused} prior memor${reused === 1 ? "y" : "ies"} reused), and built on it.`);
  console.log("• Every artifact is on Walrus; every run carries a verifiable proof.\n");
}

function printRun(title: string, payload: DiscoverPayload) {
  const proof = payload.walrusMemory;
  banner(title);
  console.log(`Topic        : ${payload.topic}`);

  if (!proof) {
    console.log("(no walrus memory proof attached)\n");
    return;
  }

  console.log(
    `Agents       : ${proof.agentMode === "openai" ? `multi-agent via ${proof.agentModel}` : "template fallback"}`
  );
  for (const handoff of proof.agentPipeline ?? []) {
    console.log(`   ↳ ${handoff.role} handoff → Walrus ${handoff.walrusBlobId}`);
  }
  console.log(`Answer       : ${oneLine(payload.finalAnswer?.answer || "")}`);
  console.log(`Seal mode    : ${proof.sealMode}`);
  console.log(`Content hash : ${proof.contentHash}`);
  console.log(`Walrus blob  : ${proof.walrusBlobId}`);
  console.log(`               ${AGGREGATOR}/v1/blobs/${proof.walrusBlobId}`);
  console.log(
    `On-chain     : ${proof.registryStatus}${proof.suiTxDigest ? ` — ${EXPLORER_TX(proof.suiTxDigest)}` : ""}`
  );
  console.log(
    `MemWal       : ${proof.memWalStatus}${proof.memWalBlobId ? ` (blob ${proof.memWalBlobId})` : ""}`
  );
  const reused = payload.reusedMemories ?? [];
  console.log(
    `Recall       : ${reused.length ? `reused ${reused.map((m) => `"${m.topic}"`).join("; ")}` : "no prior memory"}`
  );
  console.log("");
}

function oneLine(value: string) {
  const text = (value || "").replace(/\s+/g, " ").trim();
  return text.length > 150 ? `${text.slice(0, 150)}…` : text;
}

function banner(title: string) {
  console.log("─".repeat(72));
  console.log(title);
  console.log("─".repeat(72));
}

main().catch((error) => {
  console.error("DEMO FAILED:", error);
  process.exit(1);
});
