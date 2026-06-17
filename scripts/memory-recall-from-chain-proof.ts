/* Proof that an owner's private-memory pointer index can be rebuilt purely from
 * Sui `MemoryRecorded` events — i.e. recall is portable across devices and no
 * longer trapped in the local on-disk index.
 *
 * Run from backend/ with env loaded so the registry package id is configured:
 *   node --import tsx --env-file=.env scripts/memory-recall-from-chain-proof.ts
 *   node --import tsx --env-file=.env scripts/memory-recall-from-chain-proof.ts 0x<owner>
 */
import {
  fetchOwnerMemoryPointersFromChain,
  getChainMemoryIndexStatus,
} from "../src/lib/sui-memory-index";

const DEFAULT_OWNER = "0x" + "ab".repeat(32);

async function main() {
  const owner = (process.argv[2] || DEFAULT_OWNER).trim();
  const status = getChainMemoryIndexStatus();

  console.log("=== recall-from-chain status ===");
  console.log(JSON.stringify(status, null, 2));

  if (!status.enabled || !status.configured) {
    console.error(
      "\nChain recall not configured. Set SUI_REGISTRY_PACKAGE_ID (or " +
        "SUI_REGISTRY_EVENT_PACKAGE_ID) and ensure SUI_MEMORY_RECALL_FROM_CHAIN != false."
    );
    process.exit(1);
  }

  console.log("\n=== querying Sui for owner's MemoryRecorded events ===");
  console.log("owner:", owner);

  const pointers = await fetchOwnerMemoryPointersFromChain(owner, { limit: 25 });

  console.log("\npointers rebuilt from chain:", pointers.length);
  for (const pointer of pointers) {
    console.log("  -", {
      runId: pointer.runId,
      walrusBlobId: pointer.walrusBlobId,
      suiTxDigest: pointer.suiTxDigest,
      createdAt: pointer.createdAt,
    });
  }

  if (pointers.length === 0) {
    console.log(
      "\n(no on-chain memories for this owner - run the anchor proof first: " +
        "node --import tsx --env-file=.env scripts/walrus-mainnet-proof.ts)"
    );
  } else {
    console.log(
      "\nOK: the pointer index was reconstructed from Sui alone — a fresh device " +
        "with an empty local index recovers these encrypted-memory pointers."
    );
  }
}

main().catch((error) => {
  console.error("RECALL-FROM-CHAIN PROOF FAILED:", error);
  process.exit(1);
});
