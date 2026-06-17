// Walrus / Seal / Sui / MemWal readiness for the private memory layer.
//
// Aggregates each adapter's status and, when a prior memory exists, verifies the
// latest encrypted artifact can still be retrieved from Walrus.

import { createMemoryIndex, getMemoryIndexStatus } from "./memory-index";
import { getMemWalIntegrationStatus } from "./memwal";
import { getSealIntegrationStatus } from "./seal";
import { getSuiRegistryIntegrationStatus } from "./sui-registry";
import type { MemoryIndexRecord } from "./memory-types";
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
  reason?: string;
  latest?: MemoryIndexRecord;
  checks: ReadinessCheck[];
  missing: string[];
  integrations: ReturnType<typeof getIntegrationOverview>;
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
  ownerAddress?: string
): Promise<WalrusReadinessReport> {
  const memoryIndex = createMemoryIndex();
  const walrus = createWalrusClient();
  const integrations = getIntegrationOverview();
  const checks = buildStaticChecks(integrations);

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
      reason: "No Sui Walrus private memory proof found.",
      checks: reportChecks,
      missing: collectMissing(reportChecks),
      integrations,
    };
  }

  try {
    await walrus.readEnvelope(latest.walrusBlobId);
    const reportChecks = [
      ...checks,
      {
        name: "latestMemoryProof",
        required: true,
        status: "ready" as const,
        message: "Latest encrypted Walrus memory proof can be retrieved.",
        details: {
          walrusBlobId: latest.walrusBlobId,
          walrusObjectId: latest.walrusObjectId,
        },
      },
    ];

    return {
      configured: true,
      ready: hasRequiredChecksReady(reportChecks),
      latest,
      checks: reportChecks,
      missing: collectMissing(reportChecks),
      integrations,
    };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Latest Walrus memory proof could not be retrieved.";
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
      latest,
      reason: message,
      checks: reportChecks,
      missing: collectMissing(reportChecks),
      integrations,
    };
  }
}

function buildStaticChecks(
  integrations: ReturnType<typeof getIntegrationOverview>
): ReadinessCheck[] {
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
      status: integrations.walrus.mode === "http" ? "ready" : "local",
      message:
        integrations.walrus.mode === "http"
          ? "Walrus publisher and aggregator are configured."
          : "Walrus uses local file fallback.",
      details: integrations.walrus,
    },
    {
      name: "sealPrivacy",
      required: true,
      status: integrations.seal.ready
        ? integrations.seal.mode === "seal-sdk-configured"
          ? "ready"
          : "local"
        : "missing_config",
      message:
        integrations.seal.mode === "seal-sdk-configured"
          ? "Seal SDK key-server config is ready."
          : "Seal uses local envelope mode (owner-gated AES).",
      details: integrations.seal,
    },
    {
      name: "memWal",
      required: integrations.memWal.enabled,
      status:
        integrations.memWal.status === "ready"
          ? "ready"
          : integrations.memWal.status === "disabled"
            ? "disabled"
            : "missing_config",
      message:
        integrations.memWal.status === "ready"
          ? "MemWal relayer config is ready."
          : integrations.memWal.status === "disabled"
            ? "MemWal is disabled (local mode)."
            : "MemWal is enabled but missing config.",
      details: integrations.memWal,
    },
    {
      name: "suiRegistry",
      required: integrations.suiRegistry.enabled,
      status:
        integrations.suiRegistry.status === "ready"
          ? "ready"
          : integrations.suiRegistry.status === "disabled"
            ? "disabled"
            : "missing_config",
      message:
        integrations.suiRegistry.status === "ready"
          ? "Sui registry transaction config is ready."
          : integrations.suiRegistry.status === "disabled"
            ? "Sui registry recording is disabled (local mode)."
            : "Sui registry is enabled but missing config.",
      details: integrations.suiRegistry,
    },
  ];
}

function hasRequiredChecksReady(checks: ReadinessCheck[]) {
  return checks.every((check) => {
    if (!check.required) {
      return true;
    }

    return check.status === "ready" || check.status === "local";
  });
}

function collectMissing(checks: ReadinessCheck[]) {
  return checks.flatMap((check) => {
    const missing = check.details?.missing;

    if (Array.isArray(missing)) {
      return missing.map(String);
    }

    return check.status === "failed" ? [check.name] : [];
  });
}
