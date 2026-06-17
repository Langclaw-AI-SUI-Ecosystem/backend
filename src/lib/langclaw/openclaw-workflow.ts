import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  isRecord,
  readPositiveInt,
  readString,
  runOpenClawAgentJson,
  type OpenClawStepMeta,
} from "./openclaw-runner";
import type {
  EvidenceOutput,
  PlannerOutput,
  ProviderError,
  ProviderName,
  SourceCard,
  TrendOutput,
  VerifierOutput,
} from "./types";

type NativeStepResult<T> = {
  output: T;
  meta: OpenClawStepMeta;
};

type AgentStepInput<T> = {
  enabled: boolean;
  runId: string;
  stepId: string;
  skillPath: string;
  fallback: T;
  buildPrompt: (skillText: string) => string;
  normalize: (payload: Record<string, unknown>, fallback: T) => T;
};

const providers: ProviderName[] = ["X", "GitHub", "Tavily", "HackQuest"];
const skillFiles: Record<string, string> = {
  "openclaw/skills/planner.md": join(process.cwd(), "openclaw", "skills", "planner.md"),
  "openclaw/skills/trend-scorer.md": join(
    process.cwd(),
    "openclaw",
    "skills",
    "trend-scorer.md"
  ),
  "openclaw/skills/evidence-packager.md": join(
    process.cwd(),
    "openclaw",
    "skills",
    "evidence-packager.md"
  ),
  "openclaw/skills/verifier.md": join(process.cwd(), "openclaw", "skills", "verifier.md"),
};

export function createRunId() {
  return `sg_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

export function createStepSessionId(runId: string, stepId: string) {
  return `langclaw-${runId}-${stepId}`;
}

export function shouldRunOpenClawWorkflow(openClawAvailable: boolean) {
  return openClawAvailable && process.env.OPENCLAW_WORKFLOW_ENABLED !== "false";
}

export async function runPlannerAgentStep(
  topic: string,
  enabled: boolean,
  runId: string
): Promise<NativeStepResult<PlannerOutput>> {
  const fallback = buildFallbackPlannerOutput(topic);

  return runAgentStep({
    enabled,
    runId,
    stepId: "planner",
    skillPath: "openclaw/skills/planner.md",
    fallback,
    buildPrompt: (skillText) =>
      buildPrompt({
        agent: "Planner Agent",
        skillText,
        payload: {
          topic,
          availableProviders: providers,
        },
        requiredShape: {
          summary: fallback.summary,
          providerPlan: fallback.providerPlan,
          scoringFocus: fallback.scoringFocus,
        },
      }),
    normalize: normalizePlannerOutput,
  });
}

export async function runTrendAgentStep(
  topic: string,
  sources: SourceCard[],
  errors: ProviderError[],
  planner: PlannerOutput,
  enabled: boolean,
  runId: string
): Promise<NativeStepResult<TrendOutput>> {
  const fallback = buildFallbackTrendOutput(topic, sources, errors);

  return runAgentStep({
    enabled,
    runId,
    stepId: "trend-scorer",
    skillPath: "openclaw/skills/trend-scorer.md",
    fallback,
    buildPrompt: (skillText) =>
      buildPrompt({
        agent: "Trend Scorer Agent",
        skillText,
        payload: {
          topic,
          providerErrors: errors,
          planner,
          sources: compactSources(sources),
        },
        requiredShape: {
          summary: fallback.summary,
          topTrend: fallback.topTrend,
          score: fallback.score,
          rankedTrends: fallback.rankedTrends,
        },
      }),
    normalize: normalizeTrendOutput,
  });
}

export async function runEvidenceAgentStep(
  topic: string,
  sources: SourceCard[],
  errors: ProviderError[],
  trend: TrendOutput,
  enabled: boolean,
  runId: string
): Promise<NativeStepResult<EvidenceOutput>> {
  const fallback = buildFallbackEvidenceOutput(topic, sources, trend);

  return runAgentStep({
    enabled,
    runId,
    stepId: "evidence-packager",
    skillPath: "openclaw/skills/evidence-packager.md",
    fallback,
    buildPrompt: (skillText) =>
      buildPrompt({
        agent: "Evidence Packager Agent",
        skillText,
        payload: {
          topic,
          providerErrors: errors,
          trend,
          sources: compactSources(sources),
          storageConstraint:
            "Prepare the bundle only. Do not claim upload, CID, transaction, or anchoring.",
        },
        requiredShape: {
          bundleSummary: fallback.bundleSummary,
          storageStatus: "prepared",
          evidenceUri: fallback.evidenceUri,
          claimMap: fallback.claimMap,
        },
      }),
    normalize: normalizeEvidenceOutput,
  });
}

export async function runVerifierAgentStep(
  topic: string,
  sources: SourceCard[],
  trend: TrendOutput,
  evidence: EvidenceOutput,
  enabled: boolean,
  runId: string
): Promise<NativeStepResult<VerifierOutput>> {
  const fallback = buildFallbackVerifierOutput(topic, sources, trend, evidence);

  return runAgentStep({
    enabled,
    runId,
    stepId: "verifier",
    skillPath: "openclaw/skills/verifier.md",
    fallback,
    buildPrompt: (skillText) =>
      buildPrompt({
        agent: "Verifier Agent",
        skillText,
        payload: {
          topic,
          trend,
          evidence,
          sources: compactSources(sources),
          proofConstraint:
            "Return prepared proof inputs only. Do not claim real storage upload or Sui decision anchoring.",
        },
        requiredShape: {
          verificationSummary: fallback.verificationSummary,
          unsupportedClaims: fallback.unsupportedClaims,
          briefHashInput: fallback.briefHashInput,
          storageStatus: "prepared",
          chainStatus: "prepared",
        },
      }),
    normalize: normalizeVerifierOutput,
  });
}

async function runAgentStep<T>({
  enabled,
  runId,
  stepId,
  skillPath,
  fallback,
  buildPrompt,
  normalize,
}: AgentStepInput<T>): Promise<NativeStepResult<T>> {
  const sessionId = createStepSessionId(runId, stepId);

  if (!enabled) {
    return {
      output: fallback,
      meta: {
        execution: "deterministic-fallback",
        sessionId,
        error: "OpenClaw workflow execution is disabled or unavailable.",
      },
    };
  }

  const skillText = await readSkillText(skillPath);
  const result = await runOpenClawAgentJson({
    prompt: buildPrompt(skillText),
    sessionId,
    timeoutSeconds: readPositiveInt(process.env.OPENCLAW_STEP_TIMEOUT_SECONDS, 60),
  });

  if (result.meta.execution !== "openclaw-agent" || !result.payload) {
    return {
      output: fallback,
      meta: result.meta,
    };
  }

  return {
    output: normalize(result.payload, fallback),
    meta: result.meta,
  };
}

async function readSkillText(skillPath: string) {
  const filePath = skillFiles[skillPath];

  if (!filePath) {
    return `Skill file not found: ${skillPath}`;
  }

  try {
    return await readFile(filePath, "utf8");
  } catch {
    return `Skill file not found: ${skillPath}`;
  }
}

function buildPrompt({
  agent,
  skillText,
  payload,
  requiredShape,
}: {
  agent: string;
  skillText: string;
  payload: Record<string, unknown>;
  requiredShape: Record<string, unknown>;
}) {
  return [
    `You are Langclaw's ${agent}.`,
    "Use the local skill instructions below.",
    "Use only the input JSON. Do not invent sources, URLs, metrics, uploads, CIDs, transactions, or dates.",
    "Return only valid JSON. Do not wrap it in markdown. Do not add commentary outside JSON.",
    "",
    "Skill instructions:",
    skillText,
    "",
    "Required JSON shape:",
    JSON.stringify(requiredShape, null, 2),
    "",
    "Input JSON:",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}

function buildFallbackPlannerOutput(topic: string): PlannerOutput {
  return {
    summary: `Created a provider plan for "${topic}" across Surf and supporting public research providers.`,
    providerPlan: [
      {
        provider: "X",
        query: `${topic} Sui AI alpha on-chain data smart money protocol signal`,
        purpose: "Find public Sui alpha, smart-money, and ecosystem discussion signals.",
      },
      {
        provider: "GitHub",
        query: `${topic} agent orchestration web3 ai`,
        purpose: "Find repositories that show builder activity and implementation evidence.",
      },
      {
        provider: "Tavily",
        query: `${topic} Sui DeFi protocol data AI agent documentation`,
        purpose: "Find documentation and reference pages that explain the technical context.",
      },
      {
        provider: "HackQuest",
        query: `${topic} site:hackquest.io/hackathons OR site:hackquest.io/projects`,
        purpose: "Find hackathon and project examples that match the builder use case.",
      },
    ],
    scoringFocus: [
      "novelty",
      "evidence strength",
      "buildability",
      "demo potential",
      "Sui fit",
      "market relevance",
    ],
  };
}

function buildFallbackTrendOutput(
  topic: string,
  sources: SourceCard[],
  errors: ProviderError[]
): TrendOutput {
  const score = sources.length
    ? Math.min(92, 52 + sources.length * 3 - errors.length * 4)
    : 20;
  const byProvider = providers
    .map((provider) => sources.filter((source) => source.provider === provider))
    .filter((group) => group.length);
  const rankedTrends = byProvider.slice(0, 3).map((group, index) => {
    const provider = group[0].provider === "Tavily" ? "Docs" : group[0].provider;

    return {
      label: `${provider} signal for ${topic}`,
      score: Math.max(45, score - index * 8),
      why: `This cluster uses ${group.length} ${provider} source${group.length === 1 ? "" : "s"} as evidence for the topic.`,
      sourceIds: group.slice(0, 4).map((source) => source.id),
    };
  });

  if (!rankedTrends.length) {
    rankedTrends.push({
      label: "Insufficient live signal",
      score,
      why: "No provider returned enough live evidence for trend ranking.",
      sourceIds: [],
    });
  }

  return {
    summary: sources.length
      ? `Ranked ${rankedTrends.length} source-backed trend cluster${rankedTrends.length === 1 ? "" : "s"}.`
      : "No source-backed trend could be ranked.",
    topTrend: rankedTrends[0].label,
    score,
    rankedTrends,
  };
}

function buildFallbackEvidenceOutput(
  topic: string,
  sources: SourceCard[],
  trend: TrendOutput
): EvidenceOutput {
  const claimMap = trend.rankedTrends.slice(0, 4).map((trendItem) => ({
    claim: trendItem.why,
    sourceIds: trendItem.sourceIds,
  }));

  return {
    bundleSummary: `Prepared an evidence bundle for "${topic}" with ${sources.length} source card${sources.length === 1 ? "" : "s"} and ${claimMap.length} mapped claim${claimMap.length === 1 ? "" : "s"}.`,
    storageStatus: "prepared",
    evidenceUri: `langclaw://evidence/${hashShort(topic)}-prepared`,
    claimMap,
  };
}

function buildFallbackVerifierOutput(
  topic: string,
  sources: SourceCard[],
  trend: TrendOutput,
  evidence: EvidenceOutput
): VerifierOutput {
  const unsupportedClaims = evidence.claimMap
    .filter((claim) => claim.sourceIds.length === 0)
    .map((claim) => claim.claim);
  const briefHashInput = createHash("sha256")
    .update(
      JSON.stringify({
        topic,
        sourceIds: sources.map((source) => source.id),
        topTrend: trend.topTrend,
        claimMap: evidence.claimMap,
      })
    )
    .digest("hex");

  return {
    verificationSummary: unsupportedClaims.length
      ? `${unsupportedClaims.length} claim${unsupportedClaims.length === 1 ? "" : "s"} need more source support before submission.`
      : "All prepared claims point to discovered source cards. Storage and chain actions are still prepared, not submitted.",
    unsupportedClaims,
    briefHashInput: `0x${briefHashInput}`,
    storageStatus: "prepared",
    chainStatus: "prepared",
  };
}

function normalizePlannerOutput(
  payload: Record<string, unknown>,
  fallback: PlannerOutput
): PlannerOutput {
  const providerPlan = Array.isArray(payload.providerPlan)
    ? payload.providerPlan
        .map((item) => {
          if (!isRecord(item)) {
            return undefined;
          }

          const provider = readProvider(item.provider);

          if (!provider) {
            return undefined;
          }

          return {
            provider,
            query: readString(item.query) || fallback.providerPlan[0].query,
            purpose: readString(item.purpose) || "Collect source-backed signals.",
          };
        })
        .filter((item): item is PlannerOutput["providerPlan"][number] =>
          Boolean(item)
        )
    : fallback.providerPlan;

  return {
    summary: readString(payload.summary) || fallback.summary,
    providerPlan: providerPlan.length ? providerPlan : fallback.providerPlan,
    scoringFocus: readStringArray(payload.scoringFocus, fallback.scoringFocus),
  };
}

function normalizeTrendOutput(
  payload: Record<string, unknown>,
  fallback: TrendOutput
): TrendOutput {
  const rankedTrends = Array.isArray(payload.rankedTrends)
    ? payload.rankedTrends
        .map((item) => {
          if (!isRecord(item)) {
            return undefined;
          }

          return {
            label: readString(item.label),
            score: clampScore(item.score),
            why: readString(item.why),
            sourceIds: readStringArray(item.sourceIds, []),
          };
        })
        .filter(
          (item): item is TrendOutput["rankedTrends"][number] =>
            Boolean(item?.label && item.why)
        )
    : fallback.rankedTrends;

  return {
    summary: readString(payload.summary) || fallback.summary,
    topTrend: readString(payload.topTrend) || rankedTrends[0]?.label || fallback.topTrend,
    score: clampScore(payload.score, fallback.score),
    rankedTrends: rankedTrends.length ? rankedTrends : fallback.rankedTrends,
  };
}

function normalizeEvidenceOutput(
  payload: Record<string, unknown>,
  fallback: EvidenceOutput
): EvidenceOutput {
  const claimMap = readClaimMap(payload.claimMap, fallback.claimMap);

  return {
    bundleSummary: readString(payload.bundleSummary) || fallback.bundleSummary,
    storageStatus: "prepared",
    evidenceUri: readString(payload.evidenceUri) || fallback.evidenceUri,
    claimMap,
  };
}

function normalizeVerifierOutput(
  payload: Record<string, unknown>,
  fallback: VerifierOutput
): VerifierOutput {
  const briefHashInput = readString(payload.briefHashInput);

  return {
    verificationSummary:
      readString(payload.verificationSummary) || fallback.verificationSummary,
    unsupportedClaims: readStringArray(
      payload.unsupportedClaims,
      fallback.unsupportedClaims
    ),
    briefHashInput:
      briefHashInput.startsWith("0x") && briefHashInput.length > 10
        ? briefHashInput
        : fallback.briefHashInput,
    storageStatus: "prepared",
    chainStatus: "prepared",
  };
}

function compactSources(sources: SourceCard[]) {
  return sources.slice(0, 16).map((source) => ({
    id: source.id,
    provider: source.provider,
    type: source.type,
    title: cleanText(source.title).slice(0, 180),
    url: source.url,
    author: source.author,
    publishedAt: source.publishedAt,
    excerpt: cleanText(source.excerpt).slice(0, 420),
    metrics: source.metrics,
  }));
}

function readProvider(value: unknown): ProviderName | undefined {
  return providers.find((provider) => provider === value);
}

function readStringArray(value: unknown, fallback: string[]) {
  if (!Array.isArray(value)) {
    return fallback;
  }

  const values = value.map(readString).filter(Boolean);

  return values.length ? values : fallback;
}

function readClaimMap(value: unknown, fallback: EvidenceOutput["claimMap"]) {
  if (!Array.isArray(value)) {
    return fallback;
  }

  const claims = value
    .map((item) => {
      if (!isRecord(item)) {
        return undefined;
      }

      const claim = readString(item.claim);

      if (!claim) {
        return undefined;
      }

      return {
        claim,
        sourceIds: readStringArray(item.sourceIds, []),
      };
    })
    .filter((item): item is EvidenceOutput["claimMap"][number] =>
      Boolean(item)
    );

  return claims.length ? claims : fallback;
}

function clampScore(value: unknown, fallback = 50) {
  const parsed =
    typeof value === "number" ? value : Number.parseInt(readString(value), 10);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(0, Math.min(100, Math.round(parsed)));
}

function hashShort(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
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
