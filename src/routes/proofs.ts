import {
  defaultProductChain,
  getProductChain,
  readChainEnv,
  readProductChainId,
} from "../lib/chain-config";
import { buildProofReadinessReport } from "../lib/proof-readiness";
import {
  DEFAULT_SUI_RPC_URL,
  createSuiClient,
  normalizeSuiPackageId,
} from "../lib/sui-onchain";

type ProofDecision = {
  agentId: string;
  createdAt: string;
  decisionHash: string;
  decisionId: string;
  evidenceUri: string;
  explorerUrl?: string;
  recorder: string;
  runId: string;
  signalType: string;
  txHash?: string;
};

const defaultRegistryModule = "decision_registry";
const decisionRecordedEventName = "DecisionRecorded";

export async function handleProofDecisions(request: Request) {
  let limit = 20;
  let chain = getProductChain(defaultProductChain);

  try {
    const body = await request.json().catch(() => ({}));
    chain = getProductChain(readProductChainId((body as { chain?: unknown }).chain));
    const requestedLimit =
      body && typeof body === "object" && "limit" in body
        ? Number((body as { limit?: unknown }).limit)
        : limit;

    if (Number.isFinite(requestedLimit) && requestedLimit > 0) {
      limit = Math.min(Math.trunc(requestedLimit), 100);
    }
  } catch {
    return Response.json(
      { error: "Request body must be valid JSON." },
      { status: 400 }
    );
  }

  const packageIdRaw = readChainEnv(chain, "LANGCLAW_REGISTRY_PACKAGE_ID");

  if (!packageIdRaw) {
    return Response.json(
      { error: `${chain.envPrefix}_LANGCLAW_REGISTRY_PACKAGE_ID is not configured.` },
      { status: 503 }
    );
  }

  const packageId = normalizeSuiPackageId(packageIdRaw);
  const moduleName =
    readChainEnv(chain, "LANGCLAW_REGISTRY_MODULE") || defaultRegistryModule;
  const eventType = `${packageId}::${moduleName}::${decisionRecordedEventName}`;
  const rpcUrl =
    readChainEnv(chain, "CHAIN_RPC_URL", chain.rpcUrl) || DEFAULT_SUI_RPC_URL;
  const chainId = readChainId(chain);
  const explorerBase = trimSlash(
    readChainEnv(chain, "CHAIN_EXPLORER_URL", chain.explorerUrl) ||
      chain.explorerUrl
  );

  try {
    const client = await createSuiClient(rpcUrl, chain.suiNetwork);
    const result = await client.queryEvents({
      query: { MoveEventType: eventType },
      limit,
      order: "descending",
    });
    const events = result.data ?? [];

    const decisions = events
      .map((event, index): ProofDecision | undefined => {
        const fields = event.parsedJson;

        if (!fields || typeof fields !== "object") {
          return undefined;
        }

        const f = fields as Record<string, unknown>;
        const txDigest = event.id?.txDigest;
        const timestampMs = Number(event.timestampMs);

        return {
          agentId: readString(f.agent_id) ?? "0",
          createdAt: Number.isFinite(timestampMs)
            ? new Date(timestampMs).toISOString()
            : new Date(0).toISOString(),
          decisionHash: readString(f.decision_hash) ?? "",
          decisionId: String(events.length - index),
          evidenceUri: readString(f.evidence_uri) ?? "",
          explorerUrl: txDigest
            ? `${explorerBase}/txblock/${txDigest}`
            : undefined,
          recorder: readString(f.recorder) ?? event.sender ?? "",
          runId: readString(f.run_id) ?? "",
          signalType: readString(f.signal_type) ?? "",
          txHash: txDigest,
        };
      })
      .filter((decision): decision is ProofDecision => Boolean(decision));

    return Response.json({
      chain: chain.id,
      chainId,
      chainName: chain.name,
      configured: true,
      decisions,
      nativeSymbol: chain.nativeCurrency.symbol,
      nextDecisionId: String(decisions.length),
      registryAddress: packageId,
    });
  } catch (error) {
    return Response.json(
      {
        chain: chain.id,
        chainId,
        chainName: chain.name,
        configured: false,
        decisions: [],
        error: error instanceof Error ? error.message : "Failed to read Sui decisions.",
        nativeSymbol: chain.nativeCurrency.symbol,
        nextDecisionId: "0",
        registryAddress: packageId,
      },
      { status: 502 }
    );
  }
}

export async function handleProofReadiness(request: Request) {
  let body: { chain?: unknown } = {};

  try {
    body = await request.json().catch(() => ({}));
  } catch {
    return Response.json(
      { error: "Request body must be valid JSON." },
      { status: 400 }
    );
  }

  const report = await buildProofReadinessReport({
    chain: body.chain,
  });

  return Response.json(report, {
    status: report.ready ? 200 : 503,
  });
}

function readString(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "bigint") {
    return value.toString();
  }

  return undefined;
}

function readChainId(chain: ReturnType<typeof getProductChain>) {
  const parsed = Number.parseInt(
    readChainEnv(chain, "CHAIN_ID", String(chain.chainId)) || "",
    10
  );

  return Number.isFinite(parsed) && parsed > 0 ? parsed : chain.chainId;
}

function trimSlash(value: string) {
  return value.replace(/\/+$/, "");
}
