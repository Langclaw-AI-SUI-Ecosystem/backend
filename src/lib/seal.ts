import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import type {
  ExportedSealSession,
  PrivateMemoryArtifact,
  SealEnvelope,
  SealMode,
} from "./memory-types";

export type SealIntegrationStatus = {
  mode: SealMode;
  ready: boolean;
  mockMode: boolean;
  policyId: string;
  packageId?: string;
  threshold: number;
  keyServerCount: number;
  keyServerConfigSource: "json" | "object-ids" | "empty";
  keyServerAuthConfigured: boolean;
  keyServerAggregatorConfigured: boolean;
  strictMode: boolean;
  network: SealNetwork;
  missing: string[];
  errors: string[];
};

export type SealRuntimeProbe = {
  ready: boolean;
  mode: SealMode;
  keyServerCount: number;
  reason?: string;
};

type SealKeyServerConfig = {
  objectId: string;
  weight: number;
  apiKeyName?: string;
  apiKey?: string;
  aggregatorUrl?: string;
};

type SealNetwork = "testnet" | "mainnet" | "devnet" | "localnet";

export class SealAccessDeniedError extends Error {
  constructor() {
    super("Seal policy denied access to this private memory.");
  }
}

export class SealSessionRequiredError extends Error {
  constructor() {
    super("A Seal session key is required to decrypt this private memory.");
  }
}

export function getSealPolicyId() {
  return process.env.SEAL_POLICY_ID?.trim() || "langclaw-private-memory-mainnet";
}

export function getSealIntegrationStatus(): SealIntegrationStatus {
  const config = readSealConfig();
  const missing = [...config.errors];

  if (!config.mockMode) {
    if (!config.packageId) {
      missing.push("SEAL_PACKAGE_ID");
    }

    if (config.keyServerConfigs.length === 0) {
      missing.push("SEAL_KEY_SERVER_CONFIGS_JSON or SEAL_KEY_SERVER_OBJECT_IDS");
    }
  }

  return {
    mode: config.mockMode || missing.length > 0 ? "local-envelope" : "seal-sdk-configured",
    ready: config.mockMode || missing.length === 0,
    mockMode: config.mockMode,
    policyId: config.policyId,
    packageId: config.packageId,
    threshold: config.threshold,
    keyServerCount: config.keyServerConfigs.length,
    keyServerConfigSource: config.keyServerConfigSource,
    keyServerAuthConfigured: config.keyServerConfigs.some(
      (serverConfig) => serverConfig.apiKeyName !== undefined || serverConfig.apiKey !== undefined
    ),
    keyServerAggregatorConfigured: config.keyServerConfigs.some(
      (serverConfig) => serverConfig.aggregatorUrl !== undefined
    ),
    strictMode: isSealStrictMode(config),
    network: config.network,
    missing,
    errors: config.errors,
  };
}

/**
 * Prove that the configured Seal servers are reachable and match their on-chain
 * objects. This performs public-key encryption only. It does not request a
 * decryption share or write any chain state.
 */
export async function probeSealKeyServers(): Promise<SealRuntimeProbe> {
  const config = readSealConfig();
  const status = getSealIntegrationStatus();

  if (status.mode !== "seal-sdk-configured") {
    return {
      ready: false,
      mode: status.mode,
      keyServerCount: status.keyServerCount,
      reason: status.missing.join(", ") || "Seal key-server mode is not configured.",
    };
  }

  try {
    const envelope = await withSealTimeout(
      encryptWithSeal(
        Buffer.from("langclaw-seal-runtime-readiness", "utf8"),
        `0x${"00".repeat(32)}`,
        config
      ),
      getSealEncryptTimeoutMs()
    );

    return {
      ready: envelope.sealMode === "seal-sdk-configured",
      mode: envelope.sealMode,
      keyServerCount: envelope.sealKeyServerCount ?? 0,
    };
  } catch (error) {
    return {
      ready: false,
      mode: "seal-sdk-configured",
      keyServerCount: status.keyServerCount,
      reason: error instanceof Error ? error.message : "Seal runtime probe failed.",
    };
  }
}

export async function encryptPrivateMemory(
  artifact: PrivateMemoryArtifact,
  ownerAddress: string
): Promise<SealEnvelope> {
  const config = readSealConfig();
  const plaintext = Buffer.from(JSON.stringify(artifact), "utf8");

  if (getSealIntegrationStatus().mode === "seal-sdk-configured") {
    try {
      return await withSealTimeout(
        encryptWithSeal(plaintext, ownerAddress, config),
        getSealEncryptTimeoutMs()
      );
    } catch (error) {
      if (isSealStrictMode(config)) {
        throw error;
      }
    }
  }

  return encryptWithLocalEnvelope(plaintext, ownerAddress);
}

function isSealStrictMode(config: SealConfig) {
  return readBoolean(
    process.env.SEAL_STRICT_MODE,
    !config.mockMode && config.network === "mainnet"
  );
}

export async function decryptPrivateMemory(
  envelope: SealEnvelope,
  requesterAddress: string,
  session?: ExportedSealSession
): Promise<PrivateMemoryArtifact> {
  if (normalizeOwner(envelope.ownerAddress) !== normalizeOwner(requesterAddress)) {
    throw new SealAccessDeniedError();
  }

  if (envelope.sealMode === "seal-sdk-configured") {
    return decryptWithSeal(envelope, session);
  }

  return decryptWithLocalEnvelope(envelope);
}

// --- Seal SDK mode (real threshold encryption + on-chain access control) ---

async function encryptWithSeal(
  plaintext: Buffer,
  ownerAddress: string,
  config: SealConfig
): Promise<SealEnvelope> {
  const { SealClient } = await import("@mysten/seal");
  const suiClient = await buildSuiClient(config);
  const identity = sealIdentity(ownerAddress);

  const sealClient = new SealClient({
    suiClient,
    serverConfigs: config.keyServerConfigs,
    verifyKeyServers: true,
  });

  const { encryptedObject } = await sealClient.encrypt({
    threshold: config.threshold,
    packageId: config.packageId!,
    id: identity,
    data: new Uint8Array(plaintext),
  });

  return {
    schema: "langclaw.seal-envelope.v1",
    ownerAddress: normalizeOwner(ownerAddress),
    sealPolicyId: config.policyId,
    sealMode: "seal-sdk-configured",
    sealPackageId: config.packageId,
    sealIdentity: identity,
    sealThreshold: config.threshold,
    sealKeyServerObjectIds: config.keyServerConfigs.map((serverConfig) => serverConfig.objectId),
    sealKeyServerCount: config.keyServerConfigs.length,
    sealEncryptedObject: Buffer.from(encryptedObject).toString("base64"),
    createdAt: new Date().toISOString(),
  };
}

async function decryptWithSeal(
  envelope: SealEnvelope,
  session?: ExportedSealSession
): Promise<PrivateMemoryArtifact> {
  if (!session) {
    throw new SealSessionRequiredError();
  }

  if (!envelope.sealEncryptedObject || !envelope.sealPackageId || !envelope.sealIdentity) {
    throw new Error("Seal envelope is missing fields required for decryption.");
  }

  const config = readSealConfig();
  const [{ SealClient, SessionKey }, { Transaction }, { fromHex }] = await Promise.all([
    import("@mysten/seal"),
    import("@mysten/sui/transactions"),
    import("@mysten/sui/utils"),
  ]);
  const suiClient = await buildSuiClient(config);

  const sealClient = new SealClient({
    suiClient,
    serverConfigs: resolveEnvelopeServerConfigs(envelope, config),
    verifyKeyServers: true,
  });

  const sessionKey = SessionKey.import(session, suiClient);
  const tx = new Transaction();
  tx.moveCall({
    target: `${envelope.sealPackageId}::access_policy::seal_approve`,
    arguments: [tx.pure.vector("u8", fromHex(envelope.sealIdentity))],
  });
  const txBytes = await tx.build({ client: suiClient, onlyTransactionKind: true });

  const decrypted = await sealClient.decrypt({
    data: Buffer.from(envelope.sealEncryptedObject, "base64"),
    sessionKey,
    txBytes,
  });

  return JSON.parse(Buffer.from(decrypted).toString("utf8")) as PrivateMemoryArtifact;
}

// --- Agent handoff envelopes (intra-run, agent-system owned) ---

/** Encrypt arbitrary agent-handoff JSON with the local AES envelope (backend key),
 * independent of Seal mode, so the multi-agent orchestrator can always read a
 * handoff back from Walrus mid-run without an owner SessionKey. Handoffs are
 * agent-internal coordination, not user-private memory (which uses real Seal). */
export function encryptAgentHandoff(value: unknown): SealEnvelope {
  return encryptWithLocalEnvelope(Buffer.from(JSON.stringify(value), "utf8"), "0x0");
}

export function decryptAgentHandoff<T>(envelope: SealEnvelope): T {
  if (!envelope.iv || !envelope.authTag || !envelope.ciphertext) {
    throw new Error("Agent handoff envelope is missing AES fields.");
  }

  const key = readEncryptionKey();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]);

  return JSON.parse(plaintext.toString("utf8")) as T;
}

// --- Local envelope mode (offline AES-256-GCM fallback, owner-gated) ---

function encryptWithLocalEnvelope(plaintext: Buffer, ownerAddress: string): SealEnvelope {
  const key = readEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    schema: "langclaw.seal-envelope.v1",
    ownerAddress: normalizeOwner(ownerAddress),
    sealPolicyId: getSealPolicyId(),
    sealMode: "local-envelope",
    sealPackageId: readSealConfig().packageId,
    sealIdentity: buildSealIdentity(ownerAddress),
    sealKeyServerCount: readSealConfig().keyServerConfigs.length,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    createdAt: new Date().toISOString(),
  };
}

function decryptWithLocalEnvelope(envelope: SealEnvelope): PrivateMemoryArtifact {
  if (!envelope.iv || !envelope.authTag || !envelope.ciphertext) {
    throw new Error("Local Seal envelope is missing fields required for decryption.");
  }

  const key = readEncryptionKey();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]);

  return JSON.parse(plaintext.toString("utf8")) as PrivateMemoryArtifact;
}

// --- shared helpers ---

async function buildSuiClient(config: SealConfig) {
  const { SuiJsonRpcClient } = await import("@mysten/sui/jsonRpc");

  return new SuiJsonRpcClient({ url: config.rpcUrl, network: config.network });
}

/** Seal identity = the owner's 32-byte address (hex, no 0x), matching the
 * on-chain `access_policy::seal_approve` owner-only gate. */
function sealIdentity(ownerAddress: string) {
  return normalizeOwner(ownerAddress).slice(2);
}

function readEncryptionKey() {
  const configured = process.env.SEAL_ENCRYPTION_KEY?.trim();
  const secret = configured || "langclaw-local-seal-development-key";

  return createHash("sha256").update(secret).digest();
}

async function withSealTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Seal encryption timed out after ${timeoutMs}ms.`)),
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

function getSealEncryptTimeoutMs() {
  const parsed = Number(process.env.SEAL_ENCRYPT_TIMEOUT_MS);

  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 15_000;
}

function normalizeOwner(address: string) {
  const trimmed = address.trim().toLowerCase();
  const hex = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;

  return `0x${hex.padStart(64, "0")}`;
}

function buildSealIdentity(ownerAddress: string) {
  return `${getSealPolicyId()}:${normalizeOwner(ownerAddress)}`;
}

type SealConfig = {
  policyId: string;
  packageId?: string;
  mockMode: boolean;
  keyServerConfigs: SealKeyServerConfig[];
  keyServerConfigSource: "json" | "object-ids" | "empty";
  errors: string[];
  threshold: number;
  rpcUrl: string;
  network: SealNetwork;
};

function readSealConfig(): SealConfig {
  const keyServerConfigResult = readKeyServerConfigs();
  const thresholdValue = Number(
    process.env.SEAL_THRESHOLD || keyServerConfigResult.configs.length || 1
  );

  return {
    policyId: getSealPolicyId(),
    packageId: cleanEnv(process.env.SEAL_PACKAGE_ID),
    mockMode: readBoolean(process.env.SEAL_MOCK_MODE, true),
    keyServerConfigs: keyServerConfigResult.configs,
    keyServerConfigSource: keyServerConfigResult.source,
    errors: keyServerConfigResult.errors,
    threshold: Number.isFinite(thresholdValue) && thresholdValue > 0 ? thresholdValue : 1,
    rpcUrl: cleanEnv(process.env.SUI_RPC_URL) || "https://fullnode.mainnet.sui.io:443",
    network: readSuiNetwork(process.env.SUI_NETWORK),
  };
}

function readKeyServerConfigs(): {
  configs: SealKeyServerConfig[];
  source: SealConfig["keyServerConfigSource"];
  errors: string[];
} {
  const json = cleanEnv(process.env.SEAL_KEY_SERVER_CONFIGS_JSON);

  if (json) {
    try {
      const parsed = JSON.parse(json) as unknown;

      if (!Array.isArray(parsed)) {
        return {
          configs: [],
          source: "json",
          errors: ["SEAL_KEY_SERVER_CONFIGS_JSON must be a JSON array"],
        };
      }

      const configs: SealKeyServerConfig[] = [];
      const errors: string[] = [];

      parsed.forEach((entry, index) => {
        const config = parseKeyServerConfig(entry);
        if (config) {
          configs.push(config);
          return;
        }

        errors.push(`SEAL_KEY_SERVER_CONFIGS_JSON[${index}] is missing objectId`);
      });

      return { configs, source: "json", errors };
    } catch (error) {
      return {
        configs: [],
        source: "json",
        errors: [
          `SEAL_KEY_SERVER_CONFIGS_JSON is not valid JSON: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ],
      };
    }
  }

  const objectIds = splitEnvList(process.env.SEAL_KEY_SERVER_OBJECT_IDS);
  if (objectIds.length === 0) {
    return { configs: [], source: "empty", errors: [] };
  }

  const weights = splitEnvList(process.env.SEAL_KEY_SERVER_WEIGHTS).map((weight) =>
    Number(weight)
  );
  const apiKeyName = cleanEnv(process.env.SEAL_KEY_SERVER_API_KEY_NAME);
  const apiKey = cleanEnv(process.env.SEAL_KEY_SERVER_API_KEY);
  const aggregatorUrl = cleanEnv(process.env.SEAL_KEY_SERVER_AGGREGATOR_URL);

  return {
    configs: objectIds.map((objectId, index) => ({
      objectId,
      weight: Number.isFinite(weights[index]) && weights[index] > 0 ? weights[index] : 1,
      ...(apiKeyName ? { apiKeyName } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(aggregatorUrl ? { aggregatorUrl } : {}),
    })),
    source: "object-ids",
    errors: [],
  };
}

function parseKeyServerConfig(value: unknown): SealKeyServerConfig | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const objectId = typeof record.objectId === "string" ? cleanEnv(record.objectId) : undefined;

  if (!objectId) {
    return undefined;
  }

  const weight = Number(record.weight ?? 1);
  const apiKeyName =
    typeof record.apiKeyName === "string" ? cleanEnv(record.apiKeyName) : undefined;
  const apiKey = typeof record.apiKey === "string" ? cleanEnv(record.apiKey) : undefined;
  const aggregatorUrl =
    typeof record.aggregatorUrl === "string" ? cleanEnv(record.aggregatorUrl) : undefined;

  return {
    objectId,
    weight: Number.isFinite(weight) && weight > 0 ? weight : 1,
    ...(apiKeyName ? { apiKeyName } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(aggregatorUrl ? { aggregatorUrl } : {}),
  };
}

function resolveEnvelopeServerConfigs(
  envelope: SealEnvelope,
  config: SealConfig
): SealKeyServerConfig[] {
  const envelopeObjectIds = envelope.sealKeyServerObjectIds;

  if (!envelopeObjectIds || envelopeObjectIds.length === 0) {
    return config.keyServerConfigs;
  }

  return envelopeObjectIds.map((objectId) => {
    return (
      config.keyServerConfigs.find((serverConfig) => serverConfig.objectId === objectId) ?? {
        objectId,
        weight: 1,
      }
    );
  });
}

function readSuiNetwork(value: string | undefined): SealNetwork {
  const cleaned = value?.trim();

  if (
    cleaned === "mainnet" ||
    cleaned === "testnet" ||
    cleaned === "devnet" ||
    cleaned === "localnet"
  ) {
    return cleaned;
  }

  return "mainnet";
}

function splitEnvList(value: string | undefined) {
  return (value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
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
