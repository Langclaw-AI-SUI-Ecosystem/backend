import { keccak256, toBytes, type Hex } from "viem";

import {
  defaultProductChain,
  getProductChain,
  readChainEnv,
  resolveProductChain,
  type ProductChainId,
  type ProductChainConfig,
} from "../chain-config";
import {
  DEFAULT_SUI_RPC_URL,
  DEFAULT_SUI_EXPLORER_URL,
  submitMoveCall,
  readSuiNumber,
  type SuiTransaction,
} from "../sui-onchain";
import { sanitizeError } from "./openclaw-runner";
import type {
  AgentOutputs,
  DiscoverSignals,
  FinalAnswer,
  FinalConclusion,
  OrchestrationStep,
  ProviderError,
  ResearchReport,
  SourceCard,
  WorkflowChainContext,
  AlphaSignal,
  ZeroGChainProof,
  ZeroGProof,
  ZeroGStorageProof,
} from "./types";

type PersistProofInput = {
  chain?: ProductChainId;
  runId: string;
  topic: string;
  generatedAt: string;
  chainContext: WorkflowChainContext;
  sources: SourceCard[];
  errors: ProviderError[];
  steps: OrchestrationStep[];
  signals: DiscoverSignals;
  report?: ResearchReport;
  finalConclusion: FinalConclusion;
  finalAnswer: FinalAnswer;
  agentOutputs: AgentOutputs;
  alphaSignal?: AlphaSignal;
};

type PersistGenericProductProofInput = {
  chain?: ProductChainId;
  evidence: Record<string, unknown>;
  generatedAt: string;
  runId: string;
  signalType?: string;
  topic: string;
};

const defaultReceiptPollAttempts = 12;
const defaultReceiptPollIntervalMs = 5000;

const defaultRegistryModule = "decision_registry";
const defaultRegistryFunction = "record_agent_decision";
const defaultSuiProofGasBudget = 100_000_000;

export async function persistLangclawProof(
  input: PersistProofInput
): Promise<ZeroGProof> {
  const chainConfig = resolveProductChain(input.chain);
  const evidenceBundle = buildEvidenceBundle(input);
  const canonicalBundle = stableStringify(evidenceBundle);
  const decisionHash = keccak256(toBytes(canonicalBundle));
  const storage = prepareEvidenceBundle({
    decisionHash,
    runId: input.runId,
  });
  const chainProof = await anchorAgentDecision({
    chain: chainConfig.id,
    decisionHash,
    evidenceUri: storage.evidenceUri,
    runId: input.runId,
    signalType: inferSignalType(input.topic, chainConfig),
  });

  return {
    storage,
    chain: chainProof,
  };
}

export async function persistGenericProductProof({
  chain: chainInput = defaultProductChain,
  evidence,
  generatedAt,
  runId,
  signalType,
  topic,
}: PersistGenericProductProofInput): Promise<ZeroGProof> {
  const chainConfig = resolveProductChain(chainInput);
  const evidenceBundle = {
    schema: "langclaw.onchain-tools.evidence.v1",
    runId,
    topic,
    generatedAt,
    ...evidence,
  };
  const canonicalBundle = stableStringify(evidenceBundle);
  const decisionHash = keccak256(toBytes(canonicalBundle));
  const storage = prepareEvidenceBundle({
    decisionHash,
    runId,
  });
  const chainProof = await anchorAgentDecision({
    chain: chainConfig.id,
    decisionHash,
    evidenceUri: storage.evidenceUri,
    runId,
    signalType: signalType || inferSignalType(topic, chainConfig),
  });

  return {
    storage,
    chain: chainProof,
  };
}

function buildEvidenceBundle(input: PersistProofInput) {
  return {
    schema: "langclaw.evidence.v1",
    runId: input.runId,
    topic: input.topic,
    generatedAt: input.generatedAt,
    chainContext: input.chainContext,
    sources: input.sources,
    providerErrors: input.errors,
    orchestrationSteps: input.steps,
    signals: input.signals,
    report: input.report,
    alphaSignal: input.alphaSignal,
    agentOutputs: input.agentOutputs,
    finalConclusion: input.finalConclusion,
    finalAnswer: input.finalAnswer,
  };
}

function prepareEvidenceBundle({
  decisionHash,
  runId,
}: {
  decisionHash: Hex;
  runId: string;
}): ZeroGStorageProof {
  const baseUri =
    process.env.LANGCLAW_EVIDENCE_BASE_URI?.trim() || "langclaw://evidence";
  const evidenceUri = `${trimSlash(baseUri)}/${encodeURIComponent(runId)}/${decisionHash}`;

  return {
    status: "prepared",
    evidenceUri,
    rootHash: decisionHash,
  };
}

async function anchorAgentDecision({
  chain,
  decisionHash,
  evidenceUri,
  runId,
  signalType,
}: {
  chain: ProductChainId;
  decisionHash: Hex;
  evidenceUri: string;
  runId: string;
  signalType: string;
}): Promise<ZeroGChainProof> {
  const chainConfig = getProductChain(chain);
  const rpcUrl =
    readChainEnv(chainConfig, "CHAIN_RPC_URL", chainConfig.rpcUrl) ||
    DEFAULT_SUI_RPC_URL;
  const network = chainConfig.suiNetwork;
  const chainId = readChainId(chainConfig);
  const explorerBase = trimSlash(
    readChainEnv(chainConfig, "CHAIN_EXPLORER_URL", chainConfig.explorerUrl) ||
      chainConfig.explorerUrl ||
      DEFAULT_SUI_EXPLORER_URL
  );
  const privateKey = readPrivateKey(chainConfig);
  const packageId = readRegistryPackageId(chainConfig);
  const registryModule =
    readChainEnv(chainConfig, "LANGCLAW_REGISTRY_MODULE") ||
    defaultRegistryModule;
  const registryFunction =
    readChainEnv(chainConfig, "LANGCLAW_REGISTRY_FUNCTION") ||
    defaultRegistryFunction;
  const gasBudget = readSuiNumber(
    readChainEnv(chainConfig, "CHAIN_GAS_BUDGET"),
    defaultSuiProofGasBudget
  );
  const agentId = readAgentId(chainConfig);
  const chainEnabled =
    readChainEnv(chainConfig, "CHAIN_ENABLED") === "true" ||
    readChainEnv(chainConfig, "INTEL_PROOF_ENABLED") === "true";

  const baseProof: ZeroGChainProof = {
    status: "prepared",
    briefHash: decisionHash,
    chain: chainConfig.id,
    decisionHash,
    agentId: agentId.toString(),
    signalType,
    chainId,
    chainName: chainConfig.name,
    nativeSymbol: chainConfig.nativeCurrency.symbol,
    registryAddress: packageId,
  };

  if (!chainEnabled) {
    return {
      ...baseProof,
      error: `${chainConfig.envPrefix}_CHAIN_ENABLED is not true.`,
    };
  }

  if (!privateKey) {
    return {
      ...baseProof,
      error: `Set ${chainConfig.envPrefix}_AGENT_PRIVATE_KEY to record the agent decision.`,
    };
  }

  if (!packageId) {
    return {
      ...baseProof,
      error: `Set ${chainConfig.envPrefix}_LANGCLAW_REGISTRY_PACKAGE_ID to the deployed langclaw_memory Move package id.`,
    };
  }

  const target = `${packageId}::${registryModule}::${registryFunction}`;
  const submission = await submitMoveCall({
    rpcUrl,
    network,
    privateKey,
    gasBudget,
    target,
    buildArgs: (tx: SuiTransaction) => [
      tx.pure.u64(BigInt(agentId)),
      tx.pure.string(runId),
      tx.pure.string(decisionHash),
      tx.pure.string(evidenceUri),
      tx.pure.string(signalType),
    ],
  });

  if (submission.status !== "ok" || !submission.digest) {
    return {
      ...baseProof,
      status: "failed",
      error: sanitizeError(
        submission.reason ||
          `${chainConfig.name} decision proof Move call failed.`
      ),
    };
  }

  const explorerUrl = `${explorerBase}/txblock/${submission.digest}`;

  return {
    ...baseProof,
    status: "anchored",
    txHash: submission.digest,
    explorerUrl,
  };
}

/**
 * ERC-8004 reputation has no Sui analog. Kept as an explicit, honest stub so the
 * proof surface advertises why on-chain reputation feedback is unavailable here.
 */
export function recordErc8004ReputationFeedback() {
  return {
    status: "skipped" as const,
    reason: "ERC-8004 reputation is not available on Sui.",
  };
}

type ReceiptPollingClient = {
  getTransactionReceipt: (args: {
    hash: Hex;
  }) => Promise<{ status: "success" | "reverted" } | null | undefined>;
};

export async function waitForSubmittedTransactionReceipt({
  publicClient,
  txHash,
  attempts = readPositiveInt(
    process.env.SUI_CHAIN_RECEIPT_POLL_ATTEMPTS,
    defaultReceiptPollAttempts
  ),
  intervalMs = readPositiveInt(
    process.env.SUI_CHAIN_RECEIPT_POLL_INTERVAL_MS,
    defaultReceiptPollIntervalMs
  ),
}: {
  publicClient: ReceiptPollingClient;
  txHash: Hex;
  attempts?: number;
  intervalMs?: number;
}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash: txHash });

      if (receipt) {
        return receipt;
      }
    } catch (error) {
      if (!isTransactionReceiptMissingError(error)) {
        throw error;
      }
    }

    if (attempt < attempts) {
      await sleep(intervalMs);
    }
  }

  return undefined;
}

function readPrivateKey(chain: ProductChainConfig): string | undefined {
  const raw =
    readChainEnv(chain, "AGENT_PRIVATE_KEY") ||
    readChainEnv(chain, "PRIVATE_KEY");
  const cleaned = raw?.trim();

  return cleaned || undefined;
}

function readChainId(chain: ProductChainConfig) {
  const parsed = Number.parseInt(
    readChainEnv(chain, "CHAIN_ID", String(chain.chainId)) || "",
    10
  );

  return Number.isFinite(parsed) && parsed > 0 ? parsed : chain.chainId;
}

function readAgentId(chain: ProductChainConfig) {
  const raw =
    readChainEnv(chain, "AGENT_ID") ||
    readChainEnv(chain, "SELF_AGENT_ID") ||
    readChainEnv(chain, "ERC8004_AGENT_ID") ||
    process.env.LANGCLAW_AGENT_ID?.trim() ||
    "0";

  if (!/^\d+$/.test(raw)) {
    return 0n;
  }

  return BigInt(raw);
}

function inferSignalType(topic: string, chain = getProductChain(defaultProductChain)) {
  if (/\b(smart[-\s]money|whale|accumulat\w*|holder|flow)\b/i.test(topic)) {
    return "smart-money";
  }

  if (/\b(liquidity|volume|pool|pair|anomal)\b/i.test(topic)) {
    return "liquidity-anomaly";
  }

  if (/\b(tvl|yield|apy|protocol|defi)\b/i.test(topic)) {
    return "tvl-yield-momentum";
  }

  if (/\b(signal|trade|trading|entry|exit|alpha)\b/i.test(topic)) {
    return "alpha-signal";
  }

  return chain.proofSignalFallback;
}

function readRegistryPackageId(chain: ProductChainConfig) {
  return readChainEnv(chain, "LANGCLAW_REGISTRY_PACKAGE_ID") || "";
}

function readPositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? "", 10);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isTransactionReceiptMissingError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);

  return (
    message.includes("Transaction receipt with hash") &&
    message.includes("could not be found")
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trimSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value), null, 2);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;

    return Object.keys(record)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        const item = record[key];

        if (item !== undefined) {
          acc[key] = sortJson(item);
        }

        return acc;
      }, {});
  }

  return value;
}
