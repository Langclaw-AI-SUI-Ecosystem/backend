import type { UsageMeter } from "../usage-pricing";
import type { OnChainToolFinalPayload } from "../onchain-tools/types";
import type { WalrusMemoryProof } from "../memory-types";

export type SourceType =
  | "x_post"
  | "github_repo"
  | "docs_page"
  | "hackquest_hackathon"
  | "hackquest_project";

export type ProviderName =
  | "X"
  | "GitHub"
  | "Tavily"
  | "HackQuest"
  | "Surf"
  | "Nansen"
  | "Elfa";

export type ProviderTraceStatus = "success" | "failed" | "skipped";

export type ProviderTraceScope =
  | "sui-premium"
  | "legacy-fallback"
  | "legacy-default"
  | "out-of-scope";

export type ProviderTraceEntry = {
  provider: string;
  status: ProviderTraceStatus;
  scope: ProviderTraceScope;
  message: string;
  sourceCount?: number;
};

export type SourceCard = {
  id: string;
  type: SourceType;
  title: string;
  url: string;
  author?: string;
  publishedAt?: string;
  excerpt: string;
  metrics?: Record<string, string | number | undefined>;
  provider: ProviderName;
};

export type ProviderError = {
  provider: ProviderName;
  message: string;
};

export type ProviderResult = {
  sources: SourceCard[];
  errors: ProviderError[];
  providerTrace: ProviderTraceEntry[];
};

export type OrchestrationRuntime = "openclaw" | "typescript";

export type StepExecution =
  | "openclaw-agent"
  | "typescript-tool"
  | "openai"
  | "evidence-bundle"
  | "chain-proof"
  | "deterministic-fallback";

export type OrchestrationStep = {
  agent: string;
  skill: string;
  status: "complete" | "failed";
  summary: string;
  execution?: StepExecution;
  model?: string;
  sessionId?: string;
  error?: string;
};

export type WorkflowProgressEvent = {
  stepId: string;
  agent: string;
  skill: string;
  status: "pending" | "running" | "complete" | "failed";
  summary: string;
  timestamp: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  execution?: StepExecution;
  model?: string;
  sessionId?: string;
  error?: string;
};

export type OrchestrationTrace = {
  runtime: OrchestrationRuntime;
  steps: OrchestrationStep[];
};

export type FinalConclusion = {
  headline: string;
  summary: string;
  keySignals: Array<{
    label: string;
    text: string;
    sourceId?: string;
    sourceIds: string[];
  }>;
  recommendation: string;
  qualityNote: string;
  generatedBy: "Final Conclusion Agent";
};

export type FinalAnswer = {
  title?: string;
  answer: string;
  answerMarkdown?: string;
  bullets: string[];
  recommendation?: string;
  caveat?: string;
  generatedBy: "Final Conclusion Agent";
};

export type FinalAnswerMeta = {
  synthesis: "openai" | "openclaw-ai" | "deterministic-fallback";
  execution?: StepExecution;
  model?: string;
  requestedModel?: string;
  usedModel?: string;
  modelHonored?: boolean;
  sessionId?: string;
  transport?: string;
  fallbackFrom?: string;
  error?: string;
};

export type DiscoverSignalStatus =
  | "success"
  | "partial"
  | "skipped"
  | "failed";

export type DiscoverSignalSection = {
  status: DiscoverSignalStatus;
  summary: string;
  providers: string[];
  sourceIds: string[];
  toolIds: string[];
  caveat?: string;
};

export type DiscoverSignals = {
  social: DiscoverSignalSection;
  onchain: DiscoverSignalSection;
  combined: DiscoverSignalSection;
};

export type ResearchReportKind =
  | "liquidity-anomaly"
  | "smart-money"
  | "market-brief"
  | "defi-yield"
  | "token-discovery"
  | "mixed-research";

export type ResearchReportSeverity =
  | "high"
  | "medium"
  | "watch"
  | "fragile"
  | "info";

export type ResearchReportConfidence =
  | "high"
  | "medium"
  | "low"
  | "insufficient";

export type ResearchReportEntity = {
  id: string;
  label: string;
  category: string;
  rank: number;
  severity: ResearchReportSeverity;
  summary: string;
  metrics: Record<string, string | number | null>;
  sourceIds: string[];
  toolIds: string[];
};

export type ResearchReportTable = {
  id: string;
  title: string;
  description?: string;
  columns: string[];
  rows: Array<Record<string, string | number | null>>;
};

export type ResearchReportSection = {
  id: string;
  title: string;
  markdown: string;
  sourceIds: string[];
  toolIds: string[];
};

export type ResearchReport = {
  kind: ResearchReportKind;
  title: string;
  asOfUtc: string;
  executiveSummary: string;
  bottomLine: string;
  confidence: ResearchReportConfidence;
  entities: ResearchReportEntity[];
  tables: ResearchReportTable[];
  sections: ResearchReportSection[];
  caveats: string[];
  recommendations: string[];
};

export type AlphaSignalQualityLabel =
  | "high"
  | "medium"
  | "low"
  | "insufficient";

export type AlphaFalsePositiveCheck = {
  id: string;
  label: string;
  reason: string;
  status: "pass" | "warn" | "fail";
};

export type AlphaSignalQuality = {
  alertEligible: boolean;
  evidenceCount: number;
  falsePositiveChecks: AlphaFalsePositiveCheck[];
  freshnessMinutes?: number;
  label: AlphaSignalQualityLabel;
  reasons: string[];
  score: number;
  sourceCoverage: {
    directWalletFlow: boolean;
    onchain: boolean;
    proof: boolean;
    providerCount: number;
    social: boolean;
  };
};

export type AlphaSignalNotification = {
  channel: "none" | "telegram";
  error?: string;
  reason?: string;
  sentAt?: string;
  status: "disabled" | "failed" | "sent" | "skipped";
};

export type AlphaSignal = {
  alertEligible: boolean;
  generatedAt: string;
  notification?: AlphaSignalNotification;
  quality: AlphaSignalQuality;
  schema: "langclaw.alpha-signal.v1";
  signalType: ResearchReportKind | "unknown";
};

export type PlannerOutput = {
  summary: string;
  providerPlan: Array<{
    provider: ProviderName;
    query: string;
    purpose: string;
  }>;
  scoringFocus: string[];
};

export type TrendOutput = {
  summary: string;
  topTrend: string;
  score: number;
  rankedTrends: Array<{
    label: string;
    score: number;
    why: string;
    sourceIds: string[];
  }>;
};

export type EvidenceOutput = {
  bundleSummary: string;
  storageStatus: ZeroGStorageStatus;
  evidenceUri: string;
  rootHash?: string;
  storageTxHash?: string;
  storageExplorerUrl?: string;
  error?: string;
  claimMap: Array<{
    claim: string;
    sourceIds: string[];
  }>;
};

export type VerifierOutput = {
  verificationSummary: string;
  unsupportedClaims: string[];
  briefHashInput: string;
  storageStatus: ZeroGStorageStatus;
  chainStatus: ZeroGChainStatus;
  chainTxHash?: string;
  chainExplorerUrl?: string;
  registryAddress?: string;
  error?: string;
};

export type AgentOutputs = {
  planner?: PlannerOutput;
  trend?: TrendOutput;
  evidence?: EvidenceOutput;
  verifier?: VerifierOutput;
};

export type WorkflowChainContext = {
  productChain: {
    id: string;
    name: string;
    chainId: number;
    nativeSymbol: string;
  };
  analysisChain: {
    id: string;
    name: string;
    chainId: number;
    nativeSymbol?: string;
    source: "product-fallback" | "prompt";
    supported: boolean;
  };
  unsupportedAnalysisChain?: {
    id: string;
    name: string;
  };
};

export type DiscoverPayload = {
  topic: string;
  generatedAt: string;
  chainContext: WorkflowChainContext;
  sources: SourceCard[];
  errors: ProviderError[];
  providerTrace: ProviderTraceEntry[];
  signals: DiscoverSignals;
  report?: ResearchReport;
  onChain?: OnChainToolFinalPayload;
  onChainSkippedReason?: string;
  orchestration: OrchestrationTrace;
  finalConclusion: FinalConclusion;
  finalAnswer: FinalAnswer;
  finalAnswerMeta?: FinalAnswerMeta;
  agentOutputs?: AgentOutputs;
  proof?: ZeroGProof;
  zeroG?: ZeroGProof;
  alphaSignal?: AlphaSignal;
  usage?: ModelUsageReceipt;
  /** Sui + Walrus verifiable-memory proof for this run (added by the private
   * memory workflow wrapper; see `src/lib/memory-workflow.ts`). */
  walrusMemory?: WalrusMemoryProof;
  /** Prior encrypted memories that were recalled and reused this run. */
  reusedMemories?: Array<{
    id: string;
    topic: string;
    walrusBlobId: string;
    contentHash: string;
    createdAt: string;
  }>;
};

export type ZeroGStorageStatus = "prepared" | "uploaded" | "skipped" | "failed";

export type ZeroGChainStatus =
  | "prepared"
  | "pending"
  | "anchored"
  | "skipped"
  | "failed";

export type Erc8004ReputationStatus =
  | "prepared"
  | "pending"
  | "anchored"
  | "skipped"
  | "failed";

export type ZeroGComputeStatus = "used" | "skipped" | "failed";

export type ZeroGStorageProof = {
  status: ZeroGStorageStatus;
  evidenceUri: string;
  rootHash?: string;
  txHash?: string;
  explorerUrl?: string;
  indexerRpc?: string;
  error?: string;
};

export type ZeroGChainProof = {
  status: ZeroGChainStatus;
  briefHash: string;
  chain?: string;
  decisionHash?: string;
  decisionId?: string;
  agentId?: string;
  signalType?: string;
  txHash?: string;
  explorerUrl?: string;
  registryAddress?: string;
  chainId?: number;
  chainName?: string;
  nativeSymbol?: string;
  reputation?: Erc8004ReputationProof;
  error?: string;
};

export type Erc8004ReputationProof = {
  status: Erc8004ReputationStatus;
  agentId: string;
  chainId: number;
  registryAddress?: string;
  txHash?: string;
  explorerUrl?: string;
  value?: string;
  valueDecimals?: number;
  tag1?: string;
  tag2?: string;
  error?: string;
};

export type ZeroGComputeProof = {
  status: ZeroGComputeStatus;
  model?: string;
  requestedModel?: string;
  usedModel?: string;
  modelHonored?: boolean;
  fallbackFrom?: string;
  endpoint?: string;
  chatId?: string;
  requestId?: string;
  provider?: string;
  teeVerified?: boolean | null;
  teeVerification?: ZeroGTeeVerification;
  usage?: ZeroGTokenUsage;
  billing?: ZeroGComputeBilling;
  error?: string;
};

export type ZeroGProof = {
  storage: ZeroGStorageProof;
  chain: ZeroGChainProof;
  compute?: ZeroGComputeProof;
};

export type ZeroGTokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  maxTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

export type ZeroGComputeBilling = {
  inputCostNeuron?: string;
  outputCostNeuron?: string;
  totalCostNeuron?: string;
  source: "router-trace" | "token-estimate" | "reserved-estimate";
};

export type ZeroGTeeVerification = {
  requested: boolean;
  routerVerified?: boolean | null;
  independentVerified?: boolean | null;
  status:
    | "not-requested"
    | "router-verified"
    | "router-unverified"
    | "router-missing"
    | "independent-verified"
    | "independent-failed"
    | "independent-unavailable"
    | "independent-error";
  chatId?: string;
  error?: string;
};

export type ModelUsageReceipt = {
  wallet: string;
  chain?: string;
  chainId?: number;
  chainName?: string;
  nativeSymbol?: string;
  model: string;
  requestId?: string;
  provider?: string;
  teeVerified?: boolean | null;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  maxTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  promptPriceNeuron: string;
  completionPriceNeuron: string;
  reservedNeuron: string;
  rawCostNeuron: string;
  markupBps: number;
  markupNeuron: string;
  chargedNeuron: string;
  releasedNeuron: string;
  balanceBefore: string;
  balanceAfter: string;
  costSource: "router-trace" | "token-estimate" | "reserved-estimate";
  totalCostNeuron?: string;
  meter: UsageMeter;
  status: "charged" | "estimated" | "refunded" | "failed_after_charge";
};
