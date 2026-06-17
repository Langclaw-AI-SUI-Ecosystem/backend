import {
  DEFAULT_SUI_RPC_URL,
  createSuiClient,
  loadSuiRuntime,
  parseSuiPrivateKey,
  type SuiReadClient,
} from "./sui-onchain";

import {
  getProductChain,
  readChainEnv,
  readProductChainId,
  type ProductChainConfig,
  type ProductChainId,
} from "./chain-config";

type ReadinessCheckStatus = "pass" | "warn" | "fail";

export type ProofReadinessCheck = {
  detail?: Record<string, unknown>;
  id: string;
  label: string;
  status: ReadinessCheckStatus;
  summary: string;
};

export type ProofReadinessReport = {
  chain: ProductChainId;
  chainId: number;
  chainName: string;
  checks: ProofReadinessCheck[];
  latestDecision?: {
    agentId: string;
    createdAt: string;
    decisionHash: string;
    decisionId: string;
    evidenceUri: string;
    recorder: string;
    runId: string;
    signalType: string;
  };
  nativeSymbol: string;
  ready: boolean;
  recorder?: {
    address: string;
    balance: string;
    balanceWei: string;
  };
  registryAddress?: string;
  rpcUrl: string;
  status: "ready" | "warning" | "not_ready";
};

/**
 * Read-only diagnostics surface over a Sui fullnode. Mirrors the subset of
 * `SuiReadClient` (from `sui-onchain.ts`) this report needs: liveness via
 * `getChainIdentifier`, recorder gas via `getBalance`, and the latest recorded
 * decision via `queryEvents`. Injectable so tests can pass a mock.
 */
type ProofReadinessClient = Pick<
  SuiReadClient,
  "getChainIdentifier" | "getBalance" | "queryEvents"
>;

type ProofReadinessOptions = {
  chain?: unknown;
  publicClient?: ProofReadinessClient;
  /**
   * Optional override for the recorder (Sui) address. When omitted it is derived
   * from the configured private key via the Ed25519 keypair. Tests can inject a
   * fixed address to keep the balance check offline and deterministic.
   */
  recorderAddress?: string;
};

const MIST_PER_SUI = 1_000_000_000n;

export async function buildProofReadinessReport({
  chain: chainInput,
  publicClient,
  recorderAddress: recorderAddressOverride,
}: ProofReadinessOptions = {}): Promise<ProofReadinessReport> {
  const chain = getProductChain(readProductChainId(chainInput));
  const chainId = chain.chainId;
  const rpcUrl =
    readChainEnv(chain, "CHAIN_RPC_URL", chain.rpcUrl) ||
    chain.rpcUrl ||
    DEFAULT_SUI_RPC_URL;
  const checks: ProofReadinessCheck[] = [];
  const chainEnabled = readChainEnv(chain, "CHAIN_ENABLED") === "true";
  const proofEnabled = readChainEnv(chain, "INTEL_PROOF_ENABLED") === "true";
  const privateKey = readProofPrivateKey(chain);
  const agentId = readProofAgentId(chain);
  const registryPackageId = readProofRegistryPackageId(chain);
  let recorder: ProofReadinessReport["recorder"];
  let latestDecision: ProofReadinessReport["latestDecision"];

  addCheck(checks, {
    id: "chain-enabled",
    label: `${chain.envPrefix}_CHAIN_ENABLED`,
    status: chainEnabled ? "pass" : "fail",
    summary: chainEnabled
      ? `${chain.envPrefix}_CHAIN_ENABLED is true.`
      : `Set ${chain.envPrefix}_CHAIN_ENABLED=true so proof writes can anchor on ${chain.name}.`,
  });

  addCheck(checks, {
    id: "onchain-tool-proof-enabled",
    label: `${chain.envPrefix}_INTEL_PROOF_ENABLED`,
    status: proofEnabled ? "pass" : "warn",
    summary: proofEnabled
      ? `${chain.envPrefix}_INTEL_PROOF_ENABLED is true for direct on-chain tool proof payloads.`
      : `Set ${chain.envPrefix}_INTEL_PROOF_ENABLED=true if the demo uses direct on-chain tool mode. Langclaw workflow proof still uses ${chain.envPrefix}_CHAIN_ENABLED.`,
  });

  addCheck(checks, {
    id: "agent-private-key",
    label: `${chain.envPrefix}_AGENT_PRIVATE_KEY`,
    status: privateKey ? "pass" : "fail",
    summary: privateKey
      ? "Agent private key is present and has a valid key shape."
      : `Set ${chain.envPrefix}_AGENT_PRIVATE_KEY or ${chain.envPrefix}_PRIVATE_KEY with the proof recorder key.`,
  });

  addCheck(checks, {
    id: "agent-id",
    label: `${chain.envPrefix}_AGENT_ID`,
    status: agentId > 0n ? "pass" : "fail",
    summary: agentId > 0n
      ? `Agent ID ${agentId.toString()} is configured.`
      : `Set ${chain.envPrefix}_AGENT_ID to the Sui agent id. Legacy ${chain.envPrefix}_ERC8004_AGENT_ID is still accepted for old env files.`,
  });

  addCheck(checks, {
    id: "registry-address",
    label: `${chain.envPrefix}_LANGCLAW_REGISTRY_PACKAGE_ID`,
    status: registryPackageId ? "pass" : "fail",
    summary: registryPackageId
      ? "LangclawRegistry package id is configured."
      : `Set ${chain.envPrefix}_LANGCLAW_REGISTRY_PACKAGE_ID to the published langclaw_memory package id.`,
    detail: registryPackageId ? { registryPackageId } : undefined,
  });

  addCheck(checks, {
    id: "rpc-url",
    label: `${chain.envPrefix}_CHAIN_RPC_URL`,
    status: rpcUrl ? "pass" : "fail",
    summary: rpcUrl
      ? `${chain.name} RPC URL is configured.`
      : `Set ${chain.envPrefix}_CHAIN_RPC_URL.`,
    detail: rpcUrl ? { rpcUrl } : undefined,
  });

  const recorderAddress =
    recorderAddressOverride ??
    (privateKey ? await deriveRecorderAddress(privateKey) : undefined);

  if (rpcUrl) {
    const client =
      publicClient ?? (await createReadinessClient(chain, rpcUrl));

    await checkRpc({
      chain,
      checks,
      client,
    });

    if (recorderAddress) {
      recorder = await checkRecorderBalance({
        accountAddress: recorderAddress,
        chain,
        checks,
        client,
      });
    }

    if (registryPackageId) {
      latestDecision = await checkRegistry({
        agentId,
        chain,
        checks,
        client,
        registryPackageId,
      });
    }
  }

  const status = summarizeStatus(checks);

  return {
    chain: chain.id,
    chainId,
    chainName: chain.name,
    checks,
    latestDecision,
    nativeSymbol: chain.nativeCurrency.symbol,
    ready: status !== "not_ready",
    recorder,
    registryAddress: registryPackageId || undefined,
    rpcUrl,
    status,
  };
}

async function createReadinessClient(
  chain: ProductChainConfig,
  rpcUrl: string
): Promise<ProofReadinessClient> {
  return createSuiClient(rpcUrl, chain.suiNetwork);
}

async function deriveRecorderAddress(
  privateKey: string
): Promise<string | undefined> {
  try {
    const runtime = await loadSuiRuntime();
    const keypair = runtime.keypairs.Ed25519Keypair.fromSecretKey(
      parseSuiPrivateKey(privateKey)
    ) as {
      getPublicKey(): { toSuiAddress(): string };
    };

    return keypair.getPublicKey().toSuiAddress();
  } catch {
    return undefined;
  }
}

async function checkRpc({
  chain,
  checks,
  client,
}: {
  chain: ProductChainConfig;
  checks: ProofReadinessCheck[];
  client: ProofReadinessClient;
}) {
  try {
    const chainIdentifier = await client.getChainIdentifier();

    addCheck(checks, {
      id: "rpc-chain-id",
      label: "RPC chain identifier",
      status: chainIdentifier ? "pass" : "fail",
      summary: chainIdentifier
        ? `RPC is live on ${chain.name} (chain identifier ${chainIdentifier}).`
        : `RPC returned an empty ${chain.name} chain identifier.`,
      detail: {
        chainIdentifier,
      },
    });
  } catch (error) {
    addCheck(checks, {
      id: "rpc-chain-id",
      label: "RPC chain identifier",
      status: "fail",
      summary: `Unable to read ${chain.name} RPC chain identifier: ${readError(error)}`,
    });
  }
}

async function checkRecorderBalance({
  accountAddress,
  chain,
  checks,
  client,
}: {
  accountAddress: string;
  chain: ProductChainConfig;
  checks: ProofReadinessCheck[];
  client: ProofReadinessClient;
}) {
  try {
    const result = await client.getBalance({ owner: accountAddress });
    const balanceMist = BigInt(result.totalBalance ?? "0");
    const formatted = `${formatSui(balanceMist)} ${chain.nativeCurrency.symbol}`;

    addCheck(checks, {
      id: "recorder-balance",
      label: "Recorder gas balance",
      status: balanceMist > 0n ? "pass" : "fail",
      summary: balanceMist > 0n
        ? `Recorder ${accountAddress} has ${formatted}.`
        : `Recorder ${accountAddress} has 0 ${chain.nativeCurrency.symbol}; fund it before recording proof.`,
      detail: {
        address: accountAddress,
        balance: formatted,
        balanceMist: balanceMist.toString(),
      },
    });

    return {
      address: accountAddress,
      balance: formatted,
      balanceWei: balanceMist.toString(),
    };
  } catch (error) {
    addCheck(checks, {
      id: "recorder-balance",
      label: "Recorder gas balance",
      status: "fail",
      summary: `Unable to read recorder gas balance: ${readError(error)}`,
      detail: {
        address: accountAddress,
      },
    });
  }
}

async function checkRegistry({
  agentId,
  chain,
  checks,
  client,
  registryPackageId,
}: {
  agentId: bigint;
  chain: ProductChainConfig;
  checks: ProofReadinessCheck[];
  client: ProofReadinessClient;
  registryPackageId: string;
}) {
  const eventType = `${registryPackageId}::decision_registry::DecisionRecorded`;

  try {
    const result = await client.queryEvents({
      query: { MoveEventType: eventType },
      limit: 1,
      order: "descending",
    });
    const latestEvent = result.data?.[0];

    addCheck(checks, {
      id: "registry-readable",
      label: "LangclawRegistry readable",
      status: "pass",
      summary: latestEvent
        ? "LangclawRegistry decision events are queryable on Sui."
        : "LangclawRegistry is queryable but has no recorded decision events yet.",
      detail: {
        eventType,
        registryPackageId,
      },
    });

    if (!latestEvent) {
      addCheck(checks, {
        id: "latest-decision",
        label: "Latest proof decision",
        status: "warn",
        summary: "Registry has no recorded decisions yet. Record one before the final demo if you need proof history.",
      });
      return undefined;
    }

    const decision = normalizeDecision(latestEvent.parsedJson);
    const latestDecision = {
      agentId: decision.agentId.toString(),
      createdAt: decision.createdAt,
      decisionHash: decision.decisionHash,
      decisionId: decision.runId,
      evidenceUri: decision.evidenceUri,
      recorder: decision.recorder,
      runId: decision.runId,
      signalType: decision.signalType,
    };
    const matchesAgent = agentId === 0n || decision.agentId === agentId;

    addCheck(checks, {
      id: "latest-decision",
      label: "Latest proof decision",
      status: matchesAgent ? "pass" : "warn",
      summary: matchesAgent
        ? `Latest decision ${latestDecision.decisionId} belongs to configured agent ${decision.agentId.toString()}.`
        : `Latest decision ${latestDecision.decisionId} belongs to agent ${decision.agentId.toString()}, not configured agent ${agentId.toString()}.`,
      detail: latestDecision,
    });

    return latestDecision;
  } catch (error) {
    addCheck(checks, {
      id: "registry-readable",
      label: "LangclawRegistry readable",
      status: "fail",
      summary: `Unable to read LangclawRegistry on ${chain.name}: ${readError(error)}`,
      detail: {
        eventType,
        registryPackageId,
      },
    });
  }
}

function normalizeDecision(value: unknown) {
  const decision =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};

  return {
    agentId: parseAgentId(decision.agent_id),
    createdAt: String(decision.created_at ?? ""),
    decisionHash: String(decision.decision_hash ?? ""),
    evidenceUri: String(decision.evidence_uri ?? ""),
    recorder: String(decision.recorder ?? ""),
    runId: String(decision.run_id ?? ""),
    signalType: String(decision.signal_type ?? ""),
  };
}

function parseAgentId(value: unknown): bigint {
  const raw = String(value ?? "0");

  return /^\d+$/.test(raw) ? BigInt(raw) : 0n;
}

function formatSui(mist: bigint): string {
  const whole = mist / MIST_PER_SUI;
  const fraction = mist % MIST_PER_SUI;

  if (fraction === 0n) {
    return whole.toString();
  }

  const fractionStr = fraction
    .toString()
    .padStart(9, "0")
    .replace(/0+$/, "");

  return `${whole.toString()}.${fractionStr}`;
}

function readProofPrivateKey(chain: ProductChainConfig): string | undefined {
  const raw =
    readChainEnv(chain, "AGENT_PRIVATE_KEY") ||
    readChainEnv(chain, "PRIVATE_KEY");

  if (!raw) {
    return undefined;
  }

  const trimmed = raw.trim();

  if (trimmed.startsWith("suiprivkey")) {
    return trimmed;
  }

  const prefixed = trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;

  return /^0x[a-fA-F0-9]{64}$/.test(prefixed) ? prefixed : undefined;
}

function readProofAgentId(chain: ProductChainConfig) {
  const raw =
    readChainEnv(chain, "AGENT_ID") ||
    readChainEnv(chain, "SELF_AGENT_ID") ||
    readChainEnv(chain, "ERC8004_AGENT_ID") ||
    process.env.LANGCLAW_AGENT_ID?.trim() ||
    "0";

  return /^\d+$/.test(raw) ? BigInt(raw) : 0n;
}

function readProofRegistryPackageId(chain: ProductChainConfig) {
  return (
    readChainEnv(chain, "LANGCLAW_REGISTRY_PACKAGE_ID") ||
    readChainEnv(chain, "LANGCLAW_PACKAGE_ID") ||
    ""
  );
}

function addCheck(checks: ProofReadinessCheck[], check: ProofReadinessCheck) {
  checks.push(check);
}

function summarizeStatus(checks: ProofReadinessCheck[]) {
  if (checks.some((check) => check.status === "fail")) {
    return "not_ready" as const;
  }

  if (checks.some((check) => check.status === "warn")) {
    return "warning" as const;
  }

  return "ready" as const;
}

function readError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
