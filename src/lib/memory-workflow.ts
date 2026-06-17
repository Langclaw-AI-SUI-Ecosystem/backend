// Private memory workflow — the Sui + Walrus layer wrapped around the existing
// OpenClaw research engine (`runLangclawWorkflow`).
//
// Pipeline: recall prior encrypted memory (metadata index + MemWal) -> run the
// research workflow with the recalled context injected -> encrypt the evidence
// artifact with Seal -> store it on Walrus -> persist inter-agent handoffs on
// Walrus -> save a metadata-only index record -> record a Sui MemoryRecorded
// proof + a redacted MemWal pointer. Everything degrades to local fallbacks so
// the whole flow runs offline with zero credentials.

import { runLangclawWorkflow } from "./langclaw/workflow";
import type {
  DiscoverPayload,
  WorkflowProgressEvent,
} from "./langclaw/types";
import type {
  OnChainContextMessage,
  OnChainPlanSummary,
  OnChainToolCallEvent,
  OnChainToolResult,
} from "./onchain-tools/types";
import { contentHash as hashContent, shortId } from "./hash";
import { stableStringify } from "./stable-json";
import { createMemoryIndex, pickRelevantMemories } from "./memory-index";
import { createMemWalAdapter, type MemWalRememberResult } from "./memwal";
import {
  createWalrusClient,
  getWalrusBlobUrl,
  getWalrusStorageStatus,
  type WalrusClient,
  type WalrusStoreResult,
} from "./walrus";
import { DEFAULT_SUI_EXPLORER_URL } from "./sui-onchain";
import {
  decryptAgentHandoff,
  decryptPrivateMemory,
  encryptAgentHandoff,
  encryptPrivateMemory,
  getSealPolicyId,
} from "./seal";
import { recordSuiMemoryMetadata, type SuiRegistryResult } from "./sui-registry";
import {
  chainPointerToIndexRecord,
  fetchOwnerMemoryPointersFromChain,
} from "./sui-memory-index";
import type {
  ExportedSealSession,
  MemoryIndexRecord,
  PrivateMemoryArtifact,
  RetrievedMemory,
  SealEnvelope,
  SuiNetwork,
  WalrusMemoryProof,
  WalrusRetrievalStatus,
} from "./memory-types";

export type RunPrivateMemoryInput = {
  topic: string;
  ownerAddress: string;
  sealSession?: ExportedSealSession;
  chain?: string;
  requestedModel?: unknown;
  /** Caller-supplied context (e.g. chat conversation history). Merged with —
   * not replaced by — the recalled prior-memory context. */
  context?: OnChainContextMessage[];
  onEvent?: (event: WorkflowProgressEvent) => void | Promise<void>;
  onToolCall?: (event: OnChainToolCallEvent) => void | Promise<void>;
  onToolPlan?: (plan: OnChainPlanSummary) => void | Promise<void>;
  onToolResult?: (event: OnChainToolResult) => void | Promise<void>;
  signal?: AbortSignal;
};

type ResearchRunner = typeof runLangclawWorkflow;

export type RunPrivateMemoryDeps = {
  runResearch?: ResearchRunner;
};

const privateMemoryStep = {
  agent: "Private Memory Commit",
  skill: "memory-workflow/sui-walrus",
  stepId: "private-memory-commit",
} as const;

export async function runPrivateMemoryWorkflow(
  input: RunPrivateMemoryInput,
  deps: RunPrivateMemoryDeps = {}
): Promise<DiscoverPayload> {
  const runResearch = deps.runResearch ?? runLangclawWorkflow;
  const ownerAddress = input.ownerAddress;
  const topic = input.topic;

  const walrus = createWalrusClient();
  const memoryIndex = createMemoryIndex();
  const memWal = createMemWalAdapter(ownerAddress);

  // 1. Recall prior encrypted memory (MemWal semantic + metadata-index overlap).
  const recall = await recallMemories({
    ownerAddress,
    topic,
    sealSession: input.sealSession,
    memoryIndex,
    memWal,
    walrus,
  });

  // 2. Run the research engine with the recalled memory injected as context.
  // Caller context (chat history) comes first, then recalled prior memories.
  const research = await runResearch(topic, {
    chain: input.chain,
    context: [...(input.context ?? []), ...recall.context],
    requestedModel: input.requestedModel,
    onEvent: input.onEvent,
    onToolCall: input.onToolCall,
    onToolPlan: input.onToolPlan,
    onToolResult: input.onToolResult,
    signal: input.signal,
  });

  const generatedAt = research.generatedAt || new Date().toISOString();
  const runId = shortId("run", `${ownerAddress}:${topic}:${generatedAt}`);
  const storageTimeoutMs = getPrivateMemoryStorageTimeoutMs();
  const ancillaryTimeoutMs = getPrivateMemoryAncillaryTimeoutMs();

  await emitMemoryProgress(
    input,
    "running",
    "Persisting private memory proof after the research answer is ready."
  );

  // 3. Persist one compact inter-agent handoff bundle. This is useful for the
  // multi-agent loop, but it is not allowed to block the main private-memory
    // blob. Public Walrus publishes can take around 10s each, so four
  // serial handoff uploads before the main memory blob made the demo fragile.
  let agentPipeline: Array<{ role: string; walrusBlobId: string }> = [];

  agentPipeline = await withTimeout(
    storeAgentHandoffs(research, walrus),
    ancillaryTimeoutMs,
    "Walrus handoff bundle storage"
  ).catch(() => []);

  // 4. Build the private memory artifact (full research + handoff pointers).
  const artifact = buildArtifact({
    research,
    ownerAddress,
    topic,
    runId,
    generatedAt,
    reusedMemoryIds: recall.reusedMemoryIds,
    agentHandoffs: agentPipeline,
  });
  const contentHash = hashContent(stableStringify(artifact));

  // 5. Encrypt + store the evidence artifact on Walrus. Storage is best-effort:
  // a flaky publisher must NOT discard the already-completed research run, so we
  // degrade to an honest un-anchored proof instead of throwing.
  const walrusStatus = getWalrusStorageStatus();
  let storageReason: string | undefined;

  let envelope: SealEnvelope | undefined;
  try {
    envelope = await withTimeout(
      encryptPrivateMemory(artifact, ownerAddress),
      storageTimeoutMs,
      "Seal private memory encryption"
    );
  } catch (error) {
    storageReason = readErrorMessage(error, "Seal private memory encryption failed.");
  }

  let stored: WalrusStoreResult | undefined;
  if (envelope) {
    try {
      stored = await withTimeout(
        walrus.storeEnvelope(envelope),
        storageTimeoutMs,
        "Walrus private memory storage"
      );
    } catch (error) {
      storageReason = joinReasons(
        storageReason,
        readErrorMessage(error, "Walrus store failed.")
      );
    }
  }

  // 5b. Verifiable round trip: re-fetch the blob and confirm it is byte-identical
  // to what we stored (store -> read-back -> hash compare). Skipped when storage
  // failed. Best-effort: never throws.
  const walrusVerification =
    stored && envelope
      ? await withTimeout(
          verifyWalrusRoundTrip(walrus, stored.walrusBlobId, envelope),
          ancillaryTimeoutMs,
          "Walrus private memory read-back"
        ).catch(() => ({
          retrievalStatus: "failed" as WalrusRetrievalStatus,
          hashVerified: false,
        }))
      : { retrievalStatus: "failed" as WalrusRetrievalStatus, hashVerified: false };

  // 6/7. Anchor the memory only when it actually landed on Walrus: save a
  // metadata-only index record, record the public Sui proof, and write a redacted
  // MemWal pointer. A dangling pointer to a blob that never stored would poison
  // recall, so all anchoring is skipped when storage failed.
  let registry: SuiRegistryResult = {
    status: "skipped",
    reason: storageReason
      ? "Walrus storage failed; memory not anchored."
      : undefined,
  };
  let remember: MemWalRememberResult = {
    status: "skipped",
    reason: storageReason
      ? "Walrus storage failed; nothing to remember."
      : undefined,
  };

  if (stored) {
    const record: MemoryIndexRecord = {
      id: shortId("mem", `${ownerAddress}:${runId}`),
      ownerAddress,
      runId,
      topic,
      contentHash,
      walrusBlobId: stored.walrusBlobId,
      walrusObjectId: stored.walrusObjectId,
      sealPolicyId: envelope?.sealPolicyId ?? getSealPolicyId(),
      tags: buildTags(topic),
      createdAt: generatedAt,
    };

    registry = await withTimeout(
      recordSuiMemoryMetadata(record),
      ancillaryTimeoutMs,
      "Sui memory registry"
    ).catch((error): SuiRegistryResult => ({
        status: "failed",
        reason: error instanceof Error ? error.message : "Sui registry failed.",
      }));

    if (registry.status === "recorded" && registry.suiTxDigest) {
      record.suiTxDigest = registry.suiTxDigest;
    }

    await withTimeout(
      memoryIndex.save(record),
      ancillaryTimeoutMs,
      "Memory index save"
    ).catch(() => undefined);

    remember = await withTimeout(
      memWal.remember(record, artifact),
      ancillaryTimeoutMs,
      "MemWal remember"
    ).catch((error): MemWalRememberResult => ({
        status: "failed",
        reason: error instanceof Error ? error.message : "MemWal remember failed.",
      }));
  }

  // 8. Attach the verifiable-memory proof + recall summary to the payload.
  const onWalrusNetwork = walrusStatus.mode === "http";
  // A real, explorer-linkable Sui tx: the on-chain memory anchor, or (in network
  // mode) the Walrus publisher's blob-registration tx. Never the local synthetic
  // "local-..." digest — that would look on-chain but was never sent on chain.
  const realSuiTxDigest =
    registry.suiTxDigest ?? (onWalrusNetwork ? stored?.suiTxDigest : undefined);
  const proof: WalrusMemoryProof = {
    runId,
    topic,
    contentHash,
    walrusBlobId: stored?.walrusBlobId ?? "",
    walrusObjectId: stored?.walrusObjectId ?? "",
    sealPolicyId: envelope?.sealPolicyId ?? getSealPolicyId(),
    suiTxDigest: realSuiTxDigest,
    storageStatus: stored ? "uploaded" : "failed",
    storageReason,
    retrievalStatus: walrusVerification.retrievalStatus,
    hashVerified: walrusVerification.hashVerified,
    walrusStorageMode: walrusStatus.mode,
    // Only a network blob has a real, publicly retrievable URL.
    walrusBlobUrl:
      stored && onWalrusNetwork ? getWalrusBlobUrl(stored.walrusBlobId) : undefined,
    suiNetwork: resolveSuiNetwork(),
    suiTxUrl: realSuiTxDigest ? buildSuiTxUrl(realSuiTxDigest) : undefined,
    reusedMemoryIds: recall.reusedMemoryIds,
    agentMode: research.finalAnswerMeta?.synthesis === "openai" ? "openai" : "template",
    agentModel: research.finalAnswerMeta?.model,
    agentReason: research.finalAnswerMeta?.synthesis,
    agentPipeline,
    sealMode: envelope?.sealMode ?? "local-envelope",
    registryStatus: registry.status,
    registryReason: registry.reason,
    memWalStatus: remember.status,
    memWalReason: remember.reason,
    memWalJobId: remember.jobId,
    memWalBlobId: remember.blobId,
    memWalRecalledBlobIds: recall.memWalRecalledBlobIds,
    reusedHandoffBlobIds: recall.recalledHandoffBlobIds,
    createdAt: generatedAt,
  };

  research.walrusMemory = proof;
  research.reusedMemories = recall.memories.map((memory) => ({
    id: memory.id,
    topic: memory.topic,
    walrusBlobId: memory.walrusBlobId,
    contentHash: memory.contentHash,
    createdAt: memory.createdAt,
  }));

  await emitMemoryProgress(
    input,
    stored ? "complete" : "failed",
    stored
      ? "Private memory proof persisted and attached to the result."
      : `Private memory proof skipped after timeout or storage failure. ${storageReason ?? ""}`.trim()
  );

  return research;
}

type RecallResult = {
  memories: RetrievedMemory[];
  reusedMemoryIds: string[];
  memWalRecalledBlobIds: string[];
  recalledHandoffBlobIds: string[];
  context: OnChainContextMessage[];
};

async function recallMemories(input: {
  ownerAddress: string;
  topic: string;
  sealSession?: ExportedSealSession;
  memoryIndex: ReturnType<typeof createMemoryIndex>;
  memWal: ReturnType<typeof createMemWalAdapter>;
  walrus: ReturnType<typeof createWalrusClient>;
}): Promise<RecallResult> {
  const { ownerAddress, topic, memoryIndex, memWal, walrus, sealSession } = input;

  const localRecords = await memoryIndex.listForOwner(ownerAddress).catch(() => []);

  // Recall-from-chain: pull this owner's memory pointers from on-chain
  // `MemoryRecorded` events so memory is portable across devices instead of
  // trapped in a local index. Chain pointers carry no topic/tags (privacy
  // invariant), so they join as a recency fallback and recover their topic once
  // the encrypted artifact is fetched and decrypted below.
  const chainRecords = (
    await fetchOwnerMemoryPointersFromChain(ownerAddress).catch(() => [])
  )
    .filter(
      (pointer) =>
        !localRecords.some((record) => record.walrusBlobId === pointer.walrusBlobId)
    )
    .map(chainPointerToIndexRecord);
  const records = [...localRecords, ...chainRecords];

  const memWalRecall = await memWal.recall(topic).catch(() => null);
  const memWalRecalledBlobIds = memWalRecall?.blobIds ?? [];

  // Prefer MemWal semantic hits (matched by walrus blob id), then token-overlap
  // scoring over the metadata index, then the most recent chain-only pointers
  // (which have no local topic to score against).
  const memWalMatched = memWalRecalledBlobIds.length
    ? records.filter((record) => memWalRecalledBlobIds.includes(record.walrusBlobId))
    : [];
  const selected = dedupeById([
    ...memWalMatched,
    ...pickRelevantMemories(records, topic, 3),
    ...chainRecords,
  ]).slice(0, 3);

  const memories: RetrievedMemory[] = [];

  for (const record of selected) {
    try {
      const envelope = await walrus.readEnvelope(record.walrusBlobId);
      const artifact = await decryptPrivateMemory(envelope, ownerAddress, sealSession);
      memories.push({ ...record, artifact });
    } catch {
      // A memory we cannot decrypt/retrieve is skipped, not fatal.
    }
  }

  const context: OnChainContextMessage[] = memories.map((memory) => ({
    role: "assistant",
    content: [
      `Prior private memory recalled for "${memory.topic}" (${memory.createdAt}).`,
      memory.artifact.memorySummary
        ? `Summary: ${memory.artifact.memorySummary}`
        : "",
      memory.artifact.report?.recommendation
        ? `Prior recommendation: ${memory.artifact.report.recommendation}`
        : "",
    ]
      .filter(Boolean)
      .join(" "),
  }));

  // Close the multi-agent loop: re-fetch + decrypt prior runs' agent handoffs
  // straight from Walrus and inject them, so this run builds on prior agent
  // reasoning that lives on Walrus (shared state across runs, not write-only).
  const handoffRecall = await recallAgentHandoffs(memories, walrus);
  context.push(...handoffRecall.context);

  return {
    memories,
    reusedMemoryIds: memories.map((memory) => memory.id),
    memWalRecalledBlobIds,
    recalledHandoffBlobIds: handoffRecall.blobIds,
    context,
  };
}

/** Re-fetch + decrypt the agent-handoff blobs embedded in recalled prior
 * memories straight from Walrus. This is what makes the handoffs genuinely
 * consumed (not write-only) and demonstrates Walrus as shared agent state. */
async function recallAgentHandoffs(
  memories: RetrievedMemory[],
  walrus: WalrusClient
): Promise<{ context: OnChainContextMessage[]; blobIds: string[] }> {
  const blobIds: string[] = [];
  const lines: string[] = [];

  for (const memory of memories) {
    for (const handoff of memory.artifact.agentHandoffs ?? []) {
      try {
        const envelope = await walrus.readEnvelope(handoff.walrusBlobId);
        const value = decryptAgentHandoff<unknown>(envelope);
        blobIds.push(handoff.walrusBlobId);
        lines.push(
          `- ${handoff.role} (prior run "${memory.topic}"): ${summarizeHandoff(value)}`
        );
      } catch {
        // A handoff we cannot retrieve/decrypt is skipped, not fatal.
      }
    }
  }

  if (!lines.length) {
    return { context: [], blobIds };
  }

  return {
    context: [
      {
        role: "assistant",
        content: `Prior inter-agent handoffs re-fetched and decrypted from Walrus (shared agent state across runs). Build on this reasoning instead of restarting:\n${lines.join("\n")}`,
      },
    ],
    blobIds,
  };
}

function summarizeHandoff(value: unknown): string {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const handoffs = record.handoffs;

    if (Array.isArray(handoffs)) {
      const roles = handoffs
        .map((handoff) =>
          handoff && typeof handoff === "object"
            ? String((handoff as Record<string, unknown>).role ?? "")
            : ""
        )
        .filter(Boolean)
        .join(", ");

      return `${handoffs.length} prior agent handoff(s) from Walrus${roles ? `: ${roles}` : ""}.`;
    }

    const summary =
      record.summary ??
      record.verificationSummary ??
      record.bundleSummary ??
      record.topTrend;

    if (typeof summary === "string" && summary.trim()) {
      return summary.slice(0, 300);
    }
  }

  return JSON.stringify(value).slice(0, 300);
}

function buildArtifact(input: {
  research: DiscoverPayload;
  ownerAddress: string;
  topic: string;
  runId: string;
  generatedAt: string;
  reusedMemoryIds: string[];
  agentHandoffs?: Array<{ role: string; walrusBlobId: string }>;
}): PrivateMemoryArtifact {
  const { research, ownerAddress, topic, runId, generatedAt, reusedMemoryIds } = input;
  const finalAnswer = research.finalAnswer;
  const finalConclusion = research.finalConclusion;

  return {
    schema: "langclaw.sui-walrus.private-memory.v1",
    runId,
    ownerAddress,
    topic,
    prompt: topic,
    generatedAt,
    reusedMemoryIds,
    memorySummary:
      finalConclusion?.summary || finalAnswer?.answer || `Research on ${topic}.`,
    report: {
      title: finalAnswer?.title || finalConclusion?.headline || topic,
      answer: finalAnswer?.answerMarkdown || finalAnswer?.answer || "",
      bullets: finalAnswer?.bullets ?? [],
      recommendation:
        finalAnswer?.recommendation || finalConclusion?.recommendation || "",
      bottomLine: research.report?.bottomLine,
      keySignals: (finalConclusion?.keySignals ?? []).map((signal) => ({
        label: signal.label,
        text: signal.text,
      })),
      caveats:
        research.report?.caveats ??
        (finalAnswer?.caveat ? [finalAnswer.caveat] : []),
    },
    evidence: {
      sources: (research.sources ?? []).map((source) => ({
        id: source.id,
        title: source.title,
        url: source.url,
        excerpt: source.excerpt,
      })),
      providerTrace: (research.providerTrace ?? []).map((entry) => ({
        provider: entry.provider,
        status: entry.status,
        message: entry.message,
      })),
    },
    agentHandoffs: input.agentHandoffs,
    research: compactResearchForMemory(research),
  };
}

function compactResearchForMemory(research: DiscoverPayload) {
  return {
    schema: "langclaw.research-memory.v1",
    topic: research.topic,
    generatedAt: research.generatedAt,
    chainContext: research.chainContext,
    signals: research.signals,
    sources: compactSources(research.sources),
    errors: compactRecords(research.errors, 10),
    providerTrace: compactRecords(research.providerTrace, 30),
    report: compactReport(research.report),
    onChain: research.onChain
      ? {
          answer: truncateText(research.onChain.answer),
          bullets: research.onChain.bullets?.slice(0, 10).map((bullet) => truncateText(bullet, 500)),
          caveat: truncateText(research.onChain.caveat, 800),
          generatedAt: research.onChain.generatedAt,
          plan: research.onChain.plan,
          providerTrace: compactRecords(research.onChain.providerTrace ?? [], 30),
          recommendation: truncateText(research.onChain.recommendation, 800),
          report: compactReport(research.onChain.report),
          title: research.onChain.title,
          tools: research.onChain.tools.slice(0, 12).map(compactOnChainTool),
        }
      : undefined,
    onChainSkippedReason: research.onChainSkippedReason,
    finalConclusion: research.finalConclusion,
    finalAnswer: research.finalAnswer,
    finalAnswerMeta: research.finalAnswerMeta,
    agentOutputs: compactAgentOutputs(research.agentOutputs),
    proof: compactProof(research.proof ?? research.zeroG),
    alphaSignal: research.alphaSignal,
  };
}

function compactSources(sources: DiscoverPayload["sources"]) {
  return sources.slice(0, 30).map((source) => ({
    ...source,
    excerpt: truncateText(source.excerpt, 1200),
  }));
}

function compactReport(report: DiscoverPayload["report"]) {
  if (!report) {
    return undefined;
  }

  return {
    ...report,
    bottomLine: truncateText(report.bottomLine, 1200),
    caveats: report.caveats?.slice(0, 12).map((caveat) => truncateText(caveat, 800)),
    entities: report.entities?.slice(0, 30).map((entity) => compactJson(entity, 2)),
    executiveSummary: truncateText(report.executiveSummary, 1200),
    recommendations: report.recommendations?.slice(0, 12).map((item) => truncateText(item, 800)),
    sections: report.sections?.slice(0, 12).map((section) => ({
      ...section,
      markdown: truncateText(section.markdown, 2000),
    })),
    tables: report.tables?.slice(0, 12).map((table) => ({
      ...table,
      rows: table.rows.slice(0, 30).map((row) => compactJson(row, 3)),
    })),
  };
}

function compactOnChainTool(tool: NonNullable<DiscoverPayload["onChain"]>["tools"][number]) {
  return {
    attemptedProviders: tool.attemptedProviders,
    commandId: tool.commandId,
    dataSummary: summarizeToolData(tool.data),
    domain: tool.domain,
    error: truncateText(tool.error, 1000),
    fallbackReason: truncateText(tool.fallbackReason, 1000),
    latencyMs: tool.latencyMs,
    provider: tool.provider,
    scope: tool.scope,
    sourceUrl: tool.sourceUrl,
    status: tool.status,
    summary: truncateText(tool.summary, 1200),
    title: tool.title,
  };
}

function compactAgentOutputs(outputs: DiscoverPayload["agentOutputs"]) {
  if (!outputs) {
    return undefined;
  }

  return {
    evidence: outputs.evidence
      ? {
          bundleSummary: truncateText(outputs.evidence.bundleSummary, 1200),
          claimMap: (outputs.evidence.claimMap ?? []).slice(0, 12),
          error: truncateText(outputs.evidence.error, 1000),
          evidenceUri: outputs.evidence.evidenceUri,
          rootHash: outputs.evidence.rootHash,
          storageStatus: outputs.evidence.storageStatus,
          storageTxHash: outputs.evidence.storageTxHash,
        }
      : undefined,
    planner: outputs.planner
      ? {
          providerPlan: (outputs.planner.providerPlan ?? []).slice(0, 12),
          scoringFocus: (outputs.planner.scoringFocus ?? []).slice(0, 12),
          summary: truncateText(outputs.planner.summary, 1200),
        }
      : undefined,
    trend: outputs.trend
      ? {
          rankedTrends: (outputs.trend.rankedTrends ?? []).slice(0, 10),
          score: outputs.trend.score,
          summary: truncateText(outputs.trend.summary, 1200),
          topTrend: truncateText(outputs.trend.topTrend, 1200),
        }
      : undefined,
    verifier: outputs.verifier
      ? {
          briefHashInput: truncateText(outputs.verifier.briefHashInput, 1000),
          chainExplorerUrl: outputs.verifier.chainExplorerUrl,
          chainStatus: outputs.verifier.chainStatus,
          chainTxHash: outputs.verifier.chainTxHash,
          error: truncateText(outputs.verifier.error, 1000),
          storageStatus: outputs.verifier.storageStatus,
          unsupportedClaims: (outputs.verifier.unsupportedClaims ?? []).slice(0, 12),
          verificationSummary: truncateText(outputs.verifier.verificationSummary, 1200),
        }
      : undefined,
  };
}

function compactProof(proof: DiscoverPayload["proof"] | DiscoverPayload["zeroG"]) {
  if (!proof) {
    return undefined;
  }

  return {
    chain: proof.chain,
    compute: proof.compute,
    storage: proof.storage,
  };
}

function compactRecords<T>(records: T[], limit: number) {
  return records.slice(0, limit).map((record) => compactJson(record, 3));
}

function compactJson(value: unknown, depth: number): unknown {
  if (typeof value === "string") {
    return truncateText(value);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  if (depth <= 0) {
    return summarizeToolData(value);
  }

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => compactJson(item, depth - 1));
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 40)
      .map(([key, item]) => [key, compactJson(item, depth - 1)])
  );
}

function summarizeToolData(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (Array.isArray(value)) {
    return `array(${value.length})`;
  }

  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).slice(0, 8);
    return keys.length ? `object keys: ${keys.join(", ")}` : "object";
  }

  return truncateText(String(value), 500);
}

function truncateText(value: string | undefined, maxLength = 1000) {
  if (!value) {
    return value;
  }

  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

async function storeAgentHandoffs(
  research: DiscoverPayload,
  walrus: ReturnType<typeof createWalrusClient>
): Promise<Array<{ role: string; walrusBlobId: string }>> {
  const outputs = research.agentOutputs;

  if (!outputs) {
    return [];
  }

  const handoffs: Array<{ role: string; value: unknown }> = [
    { role: "planner", value: outputs.planner },
    { role: "trend", value: outputs.trend },
    { role: "evidence", value: outputs.evidence },
    { role: "verifier", value: outputs.verifier },
  ].filter((handoff) => handoff.value !== undefined);

  if (!handoffs.length) {
    return [];
  }

  const envelope = encryptAgentHandoff({
    schema: "langclaw.agent-handoff-bundle.v1",
    createdAt: research.generatedAt || new Date().toISOString(),
    handoffs,
  });
  const stored = await walrus.storeEnvelope(envelope);

  return [{ role: "agent-pipeline", walrusBlobId: stored.walrusBlobId }];
}

function buildTags(topic: string): string[] {
  return Array.from(
    new Set(
      topic
        .toLowerCase()
        .split(/[^a-z0-9]+/g)
        .filter((token) => token.length > 3)
    )
  ).slice(0, 8);
}

async function emitMemoryProgress(
  input: RunPrivateMemoryInput,
  status: WorkflowProgressEvent["status"],
  summary: string
) {
  if (!input.onEvent) {
    return;
  }

  const timestamp = new Date().toISOString();

  await input.onEvent({
    ...privateMemoryStep,
    status,
    summary,
    timestamp,
    startedAt: status === "running" ? timestamp : undefined,
    completedAt:
      status === "complete" || status === "failed" ? timestamp : undefined,
    execution: "evidence-bundle",
  });
}

function getPrivateMemoryOperationTimeoutMs() {
  const parsed = Number(process.env.PRIVATE_MEMORY_OPERATION_TIMEOUT_MS);

  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 60_000;
}

function getPrivateMemoryStorageTimeoutMs() {
  const parsed = Number(process.env.PRIVATE_MEMORY_STORAGE_TIMEOUT_MS);

  return Number.isFinite(parsed) && parsed >= 1
    ? Math.floor(parsed)
    : getPrivateMemoryOperationTimeoutMs();
}

function getPrivateMemoryAncillaryTimeoutMs() {
  const parsed = Number(process.env.PRIVATE_MEMORY_ANCILLARY_TIMEOUT_MS);

  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 15_000;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function readErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function joinReasons(current: string | undefined, next: string) {
  return current ? `${current} ${next}` : next;
}

function dedupeById<T extends { id: string }>(records: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];

  for (const record of records) {
    if (!seen.has(record.id)) {
      seen.add(record.id);
      result.push(record);
    }
  }

  return result;
}

/** Store -> read-back -> hash-compare. Proves the blob is actually retrievable
 * from Walrus and byte-stable, without needing to decrypt it (works in both
 * Seal-SDK and local-envelope modes since it hashes the encrypted envelope). */
async function verifyWalrusRoundTrip(
  walrus: WalrusClient,
  blobId: string,
  stored: SealEnvelope
): Promise<{ retrievalStatus: WalrusRetrievalStatus; hashVerified: boolean }> {
  try {
    const refetched = await walrus.readEnvelope(blobId);
    const hashVerified =
      hashContent(stableStringify(refetched)) === hashContent(stableStringify(stored));

    return { retrievalStatus: "retrieved", hashVerified };
  } catch {
    // A blob we cannot read back is reported honestly as not retrieved, not fatal.
    return { retrievalStatus: "failed", hashVerified: false };
  }
}

function resolveSuiNetwork(): SuiNetwork {
  const network = process.env.SUI_NETWORK?.trim();

  return network === "mainnet" || network === "devnet" || network === "localnet"
    ? network
    : "mainnet";
}

function suiExplorerBase(): string {
  const override = process.env.SUI_EXPLORER_URL?.trim();

  // Only honor an https override; otherwise fall back to the network default so a
  // malformed/unsafe value can never produce a non-https explorer link.
  if (override) {
    try {
      if (new URL(override).protocol === "https:") {
        return override.replace(/\/+$/, "");
      }
    } catch {
      // fall through to the default
    }
  }

  return resolveSuiNetwork() === "mainnet"
    ? "https://suivision.xyz"
    : DEFAULT_SUI_EXPLORER_URL;
}

function buildSuiTxUrl(digest: string): string {
  return `${suiExplorerBase()}/txblock/${encodeURIComponent(digest)}`;
}

// Re-exported for status/readiness wiring in later phases.
export { getSealPolicyId };
