import type { MemoryIndexRecord, SuiNetwork } from "./memory-types";

export type SuiRegistryIntegrationStatus = {
  enabled: boolean;
  configured: boolean;
  status: "disabled" | "ready" | "missing_config";
  network: SuiNetwork;
  rpcUrl: string;
  target: string;
  registryObjectId?: string;
  missing: string[];
};

export type SuiRegistryResult = {
  status: "recorded" | "skipped" | "failed";
  suiTxDigest?: string;
  reason?: string;
  target?: string;
};

type SuiRegistryRuntime = {
  jsonRpc: {
    SuiJsonRpcClient: new (input: { url: string; network: string }) => {
      signAndExecuteTransaction(input: {
        transaction: unknown;
        signer: unknown;
        options?: Record<string, boolean>;
      }): Promise<{ digest?: string }>;
    };
  };
  transactions: {
    Transaction: new () => {
      pure: {
        string(value: string): unknown;
        address(value: string): unknown;
      };
      object(value: string): unknown;
      setGasBudget(value: number | bigint | string): void;
      moveCall(input: { target: string; arguments: unknown[] }): unknown;
    };
  };
  keypairs: {
    Ed25519Keypair: {
      fromSecretKey(secretKey: Uint8Array | string): unknown;
    };
  };
};

export function getSuiRegistryIntegrationStatus(): SuiRegistryIntegrationStatus {
  return readSuiRegistryConfig().status;
}

export async function recordSuiMemoryMetadata(
  record: MemoryIndexRecord
): Promise<SuiRegistryResult> {
  const config = readSuiRegistryConfig();

  if (!config.enabled) {
    return {
      status: "skipped",
      reason: "Sui registry is disabled.",
      target: config.target,
    };
  }

  if (!config.configured) {
    return {
      status: "failed",
      reason: `Sui registry is enabled but missing ${config.status.missing.join(", ")}.`,
      target: config.target,
    };
  }

  try {
    const runtime = await loadSuiRuntime();
    const client = new runtime.jsonRpc.SuiJsonRpcClient({
      url: config.rpcUrl,
      network: config.network,
    });
    const signer = runtime.keypairs.Ed25519Keypair.fromSecretKey(
      parsePrivateKey(config.privateKey)
    );
    const tx = new runtime.transactions.Transaction();
    tx.setGasBudget(config.gasBudget);
    tx.moveCall({
      target: config.target,
      arguments: buildMoveArguments(tx, config, record),
    });
    const result = await client.signAndExecuteTransaction({
      transaction: tx,
      signer,
      options: {
        showEffects: true,
        showEvents: true,
      },
    });

    if (!result.digest) {
      return {
        status: "failed",
        reason: "Sui registry transaction returned no digest.",
        target: config.target,
      };
    }

    return {
      status: "recorded",
      suiTxDigest: result.digest,
      target: config.target,
    };
  } catch (error) {
    return {
      status: "failed",
      reason: error instanceof Error ? error.message : "Sui registry transaction failed.",
      target: config.target,
    };
  }
}

type SuiRegistryConfig = {
  enabled: boolean;
  configured: boolean;
  privateKey: string;
  network: SuiNetwork;
  rpcUrl: string;
  packageId: string;
  moduleName: string;
  functionName: string;
  target: string;
  registryObjectId?: string;
  gasBudget: number;
  status: SuiRegistryIntegrationStatus;
};

function readSuiRegistryConfig(): SuiRegistryConfig {
  const packageId = cleanEnv(process.env.SUI_REGISTRY_PACKAGE_ID);
  const privateKey =
    cleanEnv(process.env.SUI_REGISTRY_PRIVATE_KEY) ||
    cleanEnv(process.env.SUI_PRIVATE_KEY) ||
    cleanEnv(process.env.SUI_AGENT_PRIVATE_KEY);
  const moduleName = cleanEnv(process.env.SUI_REGISTRY_MODULE) || "memory_registry";
  const functionName = cleanEnv(process.env.SUI_REGISTRY_FUNCTION) || "record_memory";
  const target = packageId ? `${packageId}::${moduleName}::${functionName}` : "";
  const enabled = readBoolean(process.env.SUI_REGISTRY_ENABLED, Boolean(packageId && privateKey));
  const rpcUrl =
    cleanEnv(process.env.SUI_RPC_URL) || "https://fullnode.mainnet.sui.io:443";
  const network = readSuiNetwork(process.env.SUI_NETWORK);
  const missing = [];

  if (!packageId) {
    missing.push("SUI_REGISTRY_PACKAGE_ID");
  }

  if (!privateKey) {
    missing.push("SUI_REGISTRY_PRIVATE_KEY (or SUI_PRIVATE_KEY / SUI_AGENT_PRIVATE_KEY)");
  }

  if (!rpcUrl) {
    missing.push("SUI_RPC_URL");
  }

  const configured = enabled && missing.length === 0;

  return {
    enabled,
    configured,
    privateKey: privateKey || "",
    network,
    rpcUrl,
    packageId: packageId || "",
    moduleName,
    functionName,
    target,
    registryObjectId: cleanEnv(process.env.SUI_REGISTRY_OBJECT_ID),
    gasBudget: readNumber(process.env.SUI_REGISTRY_GAS_BUDGET, 20_000_000),
    status: {
      enabled,
      configured,
      status: !enabled ? "disabled" : configured ? "ready" : "missing_config",
      network,
      rpcUrl,
      target,
      registryObjectId: cleanEnv(process.env.SUI_REGISTRY_OBJECT_ID),
      missing: enabled ? missing : [],
    },
  };
}

function buildMoveArguments(
  tx: InstanceType<SuiRegistryRuntime["transactions"]["Transaction"]>,
  config: SuiRegistryConfig,
  record: MemoryIndexRecord
) {
  const args = [
    tx.pure.string(record.runId),
    tx.pure.string(record.contentHash),
    tx.pure.string(record.walrusBlobId),
    tx.pure.string(record.walrusObjectId),
    tx.pure.string(record.sealPolicyId),
    tx.pure.address(record.ownerAddress),
  ];

  if (config.registryObjectId) {
    return [tx.object(config.registryObjectId), ...args];
  }

  return args;
}

async function loadSuiRuntime(): Promise<SuiRegistryRuntime> {
  const [jsonRpc, transactions, keypairs] = await Promise.all([
    import("@mysten/sui/jsonRpc"),
    import("@mysten/sui/transactions"),
    import("@mysten/sui/keypairs/ed25519"),
  ]);

  return {
    jsonRpc: jsonRpc as SuiRegistryRuntime["jsonRpc"],
    transactions: transactions as SuiRegistryRuntime["transactions"],
    keypairs: keypairs as SuiRegistryRuntime["keypairs"],
  };
}

function parsePrivateKey(privateKey: string) {
  const cleaned = privateKey.trim();

  if (cleaned.startsWith("suiprivkey")) {
    return cleaned;
  }

  return Uint8Array.from(Buffer.from(cleaned.replace(/^0x/, ""), "hex"));
}

function readSuiNetwork(value: string | undefined): SuiNetwork {
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
