import type { OpenAITextFormat } from "../openai/responses";
import { detectResponseLanguage } from "../response-language";
import {
  isRecord,
  parseLooseJson,
  readPositiveInt,
  readString,
  runOpenClawAgentJson,
} from "./openclaw-runner";
import {
  buildFinalAnswerGuardrails,
  applyFinalAnswerGuardrails,
} from "./final-answer-guardrails";
import type {
  AgentOutputs,
  DiscoverSignals,
  FinalAnswer,
  FinalAnswerMeta,
  OrchestrationRuntime,
  OrchestrationStep,
  ProviderError,
  ProviderTraceEntry,
  ResearchReport,
  SourceCard,
} from "./types";
import type {
  OnChainToolFinalPayload,
  OnChainToolResult,
} from "../onchain-tools/types";

export type OpenClawFinalAnswerInput = {
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
  sessionId?: string;
};

type OpenClawFinalAnswerResult = {
  finalAnswer?: FinalAnswer;
  meta: FinalAnswerMeta;
};

export async function synthesizeFinalAnswerWithOpenClaw(
  input: OpenClawFinalAnswerInput
): Promise<OpenClawFinalAnswerResult> {
  const requestedSessionId =
    input.sessionId ||
    process.env.OPENCLAW_AGENT_SESSION_ID ||
    "langclaw-final-answer";

  if (process.env.OPENCLAW_ENABLED !== "true") {
    return {
      meta: {
        synthesis: "deterministic-fallback",
        execution: "deterministic-fallback",
        sessionId: requestedSessionId,
        error: "OPENCLAW_ENABLED is false.",
      },
    };
  }

  if (process.env.OPENCLAW_AI_SYNTHESIS === "false") {
    return {
      meta: {
        synthesis: "deterministic-fallback",
        execution: "deterministic-fallback",
        sessionId: requestedSessionId,
        error: "OPENCLAW_AI_SYNTHESIS is false.",
      },
    };
  }

  const timeoutSeconds = readPositiveInt(
    process.env.OPENCLAW_AGENT_TIMEOUT_SECONDS,
    90
  );
  const thinking = process.env.OPENCLAW_AGENT_THINKING || "low";
  const model = process.env.OPENCLAW_MODEL?.trim();
  const prompt = buildFinalAnswerPrompt(input);

  const result = await runOpenClawAgentJson({
    prompt,
    sessionId: requestedSessionId,
    model,
    thinking,
    timeoutSeconds,
  });
  const finalAnswer = parseFinalAnswer(result.text);

  if (finalAnswer) {
    return {
      finalAnswer: applyFinalAnswerGuardrails(finalAnswer, {
        errors: input.errors,
        onChain: input.onChain,
        onChainSkippedReason: input.onChainSkippedReason,
        providerTrace: input.providerTrace,
        report: input.report,
        signals: input.signals,
      }),
      meta: {
        synthesis: "openclaw-ai",
        execution: "openclaw-agent",
        model: result.meta.model,
        sessionId: result.meta.sessionId,
        transport: result.meta.transport,
        fallbackFrom: result.meta.fallbackFrom,
      },
    };
  }

  return {
    meta: {
      synthesis: "deterministic-fallback",
      execution: "deterministic-fallback",
      model: result.meta.model || model || undefined,
      sessionId: result.meta.sessionId,
      error: result.meta.error || "OpenClaw model did not return a valid finalAnswer JSON object.",
    },
  };
}

type FinalAnswerPromptOptions = {
  compact?: boolean;
};

export const DEFAULT_AGENT_MAX_OUTPUT_TOKENS = 4096;

export function buildFinalAnswerPrompt(
  input: OpenClawFinalAnswerInput,
  options: FinalAnswerPromptOptions = {}
) {
  const compact = options.compact === true;
  const guardrails = buildFinalAnswerGuardrails({
    errors: input.errors,
    onChain: input.onChain,
    onChainSkippedReason: input.onChainSkippedReason,
    providerTrace: input.providerTrace,
    report: input.report,
    signals: input.signals,
  });
  const responseLanguage = detectResponseLanguage(input.topic);
  const excerptLimit = compact ? 320 : 700;
  const sources = (compact ? input.sources.slice(0, 10) : input.sources).map(
    (source) => ({
      id: source.id,
      type: source.type,
      title: cleanText(source.title),
      url: source.url,
      author: source.author,
      publishedAt: source.publishedAt,
      excerpt: cleanText(source.excerpt).slice(0, excerptLimit),
      metrics: source.metrics,
      provider: source.provider,
    })
  );
  const evidence = {
    topic: input.topic,
    responseLanguage,
    providerCoverage: summarizeProviderCoverage(input.sources),
    providerErrors: input.errors.map((error) => ({
      message: sanitizeProviderIssueForPrompt(error.message),
      provider: error.provider,
    })),
    sources,
    orchestration: {
      runtime: input.runtime,
      steps: compact
        ? input.steps.map((step) => ({
            agent: step.agent,
            status: step.status,
            summary: cleanText(step.summary).slice(0, 160),
          }))
        : input.steps,
    },
    agentOutputs: compact
      ? compactAgentOutputs(input.agentOutputs)
      : input.agentOutputs,
    signals: input.signals,
    report: compact
      ? compactResearchReport(input.report)
      : input.report ?? null,
    guardrails,
    onChainEnrichment: compact
      ? compactOnChainEnrichment(input.onChain, input.onChainSkippedReason)
      : input.onChain
        ? {
            answer: input.onChain.answer,
            attemptedProviders: input.onChain.tools.map(compactOnChainToolForSynthesis),
            caveat: input.onChain.caveat,
            chain: input.onChain.plan.chain,
            capabilities: input.onChain.plan.capabilities,
            intent: input.onChain.plan.intent,
            providerTrace: input.onChain.providerTrace?.map((entry) => ({
              ...entry,
              message: sanitizeProviderIssueForPrompt(entry.message),
            })),
            recommendation: input.onChain.recommendation,
            toolCount: input.onChain.tools.length,
          }
        : {
            skippedReason:
              input.onChainSkippedReason ||
              "No on-chain enrichment was executed.",
          },
    ...(compact && input.sources.length > sources.length
      ? {
          omittedSourceCount: input.sources.length - sources.length,
        }
      : {}),
    ...(compact && input.providerTrace?.length
      ? {
          providerTrace: input.providerTrace.slice(0, 12).map((entry) => ({
            message: sanitizeProviderIssueForPrompt(entry.message),
            provider: entry.provider,
            scope: entry.scope,
            status: entry.status,
          })),
        }
      : {}),
  };

  return [
    "You are Langclaw's Final Conclusion Agent.",
    "Write the final answer as a natural AI chat response, not a dashboard card.",
    "Write natural Markdown with flexible structure. Short paragraphs and bullets are allowed when they help readability.",
    "For smart-money accumulation requests, write a title line, short opening read, then Read, Evidence, Candidates, Limits, and Conclusion sections.",
    "For smart-money answers with direct rows, Evidence should include a compact Markdown evidence table that summarizes source, rows parsed, token bucket, flow type, classification, and unavailable checks.",
    "For smart-money answers with direct rows, include only the wallets, token flows, amounts, labels, categories, diagnostics, and time windows present in the report entities or tables. Put the compact top-5 shortlist as a Markdown table under Candidates.",
    "Do not render smart-money candidate rows as bullet lists when row data exists. Use the table from report.tables instead.",
    "Read, Limits, and Conclusion must be short paragraphs, not bullet lists.",
    "Limits must be specific to the analysis: mention chain or token coverage gaps, wallet labeling gaps, sample window, unavailable checks, and why the classification is watchlist or candidate rather than confirmed.",
    "Do not use the phrase 'this run' in titles, paragraphs, caveats, or conclusions.",
    "Do not expose internal provider errors, billing errors, HTTP status codes, stack traces, fallback route names, API keys, raw JSON errors, or provider setup problems in user-visible prose.",
    "If the only evidence is DEX buy rows without wallet labels, retention, or sell-pressure checks, call them large DEX-buy candidates or large-flow watchlist rows, not smart-money candidates.",
    "For smart-money answers with empty direct wallet-flow rows, keep the same section shape, say the signal is weak, and explain which standard checks were unavailable. Do not ask the user to rerun the same task for standard checks.",
    "Never describe the answer format using competitor branding or style labels.",
    "Do not expose internal snake_case labels in visible prose. Use human-readable section titles and status labels.",
    "Use a hyphen, not an em dash.",
    "Do not write dense paragraphs. Do not put markdown tables into JSON string fields unless they are necessary and valid.",
    "Use only the evidence in the input JSON. Do not invent facts, numbers, dates, providers, URLs, or claims.",
    "Treat the report object as supporting context for the answer. Use it to stay grounded, but keep conclusion user-facing rather than report-shaped.",
    "Use onChainEnrichment.capabilities to decide whether the answer should present a candidate ranking, dynamic ability research, directional research, or a coverage gap.",
    "If evidence is weak, explain the coverage gap clearly in the conclusion without raw provider error logs.",
    "For smart-money requests with empty direct wallet-flow rows, keep the answer useful: say the smart-money signal is weak, name the missing row-level source, and list unavailable checks.",
    "Do not write hard-negative smart-money phrasing such as 'Belum ada bukti akumulasi terverifikasi' or 'no verified accumulation evidence'.",
    "For empty smart-money rows, do not write raw fallback text such as 'no usable smart-money rows', 'provider failed', or 'failed providers'.",
    "Do not turn empty smart-money rows into wallet rankings, token flow claims, or confirmation language.",
    "Do not end smart-money answers by telling the user to rerun the same task for wallet label lookup, retention, sell pressure, exchange-flow checks, wallet net worth, wallet history, or second-source validation.",
    "If ranked entities exist, prefer a best-effort shortlist with explicit gaps instead of saying no ranking is available.",
    "The backend handles caveat metadata separately, so do not add a caveat field or a trailing Caveat paragraph.",
    "Do not claim any evidenceUri, storage upload, prepared or anchored Sui proof, Sui anchoring, chain write, or transaction submission state in conclusion. Proof state is reported separately by the workflow payload.",
    `Detected response language: ${responseLanguage.label} (${responseLanguage.confidence}). ${responseLanguage.instruction}`,
    "Mirror the latest user message's language for all user-visible headings, bullets, caveats, and next steps.",
    "Return only valid JSON. Do not wrap it in markdown. Do not add commentary outside JSON.",
    "",
    "Required JSON shape:",
    JSON.stringify(
      {
        conclusion:
          "natural markdown answer for the user, including concise evidence and a practical next step when helpful",
      },
      null,
      2
    ),
    "",
    "Input JSON:",
    JSON.stringify(evidence, null, 2),
  ].join("\n");
}

export const FINAL_ANSWER_OPENAI_TEXT_FORMAT: OpenAITextFormat = {
  type: "json_schema",
  name: "langclaw_final_answer",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      conclusion: {
        type: "string",
        description:
          "Natural markdown answer for the user, including concise evidence and a practical next step when helpful.",
      },
    },
    required: ["conclusion"],
  },
};

export function describeFinalAnswerParseFailure(text: string) {
  const trimmed = text.trim();

  if (!trimmed) {
    return "OpenAI returned empty synthesis output.";
  }

  if (looksLikeBrokenJson(trimmed)) {
    return "OpenAI returned malformed or truncated finalAnswer JSON.";
  }

  if (trimmed.length >= 40) {
    return "OpenAI returned non-JSON synthesis output.";
  }

  return "OpenAI did not return a valid finalAnswer JSON object.";
}

export function parseFinalAnswer(text: string): FinalAnswer | undefined {
  const parsed = parseLooseJson(text);
  const fromJson = normalizeFinalAnswerRecord(
    isRecord(parsed) && isRecord(parsed.finalAnswer)
      ? parsed.finalAnswer
      : isRecord(parsed)
        ? parsed
        : typeof parsed === "string"
          ? { answerMarkdown: parsed }
          : undefined
  );

  if (fromJson) {
    return fromJson;
  }

  return parseProseFinalAnswer(text);
}

function normalizeFinalAnswerRecord(
  candidate: Record<string, unknown> | undefined
): FinalAnswer | undefined {
  if (!candidate) {
    return undefined;
  }

  const title = normalizeOptionalText(
    readString(candidate.title) || readString(candidate.headline)
  );
  const conclusion = normalizeOptionalText(readString(candidate.conclusion));
  const answer = normalizeOptionalText(
    readString(candidate.answer) || readString(candidate.summary)
  );
  const answerMarkdown = normalizeOptionalText(
    conclusion ||
      readString(candidate.answerMarkdown) ||
      readString(candidate.content) ||
      readString(candidate.markdown)
  );
  const recommendation = normalizeOptionalText(readString(candidate.recommendation));
  const caveat = normalizeOptionalText(readString(candidate.caveat));
  const bullets = Array.isArray(candidate.bullets)
    ? candidate.bullets.map(readString).filter(Boolean).slice(0, 6)
    : [];

  const normalizedAnswer =
    answerMarkdown ||
    answer ||
    buildLegacyAnswerMarkdown({
      answer,
      bullets,
      caveat,
      recommendation,
      title,
    });

  if (!normalizedAnswer) {
    return undefined;
  }

  return {
    title,
    answer: conclusion || answer || normalizedAnswer,
    answerMarkdown: normalizedAnswer,
    bullets,
    recommendation,
    caveat,
    generatedBy: "Final Conclusion Agent" as const,
  };
}

function parseProseFinalAnswer(text: string): FinalAnswer | undefined {
  const trimmed = text.trim();

  if (!trimmed || looksLikeBrokenJson(trimmed)) {
    return undefined;
  }

  return normalizeFinalAnswerRecord({
    answerMarkdown: trimmed,
  });
}

function looksLikeBrokenJson(text: string) {
  const trimmed = text.trim();

  return (
    trimmed.startsWith("{") ||
    trimmed.startsWith("[") ||
    /"answerMarkdown"\s*:/.test(trimmed) ||
    /"finalAnswer"\s*:/.test(trimmed)
  );
}

function buildLegacyAnswerMarkdown({
  answer,
  bullets,
  caveat,
  recommendation,
  title,
}: {
  answer?: string;
  bullets: string[];
  caveat?: string;
  recommendation?: string;
  title?: string;
}) {
  if (!answer && !bullets.length && !recommendation && !caveat) {
    return undefined;
  }

  return [
    title ? `## ${title}` : "",
    answer || "",
    bullets.length
      ? ["", ...bullets.map((bullet) => `- ${bullet}`)].join("\n")
      : "",
    recommendation ? `\nWhat would improve confidence: ${recommendation}` : "",
    caveat ? `\nCaveat: ${caveat}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeOptionalText(value: string | undefined) {
  const normalized = value?.trim();

  return normalized ? normalized : undefined;
}

function compactAgentOutputs(agentOutputs: AgentOutputs | undefined) {
  if (!agentOutputs) {
    return undefined;
  }

  return {
    planner: agentOutputs.planner
      ? { summary: cleanText(agentOutputs.planner.summary).slice(0, 240) }
      : undefined,
    trend: agentOutputs.trend
      ? {
          summary: cleanText(agentOutputs.trend.summary).slice(0, 240),
          topTrend: agentOutputs.trend.topTrend,
          score: agentOutputs.trend.score,
        }
      : undefined,
    evidence: agentOutputs.evidence
      ? { bundleSummary: cleanText(agentOutputs.evidence.bundleSummary).slice(0, 240) }
      : undefined,
    verifier: agentOutputs.verifier
      ? {
          verificationSummary: cleanText(
            agentOutputs.verifier.verificationSummary
          ).slice(0, 240),
        }
      : undefined,
  };
}

function compactResearchReport(report: ResearchReport | undefined) {
  if (!report) {
    return null;
  }

  return {
    asOfUtc: report.asOfUtc,
    bottomLine: cleanText(report.bottomLine).slice(0, 400),
    caveats: report.caveats.slice(0, 4).map((caveat) => cleanText(caveat).slice(0, 200)),
    confidence: report.confidence,
    entities: report.entities.slice(0, 5).map((entity) => ({
      metrics: compactMetricRecord(entity.metrics),
      label: entity.label,
      rank: entity.rank,
      severity: entity.severity,
      summary: cleanText(entity.summary).slice(0, 180),
    })),
    executiveSummary: cleanText(report.executiveSummary).slice(0, 500),
    kind: report.kind,
    recommendations: report.recommendations
      .slice(0, 3)
      .map((recommendation) => cleanText(recommendation).slice(0, 200)),
    sections: report.sections.slice(0, 12).map((section) => ({
      markdown: cleanText(section.markdown).slice(0, 280),
      title: section.title,
    })),
    tables: report.tables.slice(0, 2).map((table) => ({
      columns: table.columns.slice(0, 8),
      rows: table.rows.slice(0, 3).map((row) => compactTableRow(row, table.columns)),
      title: table.title,
    })),
    title: report.title,
  };
}

function sanitizeProviderIssueForPrompt(message: string) {
  const compact = cleanText(message);

  if (
    /\b(?:401|402|403|429|5\d\d)\b|payment|required|credit|billing|api[_\s-]?key|token|unauthorized|forbidden/i.test(
      compact
    )
  ) {
    return "Source unavailable.";
  }

  if (/row-level smart-money|wallet-flow coverage/i.test(compact)) {
    return "Row-level wallet-flow coverage was unavailable.";
  }

  return compact.slice(0, 120);
}

function compactOnChainEnrichment(
  onChain: OnChainToolFinalPayload | undefined,
  onChainSkippedReason: string | undefined
) {
  if (!onChain) {
    return {
      skippedReason:
        onChainSkippedReason || "No on-chain enrichment was executed.",
    };
  }

  return {
    answer: cleanText(onChain.answer).slice(0, 500),
    caveat: cleanText(onChain.caveat).slice(0, 240),
    chain: onChain.plan.chain,
    capabilities: onChain.plan.capabilities,
    intent: onChain.plan.intent,
    rankingBasis:
      onChain.report?.sections
        .find((section) => section.id === "signal-summary")
        ?.markdown.replace(/\s+/g, " ")
        .trim()
        .slice(0, 220) || undefined,
    recommendation: cleanText(onChain.recommendation).slice(0, 240),
    topProtocols: onChain.report?.entities.slice(0, 3).map((entity) => ({
      coverage: readMetricValue(entity.metrics, "coverage"),
      label: entity.label,
      metrics: compactMetricRecord(entity.metrics),
      rank: entity.rank,
      severity: entity.severity,
    })),
    topRankedEntities: onChain.report?.entities.slice(0, 5).map((entity) => ({
      category: entity.category,
      coverage: readMetricValue(entity.metrics, "coverage"),
      label: entity.label,
      metrics: compactMetricRecord(entity.metrics),
      rank: entity.rank,
      severity: entity.severity,
    })),
    toolCount: onChain.tools.length,
    tools: onChain.tools.slice(0, 8).map(compactOnChainToolForSynthesis),
  };
}

function compactOnChainToolForSynthesis(tool: OnChainToolResult) {
  const isSmartMoneyGap =
    tool.domain === "smart_money" &&
    tool.provider !== "local" &&
    tool.status !== "success";
  const summary = isSmartMoneyGap
    ? "Row-level wallet-flow coverage was unavailable."
    : cleanText(tool.summary).slice(0, 160);

  return {
    attemptedProviders: tool.attemptedProviders,
    commandId: tool.commandId,
    fallbackReason: isSmartMoneyGap ? undefined : tool.fallbackReason,
    provider: tool.provider,
    scope: tool.scope,
    status: tool.status,
    summary,
    title: tool.title,
  };
}

function summarizeProviderCoverage(sources: SourceCard[]) {
  const counts = new Map<SourceCard["provider"], number>();

  for (const source of sources) {
    counts.set(source.provider, (counts.get(source.provider) ?? 0) + 1);
  }

  return ["X", "GitHub", "Tavily", "HackQuest"].map((provider) => ({
    provider,
    count: counts.get(provider as SourceCard["provider"]) ?? 0,
  }));
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

function compactMetricRecord(metrics: Record<string, string | number | null>) {
  const priorityKeys = [
    "score",
    "wallet",
    "address",
    "token",
    "symbol",
    "signal",
    "netMnt",
    "netUsd",
    "netAmount",
    "net_amount",
    "amount",
    "usd",
    "trades",
    "transfers",
    "window",
    "sourceCex",
    "confidence",
    "tvlUsd",
    "bestApy",
    "momentumScore",
    "poolCount",
    "coverage",
  ];
  const compact: Record<string, string | number | null> = {};

  for (const key of priorityKeys) {
    if (key in metrics) {
      compact[key] = metrics[key];
    }
  }

  if (Object.keys(compact).length > 0) {
    return compact;
  }

  for (const [key, value] of Object.entries(metrics).slice(0, 6)) {
    compact[key] = value;
  }

  return compact;
}

function compactTableRow(
  row: Record<string, string | number | null>,
  columns: string[]
) {
  const compact: Record<string, string | number | null> = {};

  for (const column of columns.slice(0, 8)) {
    compact[column] = row[column];
  }

  return compact;
}

function readMetricValue(
  metrics: Record<string, string | number | null>,
  key: string
) {
  return key in metrics ? metrics[key] : undefined;
}
