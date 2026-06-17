import type { MemoryIndexRecord, PrivateMemoryArtifact } from "./memory-types";

export type MemWalIntegrationStatus = {
  enabled: boolean;
  configured: boolean;
  status: "disabled" | "ready" | "missing_config";
  serverUrl: string;
  namespace: string;
  allowPrivateSummary: boolean;
  missing: string[];
};

export type MemWalRememberResult = {
  status: "remembered" | "skipped" | "failed";
  jobId?: string;
  blobId?: string;
  reason?: string;
};

export type MemWalRecalledMemory = {
  text: string;
  distance: number;
  blobId?: string;
};

export type MemWalRecallResult = {
  status: "recalled" | "skipped" | "failed";
  blobIds: string[];
  memories: MemWalRecalledMemory[];
  reason?: string;
};

export type MemWalAdapter = {
  getStatus(): MemWalIntegrationStatus;
  recall(topic: string): Promise<MemWalRecallResult>;
  remember(
    record: MemoryIndexRecord,
    artifact: PrivateMemoryArtifact
  ): Promise<MemWalRememberResult>;
};

type MemWalRuntimeClient = {
  recall(input: {
    query: string;
    topK?: number;
    maxDistance?: number;
    namespace?: string;
  }): Promise<{ results?: Array<{ blob_id?: string; text?: string; distance?: number }> }>;
  rememberAndWait(
    text: string,
    namespace?: string,
    opts?: { timeoutMs?: number }
  ): Promise<{ id?: string; job_id?: string; blob_id?: string }>;
  destroy?: () => void;
};

type MemWalRuntime = {
  MemWal: {
    create(config: {
      key: string;
      accountId: string;
      serverUrl?: string;
      namespace?: string;
    }): MemWalRuntimeClient;
  };
};

export function createMemWalAdapter(ownerAddress?: string): MemWalAdapter {
  const config = readMemWalConfig(ownerAddress);

  if (!config.enabled) {
    return new DisabledMemWalAdapter(config);
  }

  if (!config.configured) {
    return new MissingConfigMemWalAdapter(config);
  }

  return new SdkMemWalAdapter(config);
}

export function getMemWalIntegrationStatus(): MemWalIntegrationStatus {
  return readMemWalConfig().status;
}

class DisabledMemWalAdapter implements MemWalAdapter {
  constructor(private readonly config: MemWalConfig) {}

  getStatus() {
    return this.config.status;
  }

  async recall(): Promise<MemWalRecallResult> {
    return { status: "skipped", blobIds: [], memories: [], reason: "MemWal is disabled." };
  }

  async remember(): Promise<MemWalRememberResult> {
    return { status: "skipped", reason: "MemWal is disabled." };
  }
}

class MissingConfigMemWalAdapter implements MemWalAdapter {
  constructor(private readonly config: MemWalConfig) {}

  getStatus() {
    return this.config.status;
  }

  async recall(): Promise<MemWalRecallResult> {
    return {
      status: "failed",
      blobIds: [],
      memories: [],
      reason: `MemWal is enabled but missing ${this.config.status.missing.join(", ")}.`,
    };
  }

  async remember(): Promise<MemWalRememberResult> {
    return {
      status: "failed",
      reason: `MemWal is enabled but missing ${this.config.status.missing.join(", ")}.`,
    };
  }
}

class SdkMemWalAdapter implements MemWalAdapter {
  constructor(private readonly config: MemWalConfig) {}

  getStatus() {
    return this.config.status;
  }

  async recall(topic: string): Promise<MemWalRecallResult> {
    const client = await this.createClient();

    try {
      const result = await client.recall({
        query: topic,
        topK: this.config.topK,
        maxDistance: this.config.maxDistance,
        namespace: this.config.namespace,
      });
      const results = result.results ?? [];

      return {
        status: "recalled",
        blobIds: results
          .map((memory) => memory.blob_id)
          .filter((blobId): blobId is string => Boolean(blobId)),
        memories: results.map((memory) => ({
          text: memory.text ?? "",
          distance: memory.distance ?? 0,
          blobId: memory.blob_id,
        })),
      };
    } catch (error) {
      return {
        status: "failed",
        blobIds: [],
        memories: [],
        reason: error instanceof Error ? error.message : "MemWal recall failed.",
      };
    } finally {
      client.destroy?.();
    }
  }

  async remember(
    record: MemoryIndexRecord,
    artifact: PrivateMemoryArtifact
  ): Promise<MemWalRememberResult> {
    const client = await this.createClient();

    try {
      const result = await client.rememberAndWait(
        buildMemWalText(record, artifact, this.config.allowPrivateSummary),
        this.config.namespace,
        { timeoutMs: this.config.timeoutMs }
      );

      return {
        status: "remembered",
        jobId: result.job_id ?? result.id,
        blobId: result.blob_id,
      };
    } catch (error) {
      return {
        status: "failed",
        reason: error instanceof Error ? error.message : "MemWal remember failed.",
      };
    } finally {
      client.destroy?.();
    }
  }

  private async createClient() {
    const runtime = (await import("@mysten-incubation/memwal")) as MemWalRuntime;

    return runtime.MemWal.create({
      key: this.config.privateKey,
      accountId: this.config.accountId,
      serverUrl: this.config.serverUrl,
      namespace: this.config.namespace,
    });
  }
}

type MemWalConfig = {
  enabled: boolean;
  configured: boolean;
  privateKey: string;
  accountId: string;
  serverUrl: string;
  namespace: string;
  allowPrivateSummary: boolean;
  timeoutMs: number;
  topK: number;
  maxDistance?: number;
  status: MemWalIntegrationStatus;
};

function readMemWalConfig(ownerAddress?: string): MemWalConfig {
  const enabled = readBoolean(process.env.MEMWAL_ENABLED, false);
  const privateKey = cleanEnv(process.env.MEMWAL_PRIVATE_KEY);
  const accountId = cleanEnv(process.env.MEMWAL_ACCOUNT_ID);
  const missing = [];

  if (!privateKey) {
    missing.push("MEMWAL_PRIVATE_KEY");
  }

  if (!accountId) {
    missing.push("MEMWAL_ACCOUNT_ID");
  }

  const configured = enabled && missing.length === 0;
  const serverUrl =
    cleanEnv(process.env.MEMWAL_SERVER_URL) ||
    cleanEnv(process.env.MEMWAL_RELAYER_URL) ||
    // Production (mainnet) relayer; testnet uses https://relayer-staging.memory.walrus.xyz
    "https://relayer.memory.walrus.xyz";
  // Scope memories per owner so one wallet's recall never searches another
  // wallet's pointers in the shared MemWal account.
  const baseNamespace = cleanEnv(process.env.MEMWAL_NAMESPACE) || "langclaw-private-memory";
  const namespace = ownerAddress
    ? `${baseNamespace}:${ownerAddress.trim().toLowerCase()}`
    : baseNamespace;
  const allowPrivateSummary = readBoolean(process.env.MEMWAL_ALLOW_PRIVATE_SUMMARY, false);

  return {
    enabled,
    configured,
    privateKey: privateKey || "",
    accountId: accountId || "",
    serverUrl,
    namespace,
    allowPrivateSummary,
    timeoutMs: readNumber(process.env.MEMWAL_TIMEOUT_MS, 30_000),
    topK: readNumber(process.env.MEMWAL_TOP_K, 5),
    maxDistance: readOptionalNumber(process.env.MEMWAL_MAX_DISTANCE),
    status: {
      enabled,
      configured,
      status: !enabled ? "disabled" : configured ? "ready" : "missing_config",
      serverUrl,
      namespace,
      allowPrivateSummary,
      missing: enabled ? missing : [],
    },
  };
}

function buildMemWalText(
  record: MemoryIndexRecord,
  artifact: PrivateMemoryArtifact,
  allowPrivateSummary: boolean
) {
  const lines = [
    "Langclaw private memory pointer.",
    `topic: ${record.topic}`,
    `contentHash: ${record.contentHash}`,
    `walrusBlobId: ${record.walrusBlobId}`,
    `walrusObjectId: ${record.walrusObjectId}`,
    `sealPolicyId: ${record.sealPolicyId}`,
    `runId: ${record.runId}`,
  ];

  if (allowPrivateSummary) {
    lines.push(`memorySummary: ${artifact.memorySummary}`);
    lines.push(`recommendation: ${artifact.report.recommendation}`);
  } else {
    lines.push("memorySummary: redacted");
  }

  return lines.join("\n");
}

function cleanEnv(value: string | undefined) {
  const cleaned = value?.trim();
  return cleaned || undefined;
}

function readBoolean(value: string | undefined, fallback: boolean) {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function readNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readOptionalNumber(value: string | undefined) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
