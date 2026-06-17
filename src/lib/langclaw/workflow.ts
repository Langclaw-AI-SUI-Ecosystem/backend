import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { synthesizeFinalAnswerWithOpenClaw } from "./openclaw-ai";
import { synthesizeFinalAnswerWithOpenAI } from "./openai-synthesis";
import { applyFinalAnswerGuardrails } from "./final-answer-guardrails";
import { buildAlphaSignal } from "./alpha-quality";
import {
  createRunId,
  createStepSessionId,
  runEvidenceAgentStep,
  runPlannerAgentStep,
  runTrendAgentStep,
  runVerifierAgentStep,
  shouldRunOpenClawWorkflow,
} from "./openclaw-workflow";
import { runProviderDiscovery } from "./providers";
import { persistLangclawProof } from "./proof";
import { buildWorkflowResearchReport } from "./report";
import { resolveProductChain } from "../chain-config";
import { detectUnsupportedOnChainChain, inferAnalysisChain } from "../onchain-tools/chains";
import {
  isDirectProviderIssue,
  isUsableDirectProviderResult,
} from "../onchain-tools/evidence";
import { summarizePlan } from "../onchain-tools/planner";
import { runOnChainToolWorkflow } from "../onchain-tools/workflow";
import type {
  AgentOutputs,
  DiscoverPayload,
  DiscoverSignalSection,
  DiscoverSignals,
  FinalAnswer,
  FinalAnswerMeta,
  FinalConclusion,
  OrchestrationRuntime,
  OrchestrationStep,
  ProviderError,
  ProviderTraceEntry,
  ResearchReport,
  SourceCard,
  StepExecution,
  WorkflowChainContext,
  WorkflowProgressEvent,
  ZeroGChainProof,
  ZeroGComputeProof,
  ZeroGProof,
  ZeroGStorageProof,
} from "./types";
import type {
  OnChainContextMessage,
  OnChainPlanSummary,
  OnChainToolCallEvent,
  OnChainToolFinalPayload,
  OnChainToolResult,
} from "../onchain-tools/types";

const execFileAsync = promisify(execFile);

type OpenClawProbe = {
  available: boolean;
  summary: string;
};

type WorkflowStepDefinition = {
  stepId: string;
  agent: string;
  skill: string;
  pendingSummary: string;
};

type WorkflowOptions = {
  chain?: string;
  context?: OnChainContextMessage[];
  onEvent?: (event: WorkflowProgressEvent) => void | Promise<void>;
  onToolCall?: (event: OnChainToolCallEvent) => void | Promise<void>;
  onToolPlan?: (plan: OnChainPlanSummary) => void | Promise<void>;
  onToolResult?: (event: OnChainToolResult) => void | Promise<void>;
  requestedModel?: unknown;
  signal?: AbortSignal;
};

type WorkflowFinalAnswerSynthesisInput = {
  topic: string;
  sources: SourceCard[];
  errors: ProviderError[];
  providerTrace?: ProviderTraceEntry[];
  runtime: OrchestrationRuntime;
  steps: OrchestrationStep[];
  agentOutputs?: AgentOutputs;
  signals: DiscoverSignals;
  report?: ResearchReport;
  onChain?: OnChainToolFinalPayload;
  onChainSkippedReason?: string;
  requestedModel?: unknown;
  preferOpenClaw: boolean;
  sessionId: string;
};

type WorkflowFinalAnswerSynthesisResult = {
  finalAnswer?: FinalAnswer;
  meta: FinalAnswerMeta;
  compute: ZeroGComputeProof;
};

type TraceOverrides = Record<string, Partial<OrchestrationStep>>;

const workflowSteps: WorkflowStepDefinition[] = [
  {
    stepId: "runtime",
    agent: "OpenClaw Runtime Adapter",
    skill: "openclaw/runtime-adapter",
    pendingSummary: "Waiting for OpenClaw runtime detection.",
  },
  {
    stepId: "planner",
    agent: "Planner Agent",
    skill: "openclaw/skills/planner.md",
    pendingSummary: "Waiting to create the provider search plan.",
  },
  {
    stepId: "discovery",
    agent: "Discovery Agent",
    skill: "openclaw/skills/discovery.md",
    pendingSummary: "Waiting to collect live market, social, builder, and reference signals.",
  },
  {
    stepId: "source-normalizer",
    agent: "Source Normalizer Agent",
    skill: "openclaw/skills/source-normalizer.md",
    pendingSummary: "Waiting to normalize source cards.",
  },
  {
    stepId: "trend-scorer",
    agent: "Trend Scorer Agent",
    skill: "openclaw/skills/trend-scorer.md",
    pendingSummary: "Waiting to score repeated patterns.",
  },
  {
    stepId: "evidence-packager",
    agent: "Evidence Packager Agent",
    skill: "openclaw/skills/evidence-packager.md",
    pendingSummary: "Waiting to prepare the evidence bundle.",
  },
  {
    stepId: "verifier",
    agent: "Verifier Agent",
    skill: "openclaw/skills/verifier.md",
    pendingSummary: "Waiting to prepare verification fields.",
  },
  {
    stepId: "onchain-enrichment",
    agent: "On-chain Enrichment",
    skill: "onchain-tools/workflow",
    pendingSummary: "Waiting to run the on-chain enrichment workflow.",
  },
  {
    stepId: "final-conclusion",
    agent: "Final Conclusion Agent",
    skill: "openclaw/skills/final-conclusion.md",
    pendingSummary: "Waiting to write the final answer.",
  },
  {
    stepId: "evidence-bundle",
    agent: "Evidence Bundle Commit",
    skill: "evidence/storage",
    pendingSummary: "Waiting to prepare the evidence bundle.",
  },
  {
    stepId: "chain-proof",
    agent: "Sui Decision Anchor",
    skill: "move/langclaw_memory/sources/decision_registry.move",
    pendingSummary: "Waiting to record the agent decision proof on Sui.",
  },
];

export async function runLangclawWorkflow(
  topic: string,
  options: WorkflowOptions = {}
): Promise<DiscoverPayload> {
  const chain = resolveProductChain(options.chain);
  const runId = createRunId();
  const traceOverrides: TraceOverrides = {};

  for (const step of workflowSteps) {
    await emitProgress(options, step, "pending", step.pendingSummary);
  }

  await emitProgress(
    options,
    workflowSteps[0],
    "running",
    "Checking whether OpenClaw CLI is available."
  );
  const openClawProbe = await resolveOpenClawRuntime();
  const runtime: OrchestrationRuntime = openClawProbe.available
    ? "openclaw"
    : "typescript";
  traceOverrides.runtime = {
    execution: openClawProbe.available ? "typescript-tool" : "deterministic-fallback",
    error: openClawProbe.available ? undefined : openClawProbe.summary,
  };
  await emitProgress(options, workflowSteps[0], "complete", openClawProbe.summary);
  const openClawWorkflowEnabled = shouldRunOpenClawWorkflow(openClawProbe.available);
  const preferOpenClawFinalAnswer =
    openClawWorkflowEnabled && process.env.OPENCLAW_AI_SYNTHESIS !== "false";

  await emitProgress(
    options,
    workflowSteps[1],
    "running",
    openClawWorkflowEnabled
      ? `Planner Agent is running through OpenClaw for "${topic}".`
      : `Planner Agent is using deterministic fallback for "${topic}".`
  );
  const plannerStep = await runPlannerAgentStep(
    topic,
    openClawWorkflowEnabled,
    runId
  );
  traceOverrides.planner = traceFromMeta(
    plannerStep.output.summary,
    plannerStep.meta
  );
  await emitProgress(
    options,
    workflowSteps[1],
    "complete",
    plannerStep.output.summary,
    plannerStep.meta
  );

  await emitProgress(
    options,
    workflowSteps[2],
    "running",
    "Collecting live source cards from premium and supporting research providers."
  );
  const providerResult = await runProviderDiscovery(topic, { chain: chain.id });
  const sources = providerResult.sources;
  const errors = providerResult.errors;
  const providerTrace = providerResult.providerTrace;
  const providerSummary = summarizeProviders(sources);
  const failureSummary = summarizeFailures(errors);
  const socialSignals = buildSocialSignals({
    chain: chain.id,
    errors,
    sources,
  });
  traceOverrides.discovery = {
    execution: "typescript-tool",
  };
  await emitProgress(
    options,
    workflowSteps[2],
    sources.length ? "complete" : "failed",
    `Collected ${sources.length} live source cards from ${providerSummary}.${failureSummary} Social evidence status: ${socialSignals.status}.`
  );

  await emitProgress(
    options,
    workflowSteps[3],
    "running",
    "Normalizing discovered items into the SourceCard evidence model."
  );
  traceOverrides["source-normalizer"] = {
    execution: "typescript-tool",
  };
  await emitProgress(
    options,
    workflowSteps[3],
    sources.length ? "complete" : "failed",
    "Normalized discovered items into SourceCard records with provider, URL, excerpt, date, author, and metrics."
  );

  await emitProgress(
    options,
    workflowSteps[4],
    "running",
    openClawWorkflowEnabled
      ? "Trend Scorer Agent is ranking source patterns through OpenClaw."
      : "Trend Scorer Agent is using deterministic fallback scoring."
  );
  const trendStep = await runTrendAgentStep(
    topic,
    sources,
    errors,
    plannerStep.output,
    openClawWorkflowEnabled,
    runId
  );
  traceOverrides["trend-scorer"] = traceFromMeta(
    trendStep.output.summary,
    trendStep.meta
  );
  await emitProgress(
    options,
    workflowSteps[4],
    sources.length ? "complete" : "failed",
    trendStep.output.summary,
    trendStep.meta
  );

  await emitProgress(
    options,
    workflowSteps[5],
    "running",
    openClawWorkflowEnabled
      ? "Evidence Packager Agent is preparing claim maps through OpenClaw."
      : "Evidence Packager Agent is using deterministic fallback packaging."
  );
  const evidenceStep = await runEvidenceAgentStep(
    topic,
    sources,
    errors,
    trendStep.output,
    openClawWorkflowEnabled,
    runId
  );
  traceOverrides["evidence-packager"] = traceFromMeta(
    evidenceStep.output.bundleSummary,
    evidenceStep.meta
  );
  await emitProgress(
    options,
    workflowSteps[5],
    sources.length ? "complete" : "failed",
    evidenceStep.output.bundleSummary,
    evidenceStep.meta
  );

  await emitProgress(
    options,
    workflowSteps[6],
    "running",
    openClawWorkflowEnabled
      ? "Verifier Agent is checking claim support through OpenClaw."
      : "Verifier Agent is using deterministic fallback checks."
  );
  const verifierStep = await runVerifierAgentStep(
    topic,
    sources,
    trendStep.output,
    evidenceStep.output,
    openClawWorkflowEnabled,
    runId
  );
  traceOverrides.verifier = traceFromMeta(
    verifierStep.output.verificationSummary,
    verifierStep.meta
  );
  await emitProgress(
    options,
    workflowSteps[6],
    sources.length ? "complete" : "failed",
    verifierStep.output.verificationSummary,
    verifierStep.meta
  );

  await emitProgress(
    options,
    workflowSteps[7],
    "running",
    "Running the on-chain enrichment workflow."
  );
  const onChainEnrichment = await maybeRunOnChainEnrichment({
    chain: chain.id,
    context: options.context ?? [],
    message: topic,
    onToolCall: options.onToolCall,
    onToolPlan: options.onToolPlan,
    onToolResult: options.onToolResult,
    signal: options.signal,
  });
  const chainContext = buildWorkflowChainContext({
    onChain: onChainEnrichment.payload,
    productChain: chain,
    topic,
  });
  const signals = buildDiscoverSignals({
    chain: chain.id,
    errors,
    onChain: onChainEnrichment.payload,
    onChainSkippedReason: onChainEnrichment.skippedReason,
    sources,
  });
  const report = buildWorkflowResearchReport({
    errors,
    generatedAt: new Date().toISOString(),
    onChain: onChainEnrichment.payload,
    onChainSkippedReason: onChainEnrichment.skippedReason,
    providerTrace,
    signals,
    sources,
    topic,
  });
  const onChainProgressSummary = onChainEnrichment.payload
    ? `On-chain enrichment completed with ${onChainEnrichment.payload.tools.length} tool result(s) on ${onChainEnrichment.payload.plan.chain}. On-chain signal status: ${signals.onchain.status}. Combined signal status: ${signals.combined.status}.`
    : onChainEnrichment.skippedReason ||
      "On-chain enrichment was skipped for this research request.";
  traceOverrides["onchain-enrichment"] = {
    execution: "typescript-tool",
    status: "complete",
    summary: onChainProgressSummary,
  };
  await emitProgress(
    options,
    workflowSteps[7],
    "complete",
    onChainProgressSummary
  );

  await emitProgress(
    options,
    workflowSteps[8],
    "running",
    summarizeFinalAnswerKickoff(preferOpenClawFinalAnswer, signals)
  );
  const agentOutputs: AgentOutputs = {
    planner: plannerStep.output,
    trend: trendStep.output,
    evidence: evidenceStep.output,
    verifier: verifierStep.output,
  };
  const finalConclusion = buildFinalConclusion(
    topic,
    sources,
    errors,
    runtime,
    agentOutputs
  );
  const traceBeforeAnswer = buildTraceSteps(
    topic,
    sources,
    errors,
    openClawProbe,
    traceOverrides
  );
  const fallbackAnswer = buildFinalAnswer(
    topic,
    sources,
    errors,
    runtime,
    signals,
    onChainEnrichment.payload,
    onChainEnrichment.skippedReason,
    providerTrace,
    report
  );
  const computeSynthesis = await synthesizeWorkflowFinalAnswer({
    topic,
    sources,
    errors,
    providerTrace,
    runtime,
    steps: traceBeforeAnswer,
    agentOutputs,
    signals,
    report,
    onChain: onChainEnrichment.payload,
    onChainSkippedReason: onChainEnrichment.skippedReason,
    requestedModel: options.requestedModel,
    preferOpenClaw: preferOpenClawFinalAnswer,
    sessionId: createStepSessionId(runId, "final-conclusion"),
  });
  const synthesis = computeSynthesis;
  const finalAnswerMeta = synthesis.meta;
  traceOverrides["final-conclusion"] = traceFromFinalAnswerMeta(
    summarizeFinalAnswerStep(finalAnswerMeta, sources.length),
    finalAnswerMeta
  );
  const finalAnswer = synthesis.finalAnswer
    ? synthesis.finalAnswer
    : withFallbackCaveat(fallbackAnswer, finalAnswerMeta);
  await emitProgress(
    options,
    workflowSteps[8],
    "complete",
    summarizeFinalAnswerProgress(finalAnswerMeta, Boolean(synthesis.finalAnswer)),
    finalAnswerMeta
  );

  await emitProgress(
    options,
    workflowSteps[9],
    "running",
    `Building the canonical evidence bundle for source-backed ${chain.name} alpha proof.`
  );
  await emitProgress(
    options,
    workflowSteps[10],
    "running",
    `Preparing the agent decision hash and submitting it to LangclawRegistry on ${chain.name} when enabled.`
  );
  const generatedAt = new Date().toISOString();
  const preProofAlphaSignal = buildAlphaSignal({
    chainContext,
    errors,
    generatedAt,
    onChain: onChainEnrichment.payload,
    providerTrace,
    report,
    signals,
    sources,
    topic,
  });
  const proof = await persistLangclawProof({
    chain: chain.id,
    runId,
    topic,
    generatedAt,
    chainContext,
    sources,
    errors,
    signals,
    report,
    steps: buildTraceSteps(
      topic,
      sources,
      errors,
      openClawProbe,
      traceOverrides,
      finalAnswerMeta
    ),
    finalConclusion,
    finalAnswer,
    agentOutputs,
    alphaSignal: preProofAlphaSignal,
  });
  const proofWithCompute = {
    ...proof,
    compute: computeSynthesis.compute,
  };
  const alphaSignal = buildAlphaSignal({
    chainContext,
    errors,
    generatedAt,
    onChain: onChainEnrichment.payload,
    providerTrace,
    proof: proofWithCompute,
    report,
    signals,
    sources,
    topic,
  });

  updateAgentOutputsWithProof(agentOutputs, proof);
  traceOverrides["evidence-bundle"] = traceFromStorageProof(proof.storage);
  traceOverrides["chain-proof"] = traceFromChainProof(proof.chain);
  await emitProgress(
    options,
    workflowSteps[9],
    proof.storage.status === "failed" ? "failed" : "complete",
    summarizeStorageProof(proof.storage),
    proofMetaFromStorage(proof.storage)
  );
  await emitProgress(
    options,
    workflowSteps[10],
    proof.chain.status === "failed" ? "failed" : "complete",
    summarizeChainProof(proof.chain),
    proofMetaFromChain(proof.chain)
  );

  return {
    topic,
    generatedAt,
    chainContext,
    sources,
    errors,
    providerTrace,
    signals,
    report,
    onChain: onChainEnrichment.payload,
    onChainSkippedReason: onChainEnrichment.skippedReason,
    orchestration: {
      runtime,
      steps: buildTraceSteps(
        topic,
        sources,
        errors,
        openClawProbe,
        traceOverrides,
        finalAnswerMeta
      ),
    },
    finalConclusion,
    finalAnswer,
    finalAnswerMeta,
    agentOutputs,
    proof: proofWithCompute,
    zeroG: proofWithCompute,
    alphaSignal,
  };
}

export async function synthesizeWorkflowFinalAnswer(
  input: WorkflowFinalAnswerSynthesisInput,
  dependencies: {
    openClaw?: typeof synthesizeFinalAnswerWithOpenClaw;
    openAI?: typeof synthesizeFinalAnswerWithOpenAI;
  } = {}
): Promise<WorkflowFinalAnswerSynthesisResult> {
  const openClawSynthesis =
    dependencies.openClaw ?? synthesizeFinalAnswerWithOpenClaw;
  const openAISynthesis =
    dependencies.openAI ?? synthesizeFinalAnswerWithOpenAI;
  let openClawResult:
    | Awaited<ReturnType<typeof synthesizeFinalAnswerWithOpenClaw>>
    | undefined;

  if (input.preferOpenClaw) {
    openClawResult = await openClawSynthesis({
      topic: input.topic,
      sources: input.sources,
      errors: input.errors,
      providerTrace: input.providerTrace,
      runtime: input.runtime,
      steps: input.steps,
      agentOutputs: input.agentOutputs,
      signals: input.signals,
      report: input.report,
      onChain: input.onChain,
      onChainSkippedReason: input.onChainSkippedReason,
      sessionId: input.sessionId,
    });

    if (openClawResult.finalAnswer) {
      return {
        finalAnswer: openClawResult.finalAnswer,
        meta: openClawResult.meta,
        compute: buildOpenClawComputeProof(openClawResult.meta),
      };
    }
  }

  const openAIResult = await openAISynthesis({
    topic: input.topic,
    sources: input.sources,
    errors: input.errors,
    providerTrace: input.providerTrace,
    runtime: input.runtime,
    steps: input.steps,
    agentOutputs: input.agentOutputs,
    signals: input.signals,
    report: input.report,
    onChain: input.onChain,
    onChainSkippedReason: input.onChainSkippedReason,
    requestedModel: input.requestedModel,
  });

  if (openClawResult?.meta.error && openAIResult.meta.error) {
    return {
      ...openAIResult,
      meta: {
        ...openAIResult.meta,
        error: combineSynthesisErrors(
          openClawResult.meta.error,
          openAIResult.meta.error
        ),
      },
    };
  }

  return openAIResult;
}

async function resolveOpenClawRuntime(): Promise<OpenClawProbe> {
  if (process.env.OPENCLAW_ENABLED !== "true") {
    return {
      available: false,
      summary:
        "OPENCLAW_ENABLED is false. Langclaw used the built-in TypeScript OpenClaw-compatible runtime.",
    };
  }

  const cliPath = process.env.OPENCLAW_CLI_PATH || "openclaw";
  const version = await runOpenClawCommand(cliPath, ["--version"]);

  if (version.available) {
    return {
      available: true,
      summary: `OpenClaw CLI responded through ${cliPath}: ${version.summary}`,
    };
  }

  const help = await runOpenClawCommand(cliPath, ["--help"]);

  if (help.available) {
    return {
      available: true,
      summary: `OpenClaw CLI responded through ${cliPath}. Help output attached as runtime proof.`,
    };
  }

  return {
    available: false,
    summary: `OPENCLAW_ENABLED is true, but ${cliPath} was not callable. ${version.summary}`,
  };
}

async function runOpenClawCommand(
  cliPath: string,
  args: string[]
): Promise<OpenClawProbe> {
  try {
    const result = await execFileAsync(cliPath, args, {
      timeout: 5000,
      maxBuffer: 64 * 1024,
    });
    const output = compactOutput(result.stdout || result.stderr);

    return {
      available: true,
      summary: output || "command completed",
    };
  } catch (error) {
    return {
      available: false,
      summary: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildTraceSteps(
  topic: string,
  sources: SourceCard[],
  errors: ProviderError[],
  openClawProbe: OpenClawProbe,
  traceOverrides: TraceOverrides = {},
  finalAnswerMeta?: FinalAnswerMeta
): OrchestrationStep[] {
  const providers = new Set(sources.map((source) => source.provider));
  const providerSummary = providers.size
    ? Array.from(providers).join(", ")
    : "no providers";
  const failureSummary = summarizeFailures(errors);

  return [
    withTraceOverride("runtime", traceOverrides, {
      agent: "OpenClaw Runtime Adapter",
      skill: "openclaw/runtime-adapter",
      status: "complete",
      summary: openClawProbe.summary,
      execution: "typescript-tool",
    }),
    withTraceOverride("planner", traceOverrides, {
      agent: "Planner Agent",
      skill: "openclaw/skills/planner.md",
      status: "complete",
      summary: `Created a provider plan for "${topic}" across Surf and supporting public research providers.`,
      execution: "deterministic-fallback",
    }),
    withTraceOverride("discovery", traceOverrides, {
      agent: "Discovery Agent",
      skill: "openclaw/skills/discovery.md",
      status: sources.length ? "complete" : "failed",
      summary: `Collected ${sources.length} live source cards from ${providerSummary}.${failureSummary}`,
      execution: "typescript-tool",
    }),
    withTraceOverride("source-normalizer", traceOverrides, {
      agent: "Source Normalizer Agent",
      skill: "openclaw/skills/source-normalizer.md",
      status: sources.length ? "complete" : "failed",
      summary:
        "Normalized discovered items into SourceCard records with provider, URL, excerpt, date, author, and metrics.",
      execution: "typescript-tool",
    }),
    withTraceOverride("trend-scorer", traceOverrides, {
      agent: "Trend Scorer Agent",
      skill: "openclaw/skills/trend-scorer.md",
      status: sources.length ? "complete" : "failed",
      summary:
        "Prepared trend scoring inputs from repeated agent, infrastructure, launch, and builder signals.",
      execution: "deterministic-fallback",
    }),
    withTraceOverride("evidence-packager", traceOverrides, {
      agent: "Evidence Packager Agent",
      skill: "openclaw/skills/evidence-packager.md",
      status: sources.length ? "complete" : "failed",
      summary:
        "Prepared the discovered source bundle, provider errors, and run trace for the evidence bundle. Upload not submitted yet.",
      execution: "deterministic-fallback",
    }),
    withTraceOverride("verifier", traceOverrides, {
      agent: "Verifier Agent",
      skill: "openclaw/skills/verifier.md",
      status: sources.length ? "complete" : "failed",
      summary:
        "Prepared brief hash inputs and claim support checks for the verification panel. Chain anchoring not submitted yet.",
      execution: "deterministic-fallback",
    }),
    withTraceOverride("onchain-enrichment", traceOverrides, {
      agent: "On-chain Enrichment",
      skill: "onchain-tools/workflow",
      status: "complete",
      summary:
        "Ran the shared on-chain enrichment workflow for the research request.",
      execution: "typescript-tool",
    }),
    withTraceOverride("final-conclusion", traceOverrides, {
      agent: "Final Conclusion Agent",
      skill: "openclaw/skills/final-conclusion.md",
      status: "complete",
      summary: summarizeFinalAnswerStep(finalAnswerMeta, sources.length),
      execution: finalAnswerMeta?.execution || "deterministic-fallback",
      model: finalAnswerMeta?.model,
      sessionId: finalAnswerMeta?.sessionId,
      error: finalAnswerMeta?.error,
    }),
    withTraceOverride("evidence-bundle", traceOverrides, {
      agent: "Evidence Bundle Commit",
      skill: "evidence/storage",
      status: "complete",
      summary:
        "Prepared the canonical evidence bundle for Sui alpha evidence.",
      execution: "deterministic-fallback",
    }),
    withTraceOverride("chain-proof", traceOverrides, {
      agent: "Sui Decision Anchor",
      skill: "move/langclaw_memory/sources/decision_registry.move",
      status: "complete",
      summary:
        "Prepared the agent decision hash. Set SUI_CHAIN_ENABLED=true and SUI_LANGCLAW_REGISTRY_PACKAGE_ID to record it.",
      execution: "deterministic-fallback",
    }),
  ];
}

function withTraceOverride(
  stepId: string,
  overrides: TraceOverrides,
  base: OrchestrationStep
): OrchestrationStep {
  const override = overrides[stepId];

  if (!override) {
    return base;
  }

  return {
    ...base,
    ...override,
    summary: override.summary || base.summary,
    status: override.status || base.status,
  };
}

function summarizeFinalAnswerStep(
  finalAnswerMeta: FinalAnswerMeta | undefined,
  sourceCount: number
) {
  if (finalAnswerMeta?.synthesis === "openai") {
    const model = finalAnswerMeta.model ? ` using ${finalAnswerMeta.model}` : "";

    return `Final answer generated by OpenAI${model} from ${sourceCount} source cards.`;
  }

  if (finalAnswerMeta?.synthesis === "openclaw-ai") {
    const model = finalAnswerMeta.model ? ` using ${finalAnswerMeta.model}` : "";

    return `Final answer generated by OpenClaw model${model} from ${sourceCount} source cards.`;
  }

  if (finalAnswerMeta?.synthesis === "deterministic-fallback") {
    return "OpenClaw AI failed, deterministic fallback used.";
  }

  return "Created the final conclusion from discovery, normalization, trend scoring, evidence, and verification outputs.";
}

function summarizeFinalAnswerKickoff(
  preferOpenClaw: boolean,
  signals: DiscoverSignals
) {
  const signalSummary = `Signals ready: social ${signals.social.status}, on-chain ${signals.onchain.status}, combined ${signals.combined.status}.`;

  if (preferOpenClaw) {
    return `Final Conclusion Agent is running through OpenClaw. ${signalSummary}`;
  }

  return `Final Conclusion Agent is asking OpenAI Responses API. ${signalSummary}`;
}

function summarizeFinalAnswerProgress(
  finalAnswerMeta: FinalAnswerMeta,
  hasModelAnswer: boolean
) {
  if (finalAnswerMeta.synthesis === "openai" && hasModelAnswer) {
    return "Final answer generated by OpenAI.";
  }

  if (finalAnswerMeta.synthesis === "openclaw-ai" && hasModelAnswer) {
    return "Final answer generated by OpenClaw model.";
  }

  return "AI synthesis failed, deterministic fallback used.";
}

async function emitProgress(
  options: WorkflowOptions,
  step: WorkflowStepDefinition,
  status: WorkflowProgressEvent["status"],
  summary: string,
  meta?: {
    execution?: StepExecution;
    model?: string;
    sessionId?: string;
    error?: string;
  }
) {
  if (!options.onEvent) {
    return;
  }

  await options.onEvent(buildWorkflowProgressEvent(step, status, summary, meta));
}

export function buildWorkflowProgressEvent(
  step: WorkflowStepDefinition,
  status: WorkflowProgressEvent["status"],
  summary: string,
  meta?: {
    execution?: StepExecution;
    model?: string;
    sessionId?: string;
    error?: string;
  }
): WorkflowProgressEvent {
  const timestamp = new Date().toISOString();
  const completed =
    status === "complete" || status === "failed" ? timestamp : undefined;

  return {
    stepId: step.stepId,
    agent: step.agent,
    skill: step.skill,
    status,
    summary,
    timestamp,
    startedAt: timestamp,
    completedAt: completed,
    durationMs: completed ? 0 : undefined,
    execution: meta?.execution,
    model: meta?.model,
    sessionId: meta?.sessionId,
    error: meta?.error,
  };
}

function traceFromMeta(
  summary: string,
  meta: {
    execution?: StepExecution;
    model?: string;
    sessionId?: string;
    error?: string;
  }
): Partial<OrchestrationStep> {
  return {
    summary,
    execution: meta.execution,
    model: meta.model,
    sessionId: meta.sessionId,
    error: meta.error,
  };
}

function traceFromFinalAnswerMeta(
  summary: string,
  meta: FinalAnswerMeta
): Partial<OrchestrationStep> {
  return {
    summary,
    execution: meta.execution || "deterministic-fallback",
    model: meta.model,
    sessionId: meta.sessionId,
    error: meta.error,
  };
}

function buildOpenClawComputeProof(
  meta: FinalAnswerMeta
): ZeroGComputeProof {
  const model = meta.usedModel ?? meta.model;

  return {
    status: "used",
    provider: "OpenClaw",
    model,
    requestedModel: meta.requestedModel,
    usedModel: model,
    modelHonored: meta.modelHonored,
    fallbackFrom: meta.fallbackFrom,
  };
}

function combineSynthesisErrors(...errors: Array<string | undefined>) {
  const unique = Array.from(new Set(errors.filter(Boolean)));

  if (!unique.length) {
    return "";
  }

  if (unique.length === 1) {
    return unique[0];
  }

  return `OpenClaw synthesis failed: ${unique[0]} OpenAI fallback failed: ${unique
    .slice(1)
    .join(" | ")}`;
}

function traceFromStorageProof(
  storage: ZeroGStorageProof
): Partial<OrchestrationStep> {
  return {
    status: storage.status === "failed" ? "failed" : "complete",
    summary: summarizeStorageProof(storage),
    execution: storage.status === "uploaded" || storage.status === "failed"
      ? "evidence-bundle"
      : "deterministic-fallback",
    error: storage.error,
  };
}

function traceFromChainProof(chain: ZeroGChainProof): Partial<OrchestrationStep> {
  return {
    status: chain.status === "failed" ? "failed" : "complete",
    summary: summarizeChainProof(chain),
    execution:
      chain.status === "anchored" ||
      chain.status === "pending" ||
      chain.status === "failed"
      ? "chain-proof"
      : "deterministic-fallback",
    error: chain.error,
  };
}

function proofMetaFromStorage(storage: ZeroGStorageProof) {
  return {
    execution: storage.status === "uploaded" || storage.status === "failed"
      ? ("evidence-bundle" as const)
      : ("deterministic-fallback" as const),
    error: storage.error,
  };
}

function proofMetaFromChain(chain: ZeroGChainProof) {
  return {
    execution:
      chain.status === "anchored" ||
      chain.status === "pending" ||
      chain.status === "failed"
      ? ("chain-proof" as const)
      : ("deterministic-fallback" as const),
    error: chain.error,
  };
}

function summarizeStorageProof(storage: ZeroGStorageProof) {
  if (storage.status === "uploaded") {
    const tx = storage.txHash ? ` Transaction: ${storage.txHash}.` : "";

    return `Evidence bundle uploaded at ${storage.evidenceUri}.${tx}`;
  }

  if (storage.status === "failed") {
    return `Evidence bundle upload failed. ${storage.error || "Review evidence storage envs and wallet balance."}`;
  }

  if (storage.status === "skipped") {
    return "Evidence bundle upload skipped.";
  }

  return `Evidence bundle prepared at ${storage.evidenceUri}. ${storage.error || "Upload not submitted."}`;
}

function summarizeChainProof(chain: ZeroGChainProof) {
  if (chain.status === "anchored") {
    return `Agent decision recorded on ${chain.chainName ?? "Sui"} through the LangclawRegistry Move package. Transaction: ${chain.txHash}.`;
  }

  if (chain.status === "pending") {
    return `Agent decision transaction submitted to ${chain.chainName ?? "Sui"} and is waiting for confirmation. Transaction: ${chain.txHash}.`;
  }

  if (chain.status === "failed") {
    return `${chain.chainName ?? "Sui"} decision proof failed. ${chain.error || "Review chain envs and wallet balance."}`;
  }

  if (chain.status === "skipped") {
    return `${chain.chainName ?? "Sui"} decision proof skipped.`;
  }

  return `Agent decision hash prepared for ${chain.chainName ?? "Sui"}: ${chain.decisionHash ?? chain.briefHash}. ${chain.error || "Anchoring not submitted."}`;
}

function updateAgentOutputsWithProof(
  agentOutputs: AgentOutputs,
  proof: ZeroGProof
) {
  if (agentOutputs.evidence) {
    agentOutputs.evidence = {
      ...agentOutputs.evidence,
      storageStatus: proof.storage.status,
      evidenceUri: proof.storage.evidenceUri,
      rootHash: proof.storage.rootHash,
      storageTxHash: proof.storage.txHash,
      storageExplorerUrl: proof.storage.explorerUrl,
      error: proof.storage.error,
    };
  }

  if (agentOutputs.verifier) {
    agentOutputs.verifier = {
      ...agentOutputs.verifier,
      verificationSummary: summarizeChainProof(proof.chain),
      briefHashInput: proof.chain.decisionHash ?? proof.chain.briefHash,
      storageStatus: proof.storage.status,
      chainStatus: proof.chain.status,
      chainTxHash: proof.chain.txHash,
      chainExplorerUrl: proof.chain.explorerUrl,
      registryAddress: proof.chain.registryAddress,
      error: proof.chain.error,
    };
  }
}

function buildFinalConclusion(
  topic: string,
  sources: SourceCard[],
  errors: ProviderError[],
  runtime: OrchestrationRuntime,
  agentOutputs?: AgentOutputs
): FinalConclusion {
  const activeProviders = Array.from(
    new Set(sources.map((source) => source.provider))
  );
  const providerText = activeProviders.length
    ? activeProviders.map(providerLabel).join(", ")
    : "no live providers";
  const xSource = findSource(sources, "X");
  const githubSource = findSource(sources, "GitHub");
  const docsSource = findSource(sources, "Tavily");
  const hackQuestSource = findSource(sources, "HackQuest");
  const runtimeText = runtime === "openclaw" ? "OpenClaw CLI" : "TypeScript adapter";
  const topTrend =
    agentOutputs?.trend?.topTrend ||
    "a Sui alpha workflow that connects smart-money movement, protocol momentum, source-backed evidence, and verifiable agent decisions";

  return {
    headline: sources.length
      ? `${topic} shows useful live signal across ${providerText}.`
      : `${topic} did not return enough live signal for a confident conclusion.`,
    summary: sources.length
      ? `Langclaw found ${sources.length} live sources and routed the Sui Alpha run through ${runtimeText}. The strongest ranked direction is ${topTrend}.`
      : `Langclaw could not build a strong final conclusion because no live source cards were returned. Review provider setup, topic wording, or provider availability before using this run as evidence.`,
    keySignals: [
      buildConclusionSignal("Public signal", xSource, "No X signal returned for this topic."),
      buildConclusionSignal(
        "Builder signal",
        githubSource,
        "No GitHub repository signal returned for this topic."
      ),
      buildConclusionSignal(
        "Reference signal",
        docsSource,
        "No docs or reference page returned for this topic."
      ),
      buildConclusionSignal(
        "HackQuest angle",
        hackQuestSource,
        "No HackQuest hackathon or project page returned for this topic."
      ),
    ],
    recommendation: sources.length
      ? "Frame the demo around a verifiable Sui on-chain intelligence workflow: Langclaw turns Sui data and public context into an alpha brief, then records the agent decision hash for proof."
      : "Run discovery again with a more specific topic, then use the final conclusion only after at least one provider returns live evidence.",
    qualityNote: errors.length
      ? `Partial result. ${errors.length} provider issue${errors.length === 1 ? "" : "s"} returned, so treat the conclusion as directional.`
      : "No provider errors returned. The conclusion is still limited to the live sources available during this run.",
    generatedBy: "Final Conclusion Agent",
  };
}

export function buildDiscoverSignals({
  chain,
  errors = [],
  onChain,
  onChainSkippedReason,
  sources,
}: {
  chain: string;
  errors?: ProviderError[];
  onChain?: OnChainToolFinalPayload;
  onChainSkippedReason?: string;
  sources: SourceCard[];
}): DiscoverSignals {
  const social = buildSocialSignals({ chain, errors, sources });
  const onchain = buildOnChainSignals({
    chain,
    onChain,
    onChainSkippedReason,
  });

  return {
    social,
    onchain,
    combined: buildCombinedSignals({ social, onchain }),
  };
}

const socialMomentumProviders = new Set<SourceCard["provider"]>(["Elfa", "Surf", "X"]);

export function buildSocialSignals({
  chain,
  errors = [],
  sources,
}: {
  chain: string;
  errors?: ProviderError[];
  sources: SourceCard[];
}): DiscoverSignalSection {
  const directProviders = sources
    .filter((source) => socialMomentumProviders.has(source.provider))
    .map((source) => source.provider);
  const providers = sortSignalProviders(
    Array.from(new Set(sources.map((source) => providerLabel(source.provider))))
  );
  const sourceIds = sources.map((source) => source.id);
  const hasDirectSocial = directProviders.length > 0;
  const failedSocialProviders = summarizeFailedSocialProviders(errors);
  const hasPartialSocialCoverage =
    hasDirectSocial && failedSocialProviders.length > 0;

  if (sources.length === 0) {
    return {
      status: "failed",
      summary: "Discovery did not return usable social or public context evidence.",
      providers,
      sourceIds,
      toolIds: [],
      caveat: "No live source cards were collected for the social/context section.",
    };
  }

  if (hasPartialSocialCoverage) {
    return {
      status: "partial",
      summary: `Collected live social and public context evidence for ${chain} from ${providers.join(", ")}, but some social momentum providers failed.`,
      providers,
      sourceIds,
      toolIds: [],
      caveat: `Social evidence is partial because ${failedSocialProviders.join(", ")} failed while other providers still returned source cards.`,
    };
  }

  if (hasDirectSocial) {
    return {
      status: "success",
      summary: `Collected live social and public context evidence for ${chain} from ${providers.join(", ")}.`,
      providers,
      sourceIds,
      toolIds: [],
    };
  }

  return {
    status: "partial",
    summary: `Collected supporting builder and public context for ${chain}, but direct social momentum was limited to ${providers.join(", ")}.`,
    providers,
    sourceIds,
    toolIds: [],
    caveat:
      "The social section is leaning on builder and documentation context rather than direct social momentum providers.",
  };
}

function buildOnChainSignals({
  chain,
  onChain,
  onChainSkippedReason,
}: {
  chain: string;
  onChain?: OnChainToolFinalPayload;
  onChainSkippedReason?: string;
}): DiscoverSignalSection {
  if (!onChain) {
    const skipped = Boolean(onChainSkippedReason?.includes("outside Langclaw's supported on-chain scope"));

    return {
      status: skipped ? "skipped" : "failed",
      summary:
        onChainSkippedReason ||
        `On-chain enrichment failed before it could produce usable evidence for ${chain}.`,
      providers: [],
      sourceIds: [],
      toolIds: [],
      caveat: onChainSkippedReason,
    };
  }

  const directSuccesses = onChain.tools.filter(isUsableDirectProviderResult);
  const directFailures = onChain.tools.filter(isDirectProviderIssue);
  const toolIds = onChain.tools.map((tool) => tool.commandId);
  const attemptedProviders = Array.from(
    new Set(
      onChain.tools.flatMap((tool) =>
        tool.attemptedProviders?.length ? tool.attemptedProviders : [tool.provider]
      )
    )
  );
  const providers = sortSignalProviders(
    attemptedProviders.map((provider) => providerLabelFromOnChain(provider))
  );

  if (directSuccesses.length && !directFailures.length) {
    return {
      status: "success",
      summary: `On-chain enrichment produced usable live evidence for ${chain} from ${providers.join(", ")}.`,
      providers,
      sourceIds: [],
      toolIds,
    };
  }

  if (directSuccesses.length || onChain.tools.some((tool) => tool.status === "success")) {
    const failureProviders = sortSignalProviders(
      Array.from(new Set(directFailures.map((tool) => providerLabelFromOnChain(tool.provider))))
    );
    const summary = directSuccesses.length
      ? directFailures.length
        ? `On-chain enrichment produced usable evidence for ${chain}, but some provider coverage remained incomplete (${failureProviders.join(", ")}).`
        : `On-chain enrichment ran for ${chain}, but the evidence stayed analysis-level rather than direct wallet-flow evidence.`
      : directFailures.length
        ? `On-chain enrichment ran for ${chain}, but direct smart-money rows were not available from ${failureProviders.join(", ")}.`
        : `On-chain enrichment ran for ${chain}, but the evidence stayed analysis-level rather than direct wallet-flow evidence.`;

    return {
      status: "partial",
      summary,
      providers,
      sourceIds: [],
      toolIds,
      caveat: directFailures.length ? onChain.caveat : onChain.caveat,
    };
  }

  return {
    status: "partial",
    summary: `On-chain enrichment ran for ${chain}, but direct wallet-flow rows were not available yet.`,
    providers,
    sourceIds: [],
    toolIds,
    caveat: onChain.caveat,
  };
}

function buildCombinedSignals({
  social,
  onchain,
}: {
  social: DiscoverSignalSection;
  onchain: DiscoverSignalSection;
}): DiscoverSignalSection {
  const providers = sortSignalProviders([
    ...social.providers,
    ...onchain.providers,
  ]);
  const sourceIds = Array.from(new Set([...social.sourceIds, ...onchain.sourceIds]));
  const toolIds = Array.from(new Set([...social.toolIds, ...onchain.toolIds]));

  if (social.status === "success" && onchain.status === "success") {
    return {
      status: "success",
      summary:
        "Social and on-chain signals converged into a usable live research brief.",
      providers,
      sourceIds,
      toolIds,
    };
  }

  if (social.status === "skipped" && onchain.status === "skipped") {
    return {
      status: "skipped",
      summary:
        "The workflow could not build a combined signal because both social and on-chain sections were skipped.",
      providers,
      sourceIds,
      toolIds,
      caveat: [social.caveat, onchain.caveat].filter(Boolean).join(" "),
    };
  }

  if (social.status === "failed" && onchain.status === "failed") {
    return {
      status: "failed",
      summary:
        "The workflow could not build a dependable combined view from either social or on-chain evidence.",
      providers,
      sourceIds,
      toolIds,
      caveat: [social.caveat, onchain.caveat].filter(Boolean).join(" "),
    };
  }

  const summary =
    social.status === "success"
      ? "Social and on-chain signals diverged: public attention was visible, but the on-chain side remained weaker or incomplete."
      : onchain.status === "success"
        ? "Social and on-chain signals diverged: on-chain evidence was usable, but social confirmation remained limited."
        : "Social and on-chain signals remained partial, so the combined brief should be treated as directional.";

  return {
    status: "partial",
    summary,
    providers,
    sourceIds,
    toolIds,
    caveat: [social.caveat, onchain.caveat].filter(Boolean).join(" "),
  };
}

export function buildFinalAnswer(
  topic: string,
  sources: SourceCard[],
  errors: ProviderError[],
  runtime: OrchestrationRuntime,
  signals: DiscoverSignals,
  onChain?: OnChainToolFinalPayload,
  onChainSkippedReason?: string,
  providerTrace?: ProviderTraceEntry[],
  report?: ResearchReport
): FinalAnswer {
  if (report) {
    return buildReportLedFallbackAnswer(
      errors,
      signals,
      onChain,
      onChainSkippedReason,
      providerTrace,
      report
    );
  }

  if (onChain) {
    return buildOnChainLedFallbackAnswer(
      topic,
      sources,
      errors,
      signals,
      onChain,
      providerTrace
    );
  }

  const activeProviders = Array.from(
    new Set(sources.map((source) => providerLabel(source.provider)))
  );
  const providerText = activeProviders.length
    ? activeProviders.join(", ")
    : "no live providers";
  const runtimeText = runtime === "openclaw" ? "OpenClaw" : "TypeScript adapter";
  const sourceCount = sources.length;
  const hasAllCoreSignals =
    Boolean(findSource(sources, "X")) &&
    Boolean(findSource(sources, "GitHub")) &&
    Boolean(findSource(sources, "Tavily")) &&
    Boolean(findSource(sources, "HackQuest"));

  if (!sourceCount) {
    const answerMarkdown = [
      `Aku belum bisa memberi rekomendasi yang kuat untuk "${topic}" karena discovery tidak menemukan live source yang cukup.`,
      signals.combined.summary,
      signals.social.summary,
      signals.onchain.summary,
      onChainSkippedReason || "On-chain enrichment tidak dijalankan untuk brief ini.",
      "Coba pakai topic yang lebih spesifik atau cek konfigurasi provider.",
    ].join("\n\n");

    return applyFinalAnswerGuardrails({
      title: "Discovery did not find enough evidence",
      answer: `Jawaban singkat: untuk "${topic}", aku belum bisa memberi rekomendasi yang kuat karena discovery tidak menemukan live source yang cukup.`,
      answerMarkdown,
      bullets: [
        "Tidak ada source card yang bisa dipakai sebagai evidence.",
        "Workflow agent tetap berjalan, tetapi hasilnya belum layak dijadikan dasar demo.",
        "Coba pakai topic yang lebih spesifik atau cek konfigurasi provider.",
      ],
      recommendation:
        "Jalankan ulang discovery dengan topic yang lebih sempit, lalu gunakan hasilnya hanya jika minimal satu provider mengembalikan evidence.",
      caveat:
        "Kesimpulan ini lemah karena tidak ada live source yang berhasil dikumpulkan.",
      generatedBy: "Final Conclusion Agent",
    }, {
      errors,
      onChainSkippedReason,
      providerTrace,
      signals,
    });
  }

  const onChainSummary =
    onChainSkippedReason || "On-chain enrichment tidak dijalankan untuk request ini.";
  const recommendation =
    "Untuk demo, jelaskan Langclaw sebagai AI Alpha & Data agent: user bertanya satu Sui atau supported analysis topic, Langclaw mencari evidence, lalu decision hash dan evidence URI dicatat sebagai proof.";
  const answerMarkdown = [
    `Combined signal: ${signals.combined.summary}`,
    `Social signal: ${signals.social.summary}`,
    `On-chain signal: ${signals.onchain.summary}`,
    `Untuk "${topic}", Langclaw menemukan ${sourceCount} live source dari ${providerText}. Pola terkuatnya masih mengarah ke AI agent yang menggabungkan public signal, builder activity, dan evidence-backed research.`,
    onChainSummary,
    hasAllCoreSignals
      ? "- Sinyalnya lengkap: ada percakapan publik, repo builder, referensi teknis, dan konteks HackQuest."
      : `- Sinyalnya cukup, tetapi belum lengkap di semua provider. Provider aktif: ${providerText}.`,
    `- Workflow dijalankan lewat ${runtimeText}, jadi proses agent bisa ditampilkan sebagai alur planner, discovery, evidence, on-chain enrichment, dan final synthesis.`,
    "- Arah project yang paling masuk akal adalah research agent yang hanya memperdalam on-chain evidence saat request memang membutuhkannya.",
    `Next step: ${recommendation}`,
  ].join("\n\n");

  return applyFinalAnswerGuardrails({
    title: "Sui Alpha brief",
    answer: `Jawaban singkat: "${topic}" layak dipakai sebagai arah Sui Alpha karena Langclaw menemukan ${sourceCount} live sources dari ${providerText}. Pola terkuatnya adalah AI agent yang mencari sinyal on-chain, merangkum evidence, lalu menyiapkan agent decision proof.`,
    answerMarkdown,
    bullets: [
      hasAllCoreSignals
        ? "Sinyalnya lengkap: ada percakapan publik, repo builder, referensi teknis, dan konteks HackQuest."
        : `Sinyalnya cukup, tetapi belum lengkap di semua provider. Provider aktif: ${providerText}.`,
      `Workflow dijalankan lewat ${runtimeText}, jadi proses agent bisa ditampilkan sebagai alur Planner, Discovery, Source, Trend, Evidence, Verifier, dan Final Conclusion.`,
      "Arah project yang paling masuk akal adalah Sui Alpha: agent yang memonitor smart money, liquidity anomaly, dan protocol momentum tanpa mengeksekusi trade.",
    ],
    recommendation,
    caveat: "Directional research only.",
    generatedBy: "Final Conclusion Agent",
  }, {
    errors,
    onChainSkippedReason,
    providerTrace,
    signals,
  });
}

function buildReportLedFallbackAnswer(
  errors: ProviderError[],
  signals: DiscoverSignals,
  onChain: OnChainToolFinalPayload | undefined,
  onChainSkippedReason: string | undefined,
  providerTrace: ProviderTraceEntry[] | undefined,
  report: ResearchReport
): FinalAnswer {
  const answerMarkdown = buildUserFacingReportAnswerMarkdown(
    report,
    signals,
    onChain,
    onChainSkippedReason
  );

  return applyFinalAnswerGuardrails({
    title: report.title,
    answer: report.executiveSummary,
    answerMarkdown,
    bullets: buildReportFallbackBullets(report, signals).slice(0, 4),
    recommendation: report.recommendations[0],
    caveat: report.caveats.join(" "),
    generatedBy: "Final Conclusion Agent",
  }, {
    errors,
    onChain,
    onChainSkippedReason,
    providerTrace,
    report,
    signals,
  });
}

function buildUserFacingReportAnswerMarkdown(
  report: ResearchReport,
  signals: DiscoverSignals,
  onChain: OnChainToolFinalPayload | undefined,
  onChainSkippedReason: string | undefined
) {
  if (report.kind === "smart-money") {
    return buildSmartMoneyReportAnswerMarkdown(
      report,
      onChain,
      onChainSkippedReason
    );
  }

  const includeOnChainRead = !(
    report.entities.length || report.tables.length
  );
  const lines = [
    report.executiveSummary,
    report.bottomLine !== report.executiveSummary ? report.bottomLine : undefined,
    ...buildReportFallbackBullets(report, signals).map((bullet) => `- ${bullet}`),
    report.recommendations[0]
      ? `Next step: ${report.recommendations[0]}`
      : undefined,
    includeOnChainRead && onChain
      ? `On-chain read: ${onChain.answer}`
      : includeOnChainRead && onChainSkippedReason
        ? `On-chain read: ${onChainSkippedReason}`
        : undefined,
  ].filter(Boolean);

  return lines.join("\n\n");
}

function buildSmartMoneyReportAnswerMarkdown(
  report: ResearchReport,
  onChain: OnChainToolFinalPayload | undefined,
  onChainSkippedReason: string | undefined
) {
  const includeOnChainRead = !(
    report.entities.length || report.tables.length
  );
  const lines: string[] = [
    `## ${report.title}`,
    "",
    report.executiveSummary,
    "",
  ];

  for (const section of report.sections) {
    lines.push(`### ${section.title}`, "", section.markdown, "");
  }

  for (const table of report.tables.slice(0, 1)) {
    lines.push(`### ${table.title}`, "");
    if (table.description) {
      lines.push(table.description, "");
    }
    lines.push(renderUserFacingReportTable(table), "");
  }

  if (!report.sections.some((section) => /^(confidence|conclusion)$/i.test(section.title))) {
    lines.push("### Confidence", "", report.bottomLine, "");
  }

  if (report.recommendations[0]) {
    lines.push("### What would improve confidence", "", report.recommendations[0], "");
  }

  if (includeOnChainRead && onChain) {
    lines.push(`On-chain read: ${onChain.answer}`, "");
  } else if (includeOnChainRead && onChainSkippedReason) {
    lines.push(`On-chain read: ${onChainSkippedReason}`, "");
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function renderUserFacingReportTable(table: ResearchReport["tables"][number]) {
  if (!table.rows.length) {
    return "_No rows available._";
  }

  const columns = table.columns.slice(0, 8);
  const header = `| ${columns.join(" | ")} |`;
  const divider = `| ${columns.map(() => "---").join(" | ")} |`;
  const rows = table.rows.slice(0, 5).map((row) =>
    `| ${columns
      .map((column) => escapeUserFacingTableCell(formatUserFacingTableCell(row[column])))
      .join(" | ")} |`
  );

  return [header, divider, ...rows].join("\n");
}

function formatUserFacingTableCell(value: string | number | null | undefined) {
  if (value == null || value === "") {
    return "Not available";
  }

  if (typeof value === "number") {
    return Number.isInteger(value)
      ? value.toLocaleString("en-US")
      : value.toFixed(2).replace(/\.?0+$/, "");
  }

  return value;
}

function escapeUserFacingTableCell(value: string) {
  return value.replace(/\|/g, "\\|");
}

function buildReportFallbackBullets(
  report: ResearchReport,
  signals: DiscoverSignals
) {
  return uniqueStrings([
    signals.combined.summary,
    signals.onchain.summary,
    report.bottomLine,
    report.recommendations[0],
  ]).filter(Boolean);
}

function buildOnChainLedFallbackAnswer(
  topic: string,
  sources: SourceCard[],
  errors: ProviderError[],
  signals: DiscoverSignals,
  onChain: OnChainToolFinalPayload,
  providerTrace?: ProviderTraceEntry[]
): FinalAnswer {
  const chainName = onChain.plan.chainName || onChain.plan.chain;
  const intent = onChain.plan.intent;
  const directSuccesses = onChain.tools.filter(isUsableDirectProviderResult);
  const directFailures = onChain.tools.filter(isDirectProviderIssue);
  const localSuccesses = onChain.tools.filter(
    (tool) => tool.status === "success" && tool.provider === "local"
  );
  const totalIssues = errors.length + directFailures.length;
  const summary = buildOnChainSummary({
    chainName,
    directFailures,
    directSuccesses,
    intent,
    localSuccesses,
    topic,
  });
  const findings = [
    ...buildResearchFindingBullets(sources),
    buildOnChainFindingBullet({
      chainName,
      directFailures,
      directSuccesses,
      localSuccesses,
      onChain,
    }),
  ];
  const bottomLine = buildOnChainBottomLine({
    chainName,
    directFailures,
    directSuccesses,
    intent,
  });
  const answerMarkdown = [
    "Short conclusion",
    "",
    `- Combined signal: ${signals.combined.summary}`,
    `- Social signal: ${signals.social.summary}`,
    `- On-chain signal: ${signals.onchain.summary}`,
    "",
    `- Summary: ${summary}`,
    "",
    "What we found",
    "",
    ...findings.map((item) => `- ${item}`),
    "",
    "Bottom line",
    "",
    `- ${bottomLine}`,
    "",
    `Recommendation: ${onChain.recommendation}`,
  ].join("\n");

  return applyFinalAnswerGuardrails({
    title: `${chainName} research brief`,
    answer: summary,
    answerMarkdown,
    bullets: findings,
    recommendation: onChain.recommendation,
    caveat: totalIssues ? onChain.caveat : onChain.caveat,
    generatedBy: "Final Conclusion Agent",
  }, {
    errors,
    onChain,
    providerTrace,
    signals,
  });
}

function buildOnChainSummary({
  chainName,
  directFailures,
  directSuccesses,
  intent,
  localSuccesses,
  topic,
}: {
  chainName: string;
  directFailures: OnChainToolResult[];
  directSuccesses: OnChainToolResult[];
  intent: string;
  localSuccesses: OnChainToolResult[];
  topic: string;
}) {
  const isSmartMoney =
    intent === "smart-money" || /\bsmart[-\s]money|whale|accumulat\w*/i.test(topic);

  if (isSmartMoney && !directSuccesses.length) {
    return `Smart-money signal is still weak on ${chainName}. The bundle is more useful as directional research because direct wallet-flow rows were not available.`;
  }

  if (isSmartMoney) {
    return `The combined research and on-chain bundle found live smart-money-related evidence on ${chainName}, but it still needs manual verification before being framed as confirmed accumulation.`;
  }

  if (!directSuccesses.length) {
    return `The on-chain enrichment for "${topic}" did not return strong direct evidence, so the result should be treated as directional research rather than a confirmed signal.`;
  }

  if (directFailures.length) {
    return "The analysis returned usable on-chain evidence, but some source coverage was incomplete, so the conclusion is directional rather than final.";
  }

  if (localSuccesses.length) {
    return "The analysis returned usable direct evidence and a local synthesis summary, giving this bundle a stronger mixed research and on-chain footing.";
  }

  return "The analysis returned usable direct evidence, so this bundle can be used as a research brief with manual follow-up.";
}

function buildResearchFindingBullets(sources: SourceCard[]) {
  const bullets: string[] = [];
  const xCount = countSourcesByProvider(sources, "X");
  const githubCount = countSourcesByProvider(sources, "GitHub");
  const docsCount = countSourcesByProvider(sources, "Tavily");
  const hackQuestCount = countSourcesByProvider(sources, "HackQuest");

  if (xCount) {
    bullets.push(
      `X activity: ${xCount} post(s) were collected, which supports public narrative activity rather than direct on-chain proof.`
    );
  }

  if (githubCount) {
    bullets.push(
      `GitHub / tooling: ${githubCount} repo or builder reference(s) were collected, which supports builder activity more than finalized on-chain adoption.`
    );
  }

  if (docsCount) {
    bullets.push(
      `Docs / analysis pages: ${docsCount} technical or reference page(s) were collected, which add context but do not replace direct on-chain evidence.`
    );
  }

  if (hackQuestCount) {
    bullets.push(
      `Hackathon signals: ${hackQuestCount} HackQuest listing(s) were collected, which indicate developer engagement rather than whale flow confirmation.`
    );
  }

  if (!bullets.length) {
    bullets.push(
      "Research discovery returned limited source coverage, so the answer leans more heavily on the on-chain enrichment attempt."
    );
  }

  return bullets;
}

function buildOnChainFindingBullet({
  chainName,
  directFailures,
  directSuccesses,
  localSuccesses,
  onChain,
}: {
  chainName: string;
  directFailures: OnChainToolResult[];
  directSuccesses: OnChainToolResult[];
  localSuccesses: OnChainToolResult[];
  onChain: OnChainToolFinalPayload;
}) {
  const failureProviders = summarizeResultProviders(directFailures);
  const successProviders = summarizeResultProviders(directSuccesses);
  const localDetail = localSuccesses.length
    ? ` ${localSuccesses.length} local synthesis step(s) still produced analysis-only signals.`
    : "";

  if (!directSuccesses.length && directFailures.length) {
    return `On-chain enrichment on ${chainName}: dedicated sources did not return wallet-flow rows.${localDetail} No transactions were signed or executed by Langclaw.`;
  }

  if (!directSuccesses.length) {
    return `On-chain enrichment on ${chainName}: direct wallet-flow rows were not available yet.${localDetail} No transactions were signed or executed by Langclaw.`;
  }

  const failureSuffix = directFailures.length
    ? ` ${directFailures.length} provider issue(s) still need fixing (${failureProviders}).`
    : "";

  return `On-chain enrichment on ${chainName}: ${directSuccesses.length} direct provider result(s) returned usable evidence (${successProviders}).${failureSuffix} No transactions were signed or executed by Langclaw.`;
}

function buildOnChainBottomLine({
  chainName,
  directFailures,
  directSuccesses,
  intent,
}: {
  chainName: string;
  directFailures: OnChainToolResult[];
  directSuccesses: OnChainToolResult[];
  intent: string;
}) {
  if (intent === "smart-money" && !directSuccesses.length) {
    return "Smart-money signal is weak because direct wallet-flow rows were unavailable. Standard checks are listed as unavailable instead of asking for the same task to be rerun.";
  }

  if (!directSuccesses.length) {
    return `Current evidence is still incomplete, so treat this as directional research until a direct on-chain provider succeeds.`;
  }

  if (directFailures.length) {
    return `Use the successful provider data now, but keep the claim framed as directional until the failed providers are fixed or replaced with confirming queries.`;
  }

  return `Use the direct evidence as a starting point for manual review, not as an automated final claim.`;
}

function countSourcesByProvider(
  sources: SourceCard[],
  provider: SourceCard["provider"]
) {
  return sources.filter((source) => source.provider === provider).length;
}

function summarizeResultProviders(results: OnChainToolResult[]) {
  const providers = Array.from(new Set(results.map((result) => result.provider)));

  return providers.join(", ");
}

export function withFallbackCaveat(answer: FinalAnswer, meta: FinalAnswerMeta) {
  const fallbackNote = meta.error
    ? `AI synthesis failed, deterministic fallback used. Reason: ${meta.error}`
    : "AI synthesis failed, deterministic fallback used.";
  const baseCaveat = answer.caveat || "Limited confidence.";
  const combinedCaveat = baseCaveat.includes("AI synthesis failed")
    ? baseCaveat
    : `${baseCaveat} ${fallbackNote}`.trim();
  const markdown = stripTrailingCaveat(answer.answerMarkdown || answer.answer);
  const updatedMarkdown = markdown
    ? `${markdown}\n\nCaveat: ${combinedCaveat}`
    : `Caveat: ${combinedCaveat}`;

  return {
    ...answer,
    caveat: combinedCaveat,
    answerMarkdown: updatedMarkdown,
  };
}

async function maybeRunOnChainEnrichment({
  chain,
  context,
  message,
  onToolCall,
  onToolPlan,
  onToolResult,
  signal,
}: {
  chain: string;
  context: OnChainContextMessage[];
  message: string;
  onToolCall?: (event: OnChainToolCallEvent) => void | Promise<void>;
  onToolPlan?: (plan: OnChainPlanSummary) => void | Promise<void>;
  onToolResult?: (event: OnChainToolResult) => void | Promise<void>;
  signal?: AbortSignal;
}): Promise<{ payload?: OnChainToolFinalPayload; skippedReason?: string }> {
  const unsupportedChain = detectUnsupportedOnChainChain(message);

  if (unsupportedChain) {
    return {
      skippedReason: `On-chain enrichment was skipped because ${unsupportedChain.name} is outside Langclaw's supported on-chain scope.`,
    };
  }

  try {
    const result = await runOnChainToolWorkflow({
      chain,
      context,
      message,
      onToolCall,
      onToolPlan,
      onToolResult,
      signal,
    });

    return {
      payload: result.payload,
    };
  } catch (error) {
    return {
      skippedReason: `On-chain enrichment failed and was skipped. ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

function buildWorkflowChainContext({
  onChain,
  productChain,
  topic,
}: {
  onChain?: OnChainToolFinalPayload;
  productChain: ReturnType<typeof resolveProductChain>;
  topic: string;
}): WorkflowChainContext {
  const inferred = inferAnalysisChain(topic, productChain.id);

  return {
    productChain: {
      id: productChain.id,
      name: productChain.name,
      chainId: productChain.chainId,
      nativeSymbol: productChain.nativeCurrency.symbol,
    },
    analysisChain: onChain
      ? {
          id: onChain.plan.chain,
          name: onChain.plan.chainName,
          chainId: onChain.plan.chainId,
          nativeSymbol: onChain.plan.nativeSymbol,
          source: onChain.plan.analysisSource,
          supported: true,
        }
      : {
          id: inferred.chain.id,
          name: inferred.chain.name,
          chainId: inferred.chain.etherscanId ?? 0,
          nativeSymbol: inferred.chain.nativeSymbol,
          source: inferred.source,
          supported: !inferred.unsupportedChain,
        },
    unsupportedAnalysisChain: inferred.unsupportedChain,
  };
}

export function buildConclusionSignal(
  label: string,
  source: SourceCard | undefined,
  fallback: string
) {
  return {
    label,
    text: source ? cleanText(source.title) : fallback,
    sourceId: source?.id,
    sourceIds: source ? [source.id] : [],
  };
}

function findSource(sources: SourceCard[], provider: SourceCard["provider"]) {
  return sources.find((source) => source.provider === provider);
}

function summarizeProviders(sources: SourceCard[]) {
  const providers = new Set(sources.map((source) => providerLabel(source.provider)));

  return providers.size ? Array.from(providers).join(", ") : "no providers";
}

export function summarizeFailures(errors: ProviderError[]) {
  const failures = new Map<string, string>();

  for (const error of errors) {
    const provider = providerLabel(error.provider);

    if (!failures.has(provider)) {
      failures.set(provider, compactProviderIssueMessage(error.message));
    }
  }

  if (!failures.size) {
    return "";
  }

  const formatted = Array.from(failures.entries()).map(([provider, message]) =>
    message ? `${provider} (${message})` : provider
  );

  return ` Provider issues: ${formatted.join("; ")}.`;
}

function summarizeFailedSocialProviders(errors: ProviderError[]) {
  return Array.from(
    new Set(
      errors
        .map((error) => error.provider)
        .filter((provider) => socialMomentumProviders.has(provider))
        .map((provider) => providerLabel(provider))
    )
  );
}

function compactProviderIssueMessage(message: string) {
  const compact = message.replace(/\s+/g, " ").trim();

  if (
    /\b(?:401|402|403|429|5\d\d)\b|payment|required|credit|billing|api[_\s-]?key|token|unauthorized|forbidden/i.test(
      compact
    )
  ) {
    return "source unavailable";
  }

  return compact.slice(0, 120);
}

function uniqueStrings(values: Array<string | undefined>) {
  return Array.from(new Set(values.filter(Boolean) as string[]));
}

function stripTrailingCaveat(markdown: string) {
  return markdown
    .replace(/\n{2,}#{1,6}\s*Caveats?\s*\n[\s\S]*$/i, "")
    .replace(/\n{2,}Caveat:\s*[\s\S]*$/i, "")
    .replace(/^Caveat:\s*[\s\S]*$/i, "")
    .trim();
}

function providerLabel(provider: SourceCard["provider"]) {
  return provider === "Tavily" ? "Docs" : provider;
}

function providerLabelFromOnChain(provider: string) {
  if (provider === "coingecko") {
    return "CoinGecko";
  }

  if (provider === "defillama") {
    return "DeFiLlama";
  }

  if (provider === "dexscreener") {
    return "DEX Screener";
  }

  if (provider === "etherscan") {
    return "Etherscan";
  }

  if (provider === "geckoterminal") {
    return "GeckoTerminal";
  }

  if (provider === "goplus") {
    return "GoPlus";
  }

  if (provider === "local") {
    return "Local synthesis";
  }

  if (provider === "nansen") {
    return "Nansen";
  }

  if (provider === "surf") {
    return "Surf";
  }

  if (provider === "elfa") {
    return "Elfa";
  }

  if (provider === "dune") {
    return "Dune";
  }

  if (provider === "alchemy") {
    return "Alchemy";
  }

  return provider;
}

function sortSignalProviders(providers: string[]) {
  const order = new Map(
    [
      "Elfa",
      "Surf",
      "X",
      "Nansen",
      "Dune",
      "CoinGecko",
      "GeckoTerminal",
      "DEX Screener",
      "DeFiLlama",
      "Alchemy",
      "Etherscan",
      "GoPlus",
      "GitHub",
      "Docs",
      "HackQuest",
      "Local synthesis",
    ].map((label, index) => [label, index])
  );

  return Array.from(new Set(providers))
    .filter(Boolean)
    .sort((left, right) => {
      const leftRank = order.get(left) ?? Number.MAX_SAFE_INTEGER;
      const rightRank = order.get(right) ?? Number.MAX_SAFE_INTEGER;

      return leftRank - rightRank || left.localeCompare(right);
    });
}

function cleanText(value: string) {
  return value
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function compactOutput(output: string) {
  return output.replace(/\s+/g, " ").trim().slice(0, 180);
}
