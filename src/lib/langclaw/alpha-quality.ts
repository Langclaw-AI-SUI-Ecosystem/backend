import { isProductChainId } from "../chain-config";
import {
  isDirectProviderIssue,
  isUsableDirectProviderResult,
} from "../onchain-tools/evidence";
import type {
  OnChainToolFinalPayload,
  OnChainToolResult,
} from "../onchain-tools/types";
import type {
  AlphaFalsePositiveCheck,
  AlphaSignal,
  AlphaSignalNotification,
  AlphaSignalQuality,
  DiscoverSignals,
  ProviderError,
  ProviderTraceEntry,
  ResearchReport,
  ResearchReportConfidence,
  SourceCard,
  WorkflowChainContext,
  ZeroGProof,
} from "./types";

type BuildAlphaSignalInput = {
  chainContext: WorkflowChainContext;
  errors?: ProviderError[];
  generatedAt?: string;
  onChain?: OnChainToolFinalPayload;
  providerTrace?: ProviderTraceEntry[];
  proof?: ZeroGProof;
  report?: ResearchReport;
  signals: DiscoverSignals;
  sources?: SourceCard[];
  topic: string;
};

const confidenceScore: Record<ResearchReportConfidence, number> = {
  high: 45,
  medium: 32,
  low: 18,
  insufficient: 0,
};

const alphaAlertEnabledValue = "true";

export function buildAlphaSignal(input: BuildAlphaSignalInput): AlphaSignal {
  const generatedAt = input.generatedAt || new Date().toISOString();
  const quality = buildAlphaSignalQuality(input);

  return {
    alertEligible: quality.alertEligible,
    generatedAt,
    quality,
    schema: "langclaw.alpha-signal.v1",
    signalType: input.report?.kind ?? "unknown",
  };
}

export function buildAlphaSignalQuality({
  chainContext,
  errors = [],
  generatedAt,
  onChain,
  providerTrace = [],
  proof,
  report,
  signals,
  sources = [],
  topic,
}: BuildAlphaSignalInput): AlphaSignalQuality {
  const tools = onChain?.tools ?? [];
  const usableDirect = tools.filter(isUsableDirectProviderResult);
  const directIssues = tools.filter(isDirectProviderIssue);
  const providers = new Set<string>([
    ...signals.social.providers,
    ...signals.onchain.providers,
    ...signals.combined.providers,
    ...providerTrace.map((entry) => entry.provider),
    ...tools.map((tool) => tool.provider),
  ]);
  const sourceIds = readSourceIds({ report, signals, sources });
  const toolIds = readToolIds({ report, signals, tools });
  const directWalletFlow = tools.some(hasDirectSmartMoneyEvidence);
  const sourceCoverage = {
    directWalletFlow,
    onchain:
      Boolean(onChain) &&
      (signals.onchain.status === "success" ||
        signals.onchain.status === "partial"),
    proof: hasUsableProof(proof),
    providerCount: providers.size,
    social:
      signals.social.status === "success" ||
      signals.social.status === "partial",
  };
  const evidenceCount =
    sourceIds.size +
    toolIds.size +
    usableDirect.length +
    Math.min(report?.entities.length ?? 0, 5);
  const reportText = buildReportText({ onChain, report });
  const failedProviderCount =
    errors.length + providerTrace.filter((entry) => entry.status === "failed").length;
  const externalFallback = readExternalFallbackStatus({
    onChain,
    reportText,
    sourceCoverage,
  });
  const checks = buildFalsePositiveChecks({
    chainContext,
    directIssues,
    directWalletFlow,
    externalFallback,
    failedProviderCount,
    onChain,
    proof,
    report,
    reportText,
    sourceCoverage,
  });
  const score = scoreAlphaSignal({
    checks,
    evidenceCount,
    report,
    sourceCoverage,
  });
  const blockingFailures = checks.filter((check) => check.status === "fail");
  const label = labelScore(score);
  const alertEligible =
    score >= 70 &&
    evidenceCount >= 2 &&
    sourceCoverage.onchain &&
    isProductChainId(chainContext.productChain.id) &&
    blockingFailures.length === 0;
  const reasons = buildReasons({
    alertEligible,
    blockingFailures,
    checks,
    evidenceCount,
    label,
    score,
    sourceCoverage,
  });

  return {
    alertEligible,
    evidenceCount,
    falsePositiveChecks: checks,
    freshnessMinutes: readFreshnessMinutes(generatedAt || report?.asOfUtc),
    label,
    reasons,
    score,
    sourceCoverage,
  };
}

export function isAlphaAlertsEnabled() {
  return process.env.LANGCLAW_ALPHA_ALERTS_ENABLED === alphaAlertEnabledValue;
}

export function readAlphaSignalFromPayload(value: unknown): AlphaSignal | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const alphaSignal = record.alphaSignal;

  if (!alphaSignal || typeof alphaSignal !== "object") {
    return undefined;
  }

  const candidate = alphaSignal as Partial<AlphaSignal>;

  if (candidate.schema !== "langclaw.alpha-signal.v1" || !candidate.quality) {
    return undefined;
  }

  return candidate as AlphaSignal;
}

export function withAlphaSignalNotification(
  alphaSignal: AlphaSignal,
  notification: AlphaSignalNotification
): AlphaSignal {
  return {
    ...alphaSignal,
    notification,
  };
}

function readSourceIds({
  report,
  signals,
  sources,
}: {
  report?: ResearchReport;
  signals: DiscoverSignals;
  sources: SourceCard[];
}) {
  const ids = new Set<string>();

  for (const source of sources) {
    ids.add(source.id);
  }

  for (const section of Object.values(signals)) {
    for (const sourceId of section.sourceIds) {
      ids.add(sourceId);
    }
  }

  for (const entity of report?.entities ?? []) {
    for (const sourceId of entity.sourceIds) {
      ids.add(sourceId);
    }
  }

  for (const section of report?.sections ?? []) {
    for (const sourceId of section.sourceIds) {
      ids.add(sourceId);
    }
  }

  return ids;
}

function readToolIds({
  report,
  signals,
  tools,
}: {
  report?: ResearchReport;
  signals: DiscoverSignals;
  tools: OnChainToolResult[];
}) {
  const ids = new Set<string>();

  for (const tool of tools) {
    ids.add(tool.commandId);
  }

  for (const section of Object.values(signals)) {
    for (const toolId of section.toolIds) {
      ids.add(toolId);
    }
  }

  for (const entity of report?.entities ?? []) {
    for (const toolId of entity.toolIds) {
      ids.add(toolId);
    }
  }

  for (const section of report?.sections ?? []) {
    for (const toolId of section.toolIds) {
      ids.add(toolId);
    }
  }

  return ids;
}

function hasDirectSmartMoneyEvidence(tool: OnChainToolResult) {
  return tool.domain === "smart_money" && isUsableDirectProviderResult(tool);
}

function hasUsableProof(proof?: ZeroGProof) {
  if (!proof) {
    return false;
  }

  return (
    proof.chain.status === "anchored" ||
    proof.chain.status === "pending" ||
    proof.chain.status === "prepared" ||
    proof.storage.status === "prepared" ||
    proof.storage.status === "uploaded"
  );
}

function buildFalsePositiveChecks({
  chainContext,
  directIssues,
  directWalletFlow,
  externalFallback,
  failedProviderCount,
  onChain,
  proof,
  report,
  reportText,
  sourceCoverage,
}: {
  chainContext: WorkflowChainContext;
  directIssues: OnChainToolResult[];
  directWalletFlow: boolean;
  externalFallback: ReturnType<typeof readExternalFallbackStatus>;
  failedProviderCount: number;
  onChain?: OnChainToolFinalPayload;
  proof?: ZeroGProof;
  report?: ResearchReport;
  reportText: string;
  sourceCoverage: AlphaSignalQuality["sourceCoverage"];
}): AlphaFalsePositiveCheck[] {
  const checks: AlphaFalsePositiveCheck[] = [];

  checks.push({
    id: "sui_product_chain",
    label: "Sui product chain",
    reason:
      isProductChainId(chainContext.productChain.id)
        ? "The decision is scoped to Sui."
        : `The product chain is ${chainContext.productChain.name}, not Sui.`,
    status: isProductChainId(chainContext.productChain.id) ? "pass" : "fail",
  });
  checks.push({
    id: "onchain_core_source",
    label: "On-chain data",
    reason: sourceCoverage.onchain
      ? "The signal uses on-chain enrichment as a core data source."
      : "The signal does not have usable on-chain enrichment.",
    status: sourceCoverage.onchain ? "pass" : "fail",
  });
  checks.push({
    id: "social_only_guard",
    label: "Social-only guard",
    reason:
      sourceCoverage.social && !sourceCoverage.onchain
        ? "Social context exists, but on-chain confirmation is missing."
        : "The signal is not social-only.",
    status: sourceCoverage.social && !sourceCoverage.onchain ? "fail" : "pass",
  });

  if (report?.kind === "smart-money") {
    checks.push({
      id: "direct_wallet_flow",
      label: "Direct wallet-flow evidence",
      reason: directWalletFlow
        ? "Smart-money claim has direct row-level wallet-flow evidence."
        : "Smart-money claim lacks direct row-level wallet-flow evidence.",
      status: directWalletFlow ? "pass" : "fail",
    });
  } else {
    checks.push({
      id: "direct_wallet_flow",
      label: "Direct wallet-flow evidence",
      reason:
        "Direct wallet-flow is required only for smart-money claims. This report uses a different alpha type.",
      status: directWalletFlow ? "pass" : "warn",
    });
  }

  checks.push({
    id: "external_low_confidence_guard",
    label: "External fallback guard",
    reason: externalFallback.reason,
    status: externalFallback.status,
  });
  checks.push({
    id: "cex_deposit_guard",
    label: "CEX deposit guard",
    reason: hasCexDepositOnlyText(reportText)
      ? "CEX deposit-only evidence is not treated as accumulation."
      : "The report does not promote CEX deposit-only rows as accumulation.",
    status: hasCexDepositOnlyText(reportText) ? "fail" : "pass",
  });
  checks.push({
    id: "provider_gap_guard",
    label: "Provider gap guard",
    reason:
      failedProviderCount || directIssues.length
        ? `${failedProviderCount + directIssues.length} provider gap(s) reduce confidence.`
        : "No blocking provider gap was detected.",
    status: failedProviderCount || directIssues.length ? "warn" : "pass",
  });
  checks.push({
    id: "proof_status",
    label: "Decision proof status",
    reason: describeProofStatus(proof),
    status: scoreProofStatus(proof),
  });

  if (onChain?.plan.analysisSource === "prompt" && onChain.plan.chain !== "sui") {
    checks.push({
      id: "analysis_chain_scope",
      label: "Analysis chain scope",
      reason: `The analysis chain is ${onChain.plan.chainName}, so it should not be submitted as Sui alpha.`,
      status: "fail",
    });
  }

  return checks;
}

function scoreAlphaSignal({
  checks,
  evidenceCount,
  report,
  sourceCoverage,
}: {
  checks: AlphaFalsePositiveCheck[];
  evidenceCount: number;
  report?: ResearchReport;
  sourceCoverage: AlphaSignalQuality["sourceCoverage"];
}) {
  let score = confidenceScore[report?.confidence ?? "insufficient"];

  if (sourceCoverage.onchain) {
    score += 20;
  }

  if (sourceCoverage.social) {
    score += 10;
  }

  if (sourceCoverage.directWalletFlow) {
    score += 15;
  }

  if (sourceCoverage.proof) {
    score += 8;
  }

  score += Math.min(evidenceCount * 4, 12);

  for (const check of checks) {
    if (check.status === "fail") {
      score -= 25;
    } else if (check.status === "warn") {
      score -= 7;
    }
  }

  return clamp(score, 0, 100);
}

function labelScore(score: number): AlphaSignalQuality["label"] {
  if (score >= 80) {
    return "high";
  }

  if (score >= 60) {
    return "medium";
  }

  if (score >= 35) {
    return "low";
  }

  return "insufficient";
}

function buildReasons({
  alertEligible,
  blockingFailures,
  checks,
  evidenceCount,
  label,
  score,
  sourceCoverage,
}: {
  alertEligible: boolean;
  blockingFailures: AlphaFalsePositiveCheck[];
  checks: AlphaFalsePositiveCheck[];
  evidenceCount: number;
  label: AlphaSignalQuality["label"];
  score: number;
  sourceCoverage: AlphaSignalQuality["sourceCoverage"];
}) {
  if (!alertEligible) {
    const failures = blockingFailures.map((check) => check.reason);

    if (failures.length) {
      return failures;
    }

    return [
      `Quality score ${score}/100 is ${label}. At least 70/100 and two evidence items are required for alerting.`,
    ];
  }

  return [
    `Quality score ${score}/100 is ${label}.`,
    `${evidenceCount} evidence item(s) passed the alert gate.`,
    sourceCoverage.directWalletFlow
      ? "Direct wallet-flow evidence supports the alpha claim."
      : "The alpha claim is not a smart-money wallet-flow claim.",
    `${checks.filter((check) => check.status === "pass").length} false positive check(s) passed.`,
  ];
}

function buildReportText({
  onChain,
  report,
}: {
  onChain?: OnChainToolFinalPayload;
  report?: ResearchReport;
}) {
  return [
    report?.title,
    report?.executiveSummary,
    report?.bottomLine,
    ...(report?.caveats ?? []),
    ...(report?.recommendations ?? []),
    ...(report?.sections.map((section) => section.markdown) ?? []),
    onChain?.answer,
    onChain?.caveat,
    onChain?.recommendation,
    ...(onChain?.bullets ?? []),
    ...(onChain?.tools.map((tool) => tool.summary) ?? []),
  ]
    .filter(Boolean)
    .join("\n");
}

function hasCexDepositOnlyText(text: string) {
  return (
    /\bcex deposit/i.test(text) &&
    !/\b(withdrawal|outflow|retention|wallet-flow|confirmed smart-money)\b/i.test(
      text
    )
  );
}

function readExternalFallbackStatus({
  onChain,
  reportText,
  sourceCoverage,
}: {
  onChain?: OnChainToolFinalPayload;
  reportText: string;
  sourceCoverage: AlphaSignalQuality["sourceCoverage"];
}): Pick<AlphaFalsePositiveCheck, "reason" | "status"> {
  const selectedExternalFallback = onChain?.tools.some((tool) => {
    const data = asRecord(tool.data);
    const routeDebug = asRecord(data?.routeDebug);

    return routeDebug?.selectedRoute === "dune.smart_money_sql.external_token_signal";
  });
  const mentionsExternalContext = /external low-confidence/i.test(reportText);

  if (selectedExternalFallback) {
    return {
      reason:
        "External token fallback became the selected smart-money route, so it cannot trigger a Sui alpha alert.",
      status: "fail",
    };
  }

  if (mentionsExternalContext && sourceCoverage.directWalletFlow) {
    return {
      reason:
        "External token context was included only as labeled supplemental context while direct wallet-flow evidence was present.",
      status: "warn",
    };
  }

  if (mentionsExternalContext) {
    return {
      reason: "The run used external low-confidence context without direct wallet-flow support.",
      status: "fail",
    };
  }

  return {
    reason: "No external low-confidence fallback was promoted as Sui alpha.",
    status: "pass",
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function describeProofStatus(proof?: ZeroGProof) {
  if (!proof) {
    return "Proof is not attached yet. The workflow can still compute pre-proof quality.";
  }

  if (proof.chain.status === "anchored") {
    return "The decision proof is anchored on-chain.";
  }

  if (proof.chain.status === "prepared" || proof.chain.status === "pending") {
    return `The decision proof is ${proof.chain.status}. This is acceptable for response compatibility but weaker for live demo evidence.`;
  }

  return `The decision proof is ${proof.chain.status}.`;
}

function scoreProofStatus(proof?: ZeroGProof): AlphaFalsePositiveCheck["status"] {
  if (!proof) {
    return "warn";
  }

  if (proof.chain.status === "anchored") {
    return "pass";
  }

  if (proof.chain.status === "prepared" || proof.chain.status === "pending") {
    return "warn";
  }

  return "fail";
}

function readFreshnessMinutes(value?: string) {
  if (!value) {
    return undefined;
  }

  const timestamp = Date.parse(value);

  if (Number.isNaN(timestamp)) {
    return undefined;
  }

  return Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
