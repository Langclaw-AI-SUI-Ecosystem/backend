/* Proof of REAL Seal threshold encryption: an end-to-end round trip against the
 * configured Seal key server:
 *   encrypt (IBE to key server) -> owner-signed SessionKey -> key server dry-runs
 *   access_policy::seal_approve (owner-only gate) -> decrypt.
 *
 * This is what makes private memory portable across devices: the AES key is no
 * longer machine-local; any device holding the owner's SessionKey can decrypt via
 * the key server. Run from backend/ with env loaded:
 *   node --import tsx --env-file=.env scripts/seal-roundtrip-proof.ts
 */
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

import type {
  ExportedSealSession,
  PrivateMemoryArtifact,
} from "../src/lib/memory-types";
import {
  decryptPrivateMemory,
  encryptPrivateMemory,
  getSealIntegrationStatus,
} from "../src/lib/seal";

function loadKeypair(): Ed25519Keypair {
  const raw = (process.env.SUI_AGENT_PRIVATE_KEY || "").trim();

  if (!raw) {
    throw new Error("SUI_AGENT_PRIVATE_KEY is not set.");
  }

  if (raw.startsWith("suiprivkey")) {
    const { secretKey } = decodeSuiPrivateKey(raw);
    return Ed25519Keypair.fromSecretKey(secretKey);
  }

  if (/^0x?[0-9a-fA-F]{64}$/.test(raw)) {
    return Ed25519Keypair.fromSecretKey(
      Uint8Array.from(Buffer.from(raw.replace(/^0x/, ""), "hex"))
    );
  }

  return Ed25519Keypair.fromSecretKey(
    Uint8Array.from(Buffer.from(raw, "base64")).slice(0, 32)
  );
}

function makeArtifact(owner: string): PrivateMemoryArtifact {
  return {
    schema: "langclaw.sui-walrus.private-memory.v1",
    runId: "run_seal_roundtrip_demo",
    ownerAddress: owner,
    topic: "Seal threshold encryption round-trip",
    prompt: "demo",
    generatedAt: new Date().toISOString(),
    reusedMemoryIds: [],
    memorySummary: "Secret memory that only the owner's Seal session may decrypt.",
    report: {
      title: "Seal round-trip",
      answer: "encrypted to the key server",
      bullets: ["owner-gated by access_policy::seal_approve"],
      recommendation: "Keep monitoring.",
    },
    evidence: { sources: [], providerTrace: [] },
  };
}

async function main() {
  const status = getSealIntegrationStatus();
  console.log("=== Seal integration status ===");
  console.log(JSON.stringify(status, null, 2));

  if (status.mode !== "seal-sdk-configured") {
    console.error(
      "\nNot in seal-sdk-configured mode (need SEAL_MOCK_MODE=false + " +
        "SEAL_KEY_SERVER_OBJECT_IDS + SEAL_PACKAGE_ID). Aborting."
    );
    process.exit(1);
  }

  const keypair = loadKeypair();
  const owner = keypair.getPublicKey().toSuiAddress();
  console.log("\nowner (SessionKey signer):", owner);

  // 1. Encrypt with real Seal (IBE against the live key server).
  const artifact = makeArtifact(owner);
  console.log("\nencrypting via the Seal key server ...");
  const envelope = await encryptPrivateMemory(artifact, owner);
  console.log("  sealMode           :", envelope.sealMode);
  console.log("  keyServerCount     :", envelope.sealKeyServerObjectIds?.length);
  console.log("  identity (id bytes):", envelope.sealIdentity);
  console.log("  encryptedObject len:", envelope.sealEncryptedObject?.length);

  // 2. Owner-signed SessionKey (what a real wallet exports from the frontend).
  const [{ SessionKey }, { SuiJsonRpcClient }] = await Promise.all([
    import("@mysten/seal"),
    import("@mysten/sui/jsonRpc"),
  ]);
  const suiClient = new SuiJsonRpcClient({
    url: process.env.SUI_RPC_URL || "https://fullnode.mainnet.sui.io:443",
    network: (process.env.SUI_NETWORK || "mainnet") as "mainnet",
  });
  const sessionKey = await SessionKey.create({
    address: owner,
    packageId: process.env.SEAL_PACKAGE_ID as string,
    ttlMin: 10,
    suiClient,
  });
  const { signature } = await keypair.signPersonalMessage(
    sessionKey.getPersonalMessage()
  );
  await sessionKey.setPersonalMessageSignature(signature);
  const exported = sessionKey.export() as unknown as ExportedSealSession;

  // 3. Decrypt — the key server dry-runs access_policy::seal_approve and only
  // releases a key share because the SessionKey signer == the owner in `id`.
  console.log(
    "\ndecrypting via Seal (key server runs the owner-only seal_approve gate) ..."
  );
  const decrypted = await decryptPrivateMemory(envelope, owner, exported);

  const ok =
    decrypted.topic === artifact.topic &&
    decrypted.memorySummary === artifact.memorySummary;

  console.log("\n=== ROUND TRIP ===");
  console.log("  decrypted.topic   :", decrypted.topic);
  console.log("  decrypted.summary :", decrypted.memorySummary);
  console.log("  MATCHES original  :", ok);

  if (!ok) {
    console.error("\nFAIL: decrypted artifact does not match the original.");
    process.exit(1);
  }

  console.log(
    "\nOK: real Seal threshold encryption verified end-to-end — encrypt -> key " +
      "server -> owner-gated decrypt. Content is now portable across devices."
  );
}

main().catch((error) => {
  console.error("SEAL ROUNDTRIP FAILED:", error);
  process.exit(1);
});
