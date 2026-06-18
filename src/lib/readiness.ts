// Walrus / Seal / Sui / MemWal readiness for the private memory layer.
//
// Aggregates each adapter's status and, when a prior memory exists, verifies the
// latest encrypted artifact can still be retrieved from Walrus.

import { createMemoryIndex, getMemoryIndexStatus } from "./memory-index";
import { getMemWalIntegrationStatus } from "./memwal";
import { getSealIntegrationStatus, probeSealKeyServers } from "./seal";
import { getSuiRegistryIntegrationStatus } from "./sui-registry";
import type { MemoryIndexRecord, SealEnvelope } from "./memory-types";
import { createWalrusClient, getWalrusStorageStatus } from "./walrus";

export type ReadinessCheck = {
  name: string;
  required: boolean;
  status: "ready" | "local" | "disabled" | "missing_config" | "failed";
  message: string;
  details?: Record<string, unknown>;
};

export type WalrusReadinessReport = {
  configured: boolean;
  ready: boolean;
  strictMainnet: boolean;
  reason?: string;
  latest?: MemoryIndexRecord;
  checks: ReadinessCheck[];
  missing: string[];
  integrations: ReturnType<typeof getIntegrationOverview>;
};

export type WalrusReadinessOptions = {
  strictMainnet?: boolean;
};

export function getIntegrationOverview() {
  return {
    metadataIndex: getMemoryIndexStatus(),
    walrus: getWalrusStorageStatus(),
    seal: getSealIntegrationStatus(),
    memWal: getMemWalIntegrationStatus(),
    suiRegistry: getSuiRegistryIntegrationStatus(),
  };
}

export async function getWalrusReadiness(
  ownerAddress?: string,
  options: WalrusReadinessOptions = {}
): Promise<WalrusReadinessReport> {
  const strictMainnet = options.strictMainnet === true;
  const memoryIndex = createMemoryIndex();
  const walrus = createWalrusClient();
  const integrations = getIntegrationOverview();
  const checks = buildStaticChecks(integrations, { strictMainnet });

  if (integrations.seal.mode === "seal-sdk-configured") {
    const sealProbe = await probeSealKeyServers();
    const sealCheck = checks.find((check) => check.name === "sealPrivacy");

    if (sealCheck) {
      sealCheck.status = sealProbe.ready ? "ready" : "failed";
      sealCheck.message = sealProbe.ready
        ? "Seal key servers passed a live SDK encryption probe."
        : `Seal key-server runtime probe failed: ${sealProbe.reason ?? "unknown error"}`;
      sealCheck.details = {
        ...integrations.seal,
        runtimeProbe: sealProbe,
      };
    }
  }

  let latest: MemoryIndexRecord | undefined;

  try {
    latest = await memoryIndex.latest(ownerAddress);
  } catch (error) {
    latest = undefined;
    checks.push({
      name: "metadataIndexRead",
      required: false,
      status: "failed",
      message:
        error instanceof Error ? error.message : "Could not read the metadata index.",
    });
  }

  if (!latest) {
    const reportChecks = [
      ...checks,
      {
        name: "latestMemoryProof",
        required: true,
        status: "failed" as const,
        message:
          "No Sui Walrus private memory proof found yet. Run /api/discover (or npm run demo) once.",
      },
    ];

    return {
      configured: true,
      ready: false,
      strictMainnet,
      reason: "No Sui Walrus private memory proof found.",
      checks: reportChecks,
      missing: collectMissing(reportChecks),
      integrations,
    };
  }

  const proofRead = await readLatestMemoryProof(latest.walrusBlobId, {
    preferNetwork: strictMainnet,
    readLocal: () => walrus.readEnvelope(latest.walrusBlobId),
  });

  if (proofRead.ok) {
    const reportChecks = [
      ...checks,
      {
        name: "latestMemoryProof",
        required: true,
        status: "ready" as const,
        message:
          proofRead.source === "aggregator"
            ? "Latest encrypted Walrus memory proof can be retrieved from the public aggregator."
            : "Latest encrypted Walrus memory proof can be retrieved from the configured storage client.",
        details: {
          walrusBlobId: latest.walrusBlobId,
          walrusObjectId: latest.walrusObjectId,
          retrievalSource: proofRead.source,
          ...(proofRead.url ? { url: proofRead.url } : {}),
        },
      },
    ];

    return {
      configured: true,
      ready: hasRequiredChecksReady(reportChecks, { strictMainnet }),
      strictMainnet,
      latest,
      checks: reportChecks,
      missing: collectMissing(reportChecks),
      integrations,
    };
  } else {
    const message = proofRead.reason;
    const reportChecks = [
      ...checks,
      {
        name: "latestMemoryProof",
        required: true,
        status: "failed" as const,
        message,
        details: { walrusBlobId: latest.walrusBlobId },
      },
    ];

    return {
      configured: true,
      ready: false,
      strictMainnet,
      latest,
      reason: message,
      checks: reportChecks,
      missing: collectMissing(reportChecks),
      integrations,
    };
  }
}

function buildStaticChecks(
  integrations: ReturnType<typeof getIntegrationOverview>,
  options: { strictMainnet: boolean }
): ReadinessCheck[] {
  const strictMainnet = options.strictMainnet;
  const walrusIsHttp = integrations.walrus.mode === "http";
  const sealIsSdk = integrations.seal.mode === "seal-sdk-configured";
  const memWalReady = integrations.memWal.status === "ready";
  const suiRegistryReady = integrations.suiRegistry.status === "ready";

  return [
    {
      name: "metadataIndex",
      required: true,
      status: "ready",
      message: `Metadata index is using ${integrations.metadataIndex.mode}.`,
      details: integrations.metadataIndex,
    },
    {
      name: "walrusStorage",
      required: true,
      status: walrusIsHttp ? "ready" : strictMainnet ? "failed" : "local",
      message: walrusIsHttp
        ? "Walrus publisher and aggregator are configured."
        : strictMainnet
          ? "Strict mainnet readiness requires WALRUS_PUBLISHER_URL and WALRUS_AGGREGATOR_URL."
          : "Walrus uses local file fallback.",
      details: integrations.walrus,
    },
    {
      name: "sealPrivacy",
      required: true,
      status: integrations.seal.ready
        ? sealIsSdk
          ? "ready"
          : strictMainnet
            ? "failed"
            : "local"
        : "missing_config",
      message: sealIsSdk
        ? "Seal key-server config is present; runtime probe pending."
        : strictMainnet
          ? "Strict mainnet readiness requires real Seal SDK mode, not local envelope mode."
          : "Seal uses local envelope mode (owner-gated AES).",
      details: integrations.seal,
    },
    {
      name: "memWal",
      required: strictMainnet || integrations.memWal.enabled,
      status: memWalReady
        ? "ready"
        : integrations.memWal.status === "disabled" && !strictMainnet
          ? "disabled"
          : strictMainnet
            ? "failed"
            : "missing_config",
      message: memWalReady
        ? "MemWal relayer config is ready."
        : integrations.memWal.status === "disabled" && !strictMainnet
          ? "MemWal is disabled (local mode)."
          : strictMainnet
            ? "Strict mainnet readiness requires MemWal to be enabled and configured."
            : "MemWal is enabled but missing config.",
      details: integrations.memWal,
    },
    {
      name: "suiRegistry",
      required: strictMainnet || integrations.suiRegistry.enabled,
      status: suiRegistryReady
        ? "ready"
        : integrations.suiRegistry.status === "disabled" && !strictMainnet
          ? "disabled"
          : strictMainnet
            ? "failed"
            : "missing_config",
      message: suiRegistryReady
        ? "Sui registry transaction config is ready."
        : integrations.suiRegistry.status === "disabled" && !strictMainnet
          ? "Sui registry recording is disabled (local mode)."
          : strictMainnet
            ? "Strict mainnet readiness requires Sui registry recording to be enabled and configured."
            : "Sui registry is enabled but missing config.",
      details: integrations.suiRegistry,
    },
  ];
}

function hasRequiredChecksReady(
  checks: ReadinessCheck[],
  options: { strictMainnet: boolean }
) {
  return checks.every((check) => {
    if (!check.required) {
      return true;
    }

    if (check.status === "ready") {
      return true;
    }

    return !options.strictMainnet && check.status === "local";
  });
}

function collectMissing(checks: ReadinessCheck[]) {
  return checks.flatMap((check) => {
    const missing = check.details?.missing;

    if (Array.isArray(missing) && missing.length > 0) {
      return missing.map(String);
    }

    return check.status === "failed" ? [check.name] : [];
  });
}

async function readLatestMemoryProof(
  blobId: string,
  input: {
    preferNetwork: boolean;
    readLocal: () => Promise<SealEnvelope>;
  }
): Promise<
  | { ok: true; source: "local" | "aggregator"; url?: string }
  | { ok: false; reason: string }
> {
  const aggregatorUrl = process.env.WALRUS_AGGREGATOR_URL?.trim();

  if (input.preferNetwork && aggregatorUrl) {
    const network = await readEnvelopeFromAggregator(blobId, aggregatorUrl);

    if (network.ok) {
      return network;
    }
  }

  if (!input.preferNetwork) {
    try {
      await input.readLocal();

      return { ok: true, source: "local" };
    } catch (error) {
      const localReason = readErrorMessage(error);

      if (aggregatorUrl) {
        const network = await readEnvelopeFromAggregator(blobId, aggregatorUrl);

        if (network.ok) {
          return network;
        }

        return {
          ok: false,
          reason: `${localReason}; public aggregator fallback failed: ${network.reason}`,
        };
      }

      return { ok: false, reason: localReason };
    }
  }

  if (!aggregatorUrl) {
    return {
      ok: false,
      reason:
        "Strict mainnet readiness requires WALRUS_AGGREGATOR_URL to retrieve the latest proof from Walrus.",
    };
  }

  return readEnvelopeFromAggregator(blobId, aggregatorUrl);
}

async function readEnvelopeFromAggregator(
  blobId: string,
  aggregatorUrl: string
): Promise<
  | { ok: true; source: "aggregator"; url: string }
  | { ok: false; reason: string }
> {
  const url = `${aggregatorUrl.replace(/\/+$/, "")}/v1/blobs/${encodeURIComponent(blobId)}`;

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(readReadinessWalrusTimeoutMs()),
    });

    if (!response.ok) {
      return {
        ok: false,
        reason: `Walrus aggregator returned ${response.status}.`,
      };
    }

    await response.json();

    return { ok: true, source: "aggregator", url };
  } catch (error) {
    return {
      ok: false,
      reason: readErrorMessage(error),
    };
  }
}

function readReadinessWalrusTimeoutMs() {
  const parsed = Number(process.env.WALRUS_TIMEOUT_MS);

  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 60_000;
}

function readErrorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Latest Walrus memory proof could not be retrieved.";
}
