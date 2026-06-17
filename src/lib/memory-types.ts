// Shared types for the Sui + Walrus private-memory layer.
//
// Ported from the sibling `langclaw-sui-walrus` project but decoupled from its
// chain-data/suiResearch payloads: this project carries its own richer research
// result inside `PrivateMemoryArtifact.research` (typed `unknown` to avoid an
// import cycle with the OpenClaw research engine in `langclaw/types.ts`).

export type SuiNetwork = "testnet" | "mainnet" | "devnet" | "localnet";

export type WalrusMemoryStatus = "prepared" | "uploaded" | "failed";
export type WalrusRetrievalStatus = "not_requested" | "retrieved" | "failed";
export type SealMode = "local-envelope" | "seal-sdk-configured";
export type SuiRegistryStatus = "recorded" | "skipped" | "failed";
export type MemWalStatus = "remembered" | "skipped" | "failed";
export type AgentMode = "openai" | "template";

export type ResearchKeySignal = { label: string; text: string };

export type WalrusMemoryProof = {
  runId: string;
  topic: string;
  contentHash: string;
  walrusBlobId: string;
  walrusObjectId: string;
  sealPolicyId: string;
  suiTxDigest?: string;
  storageStatus: WalrusMemoryStatus;
  /** Why storage failed, when `storageStatus === "failed"` (e.g. a flaky Walrus
   * publisher). The research run still completes; the memory is just un-anchored. */
  storageReason?: string;
  retrievalStatus: WalrusRetrievalStatus;
  /** Whether the re-fetched Walrus blob is byte-identical to what was stored
   * (a store -> read-back -> hash-compare round trip). Undefined if retrieval
   * was not attempted. */
  hashVerified?: boolean;
  /** "http" when the blob lives on the Walrus network (real, publicly
   * retrievable), "local" when it fell back to on-disk storage. Lets the UI be
   * honest about whether a blob is truly verifiable. */
  walrusStorageMode?: "http" | "local";
  /** Public aggregator URL that returns the stored blob. Only set in "http"
   * mode — there is no public URL for a local-fallback blob. */
  walrusBlobUrl?: string;
  /** Sui explorer URL for `suiTxDigest`. Only set when a real on-chain proof
   * was recorded (not for the local synthetic digest). */
  suiTxUrl?: string;
  suiNetwork?: SuiNetwork;
  reusedMemoryIds: string[];
  agentMode: AgentMode;
  agentModel?: string;
  agentReason?: string;
  agentPipeline?: Array<{ role: string; walrusBlobId: string }>;
  sealMode: SealMode;
  registryStatus: SuiRegistryStatus;
  registryReason?: string;
  memWalStatus: MemWalStatus;
  memWalReason?: string;
  memWalJobId?: string;
  memWalBlobId?: string;
  memWalRecalledBlobIds: string[];
  /** Agent-handoff blobs from prior runs that this run re-fetched and decrypted
   * from Walrus (closing the multi-agent loop — Walrus as shared state across
   * runs, not write-only). */
  reusedHandoffBlobIds: string[];
  createdAt: string;
};

export type MemoryIndexRecord = {
  id: string;
  ownerAddress: string;
  runId: string;
  topic: string;
  contentHash: string;
  walrusBlobId: string;
  walrusObjectId: string;
  sealPolicyId: string;
  suiTxDigest?: string;
  tags: string[];
  createdAt: string;
};

export type RetrievedMemory = MemoryIndexRecord & {
  artifact: PrivateMemoryArtifact;
};

export type PrivateMemoryArtifact = {
  schema: "langclaw.sui-walrus.private-memory.v1";
  runId: string;
  ownerAddress: string;
  topic: string;
  prompt: string;
  generatedAt: string;
  reusedMemoryIds: string[];
  memorySummary: string;
  report: {
    title: string;
    answer: string;
    bullets: string[];
    recommendation: string;
    bottomLine?: string;
    keySignals?: ResearchKeySignal[];
    caveats?: string[];
  };
  evidence: {
    sources: Array<{ id: string; title: string; url?: string; excerpt: string }>;
    providerTrace: Array<{ provider: string; status: string; message: string }>;
  };
  /** Walrus blob ids of this run's inter-agent handoffs (planner/trend/evidence/
   * verifier), stored alongside the artifact so a later run can re-fetch and
   * decrypt them straight from Walrus — no metadata-index schema change needed. */
  agentHandoffs?: Array<{ role: string; walrusBlobId: string }>;
  /** Full research payload preserved inside the encrypted memory. Typed `unknown`
   * so the encrypted artifact can carry this project's OpenClaw `DiscoverPayload`
   * without coupling the memory layer to the research engine's types. */
  research?: unknown;
};

export type SealEnvelope = {
  schema: "langclaw.seal-envelope.v1";
  ownerAddress: string;
  sealPolicyId: string;
  sealMode: SealMode;
  sealPackageId?: string;
  sealIdentity?: string;
  sealKeyServerCount?: number;
  // local-envelope mode (offline AES-256-GCM fallback)
  algorithm?: "aes-256-gcm";
  iv?: string;
  authTag?: string;
  ciphertext?: string;
  // seal-sdk-configured mode (threshold encryption via key servers)
  sealThreshold?: number;
  sealKeyServerObjectIds?: string[];
  sealEncryptedObject?: string;
  createdAt: string;
};

/** Owner-signed Seal session key, exported by the frontend and replayed by the
 * backend to decrypt prior memories. Mirrors `ExportedSessionKey` from @mysten/seal. */
export type ExportedSealSession = {
  address: string;
  packageId: string;
  mvrName?: string;
  creationTimeMs: number;
  ttlMin: number;
  personalMessageSignature?: string;
  sessionKey: string;
};
