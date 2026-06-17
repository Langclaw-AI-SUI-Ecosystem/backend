import type { Hex } from "viem";

import {
  defaultProductChain,
  getProductChain,
  readChainEnv,
  type ProductChainConfig,
  type ProductChainId,
} from "../chain-config";
import {
  DEFAULT_SUI_RPC_URL,
  createSuiClient,
  normalizeSuiPackageId,
  readSuiNumber,
  submitMoveCall,
  type SuiTransaction,
} from "../sui-onchain";
import type {
  StrategyAction,
  StrategyRecordStatus,
  StrategyRunRecord,
  StrategyRunsPayload,
  TradingJournalProof,
} from "./types";

type PersistTradingJournalInput = {
  action: StrategyAction;
  chain?: ProductChainId;
  decisionHash: Hex;
  evidenceUri: string;
  market: string;
  pnlBps: number;
  resultHash: Hex;
  runId: string;
  status: StrategyRecordStatus;
  strategyId: string;
};

const defaultTradingJournalModule = "trading_journal";
const defaultTradingJournalFunction = "record_strategy_run";
const strategyRunRecordedEventName = "StrategyRunRecorded";
const defaultGasBudget = 20_000_000;

export async function persistTradingJournalRecord(
  input: PersistTradingJournalInput
): Promise<TradingJournalProof> {
  const chainConfig = getProductChain(input.chain ?? defaultProductChain);
  const agentId = readAgentId(chainConfig);
  const chainId = readChainId(chainConfig);
  const packageId = readJournalPackageId(chainConfig);

  if (readChainEnv(chainConfig, "TRADING_JOURNAL_ENABLED") !== "true") {
    return buildPreparedProof({
      ...input,
      agentId,
      chainConfig,
      chainId,
      error: `${chainConfig.envPrefix}_TRADING_JOURNAL_ENABLED is not true.`,
      journalAddress: packageId,
    });
  }

  const privateKey = readPrivateKey(chainConfig);

  if (!privateKey) {
    return buildPreparedProof({
      ...input,
      agentId,
      chainConfig,
      chainId,
      error: `Set ${chainConfig.envPrefix}_AGENT_PRIVATE_KEY to record the strategy run.`,
      journalAddress: packageId,
    });
  }

  if (!packageId) {
    return buildPreparedProof({
      ...input,
      agentId,
      chainConfig,
      chainId,
      error: `Set ${chainConfig.envPrefix}_LANGCLAW_TRADING_JOURNAL_PACKAGE_ID to the deployed journal package.`,
      journalAddress: packageId,
    });
  }

  const moduleName = readJournalModule(chainConfig);
  const functionName = readJournalFunction(chainConfig);
  const target = `${packageId}::${moduleName}::${functionName}`;
  const rpcUrl = readRpcUrl(chainConfig);
  const network = chainConfig.suiNetwork;
  const explorerBase = readExplorerBase(chainConfig);
  const gasBudget = readGasBudget(chainConfig);

  const p = BigInt(input.pnlBps);
  const pnlMagnitude = p < 0n ? -p : p;
  const pnlNegative = p < 0n;

  let submittedTxHash: string | undefined;
  let submittedExplorerUrl: string | undefined;

  try {
    const result = await submitMoveCall({
      rpcUrl,
      network,
      privateKey,
      gasBudget,
      target,
      buildArgs: (tx: SuiTransaction) => [
        tx.pure.u64(agentId),
        tx.pure.string(input.runId),
        tx.pure.string(input.strategyId),
        tx.pure.string(input.market),
        tx.pure.string(input.decisionHash),
        tx.pure.string(input.resultHash),
        tx.pure.string(input.evidenceUri),
        tx.pure.string(input.action),
        tx.pure.u64(pnlMagnitude),
        tx.pure.bool(pnlNegative),
        tx.pure.string(input.status),
      ],
    });

    if (result.status !== "ok" || !result.digest) {
      throw new Error(
        result.reason ??
          `${chainConfig.name} strategy journal transaction failed.`
      );
    }

    submittedTxHash = result.digest;
    submittedExplorerUrl = `${explorerBase}/txblock/${result.digest}`;

    return {
      action: input.action,
      agentId: agentId.toString(),
      chain: chainConfig.id,
      chainId,
      chainName: chainConfig.name,
      decisionHash: input.decisionHash,
      evidenceUri: input.evidenceUri,
      explorerUrl: submittedExplorerUrl,
      journalAddress: packageId,
      pnlBps: input.pnlBps,
      resultHash: input.resultHash,
      status: "anchored",
      strategyStatus: input.status,
      txHash: submittedTxHash,
    };
  } catch (error) {
    return {
      action: input.action,
      agentId: agentId.toString(),
      chain: chainConfig.id,
      chainId,
      chainName: chainConfig.name,
      decisionHash: input.decisionHash,
      error: sanitizeError(error instanceof Error ? error.message : String(error)),
      evidenceUri: input.evidenceUri,
      explorerUrl: submittedExplorerUrl,
      journalAddress: packageId,
      pnlBps: input.pnlBps,
      resultHash: input.resultHash,
      status: "failed",
      strategyStatus: input.status,
      txHash: submittedTxHash,
    };
  }
}

export async function readTradingJournalRuns(
  limit = 25,
  chainInput: ProductChainId = defaultProductChain
): Promise<StrategyRunsPayload> {
  const chainConfig = getProductChain(chainInput);
  const packageId = readJournalPackageId(chainConfig);
  const chainId = readChainId(chainConfig);

  if (!packageId) {
    return {
      chain: chainConfig.id,
      chainId,
      chainName: chainConfig.name,
      configured: false,
      error: `${chainConfig.envPrefix}_LANGCLAW_TRADING_JOURNAL_PACKAGE_ID is not configured.`,
      nextRecordId: "0",
      records: [],
    };
  }

  const moduleName = readJournalModule(chainConfig);
  const rpcUrl = readRpcUrl(chainConfig);
  const explorerBase = readExplorerBase(chainConfig);
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
  const eventType = `${packageId}::${moduleName}::${strategyRunRecordedEventName}`;

  try {
    const client = await createSuiClient(rpcUrl, chainConfig.suiNetwork);
    const result = await client.queryEvents({
      query: { MoveEventType: eventType },
      limit: safeLimit,
      order: "descending",
    });
    const events = result.data ?? [];
    const records = events
      .map((event, index): StrategyRunRecord | undefined =>
        mapStrategyRunEvent({
          chainConfig,
          chainId,
          explorerBase,
          parsedJson: event.parsedJson,
          recordId: String(events.length - index),
          recorder: event.sender,
        })
      )
      .filter((record): record is StrategyRunRecord => Boolean(record));

    return {
      chain: chainConfig.id,
      chainId,
      chainName: chainConfig.name,
      configured: true,
      journalAddress: packageId,
      nextRecordId: String(records.length),
      records,
    };
  } catch (error) {
    return {
      chain: chainConfig.id,
      chainId,
      chainName: chainConfig.name,
      configured: false,
      error: sanitizeError(error instanceof Error ? error.message : String(error)),
      journalAddress: packageId,
      nextRecordId: "0",
      records: [],
    };
  }
}

function mapStrategyRunEvent({
  chainConfig,
  chainId,
  explorerBase,
  parsedJson,
  recordId,
  recorder,
}: {
  chainConfig: ProductChainConfig;
  chainId: number;
  explorerBase: string;
  parsedJson: unknown;
  recordId: string;
  recorder?: string;
}): StrategyRunRecord | undefined {
  if (!parsedJson || typeof parsedJson !== "object") {
    return undefined;
  }

  const fields = parsedJson as Record<string, unknown>;
  const pnlMagnitude = Number(readString(fields.pnl_bps) ?? "0");
  const pnlNegative = readBoolean(fields.pnl_negative);
  const pnlBps = Number.isFinite(pnlMagnitude)
    ? pnlNegative
      ? -pnlMagnitude
      : pnlMagnitude
    : 0;

  return {
    action: normalizeAction(readString(fields.action) ?? "hold"),
    agentId: readString(fields.agent_id) ?? "0",
    chain: chainConfig.id,
    chainId,
    chainName: chainConfig.name,
    createdAt: new Date().toISOString(),
    decisionHash: readString(fields.decision_hash) ?? "",
    evidenceUri: readString(fields.evidence_uri) ?? "",
    explorerUrl: undefined,
    market: readString(fields.market) ?? "",
    pnlBps,
    recordId,
    recorder: readString(fields.recorder) ?? recorder ?? "",
    resultHash: readString(fields.result_hash) ?? "",
    runId: readString(fields.run_id) ?? "",
    status: normalizeStatus(readString(fields.status) ?? "backtested"),
    strategyId: readString(fields.strategy_id) ?? "",
    txHash: undefined,
  };
}

function buildPreparedProof({
  action,
  agentId,
  chainConfig,
  chainId,
  decisionHash,
  error,
  evidenceUri,
  journalAddress,
  pnlBps,
  resultHash,
  status,
}: PersistTradingJournalInput & {
  agentId: bigint;
  chainConfig: ProductChainConfig;
  chainId: number;
  error: string;
  journalAddress?: string;
}): TradingJournalProof {
  return {
    action,
    agentId: agentId.toString(),
    chain: chainConfig.id,
    chainId,
    chainName: chainConfig.name,
    decisionHash,
    error,
    evidenceUri,
    journalAddress,
    pnlBps,
    resultHash,
    status: "prepared",
    strategyStatus: status,
  };
}

function readPrivateKey(chain: ProductChainConfig): string | undefined {
  const raw =
    readChainEnv(chain, "AGENT_PRIVATE_KEY") ||
    readChainEnv(chain, "PRIVATE_KEY");

  return raw?.trim() || undefined;
}

function readAgentId(chain: ProductChainConfig) {
  const raw =
    readChainEnv(chain, "AGENT_ID") ||
    readChainEnv(chain, "SELF_AGENT_ID") ||
    readChainEnv(chain, "ERC8004_AGENT_ID") ||
    process.env.LANGCLAW_AGENT_ID?.trim() ||
    "0";

  return /^\d+$/.test(raw) ? BigInt(raw) : 0n;
}

function readChainId(chain: ProductChainConfig) {
  const parsed = Number.parseInt(
    readChainEnv(chain, "CHAIN_ID", String(chain.chainId)) || "",
    10
  );

  return Number.isFinite(parsed) && parsed > 0 ? parsed : chain.chainId;
}

function readJournalPackageId(chain: ProductChainConfig) {
  const value = readChainEnv(chain, "LANGCLAW_TRADING_JOURNAL_PACKAGE_ID");
  return value ? normalizeSuiPackageId(value) : value;
}

function readJournalModule(chain: ProductChainConfig) {
  return (
    readChainEnv(chain, "LANGCLAW_TRADING_JOURNAL_MODULE") ||
    defaultTradingJournalModule
  );
}

function readJournalFunction(chain: ProductChainConfig) {
  return (
    readChainEnv(chain, "LANGCLAW_TRADING_JOURNAL_FUNCTION") ||
    defaultTradingJournalFunction
  );
}

function readRpcUrl(chain: ProductChainConfig) {
  return (
    readChainEnv(chain, "CHAIN_RPC_URL", chain.rpcUrl) || DEFAULT_SUI_RPC_URL
  );
}

function readExplorerBase(chain: ProductChainConfig) {
  return trimSlash(
    readChainEnv(chain, "CHAIN_EXPLORER_URL", chain.explorerUrl) ||
      chain.explorerUrl
  );
}

function readGasBudget(chain: ProductChainConfig) {
  return readSuiNumber(
    readChainEnv(chain, "TRADING_JOURNAL_GAS_BUDGET"),
    defaultGasBudget
  );
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

function readBoolean(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
  }

  return false;
}

function normalizeAction(value: string): StrategyAction {
  return value === "buy" || value === "sell" || value === "exit" ? value : "hold";
}

function normalizeStatus(value: string): StrategyRecordStatus {
  if (
    value === "backtested" ||
    value === "paper-opened" ||
    value === "paper-closed"
  ) {
    return value;
  }

  return "backtested";
}

function sanitizeError(message: string) {
  return message
    .replace(/suiprivkey[a-z0-9]+/gi, "[redacted-private-key]")
    .replace(/0x[a-fA-F0-9]{64}/g, "0x[redacted-private-key]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [redacted]");
}

function trimSlash(value: string) {
  return value.replace(/\/+$/, "");
}
