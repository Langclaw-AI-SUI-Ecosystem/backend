import {
  createOpenAITextResponse,
  getDefaultOpenAIModel,
  getOpenAIBaseUrl,
  hasOpenAIApiKey,
} from "../openai/responses";
import { resolveOpenAIModelSelection } from "../openai-direct-chat";
import { applyFinalAnswerGuardrails } from "./final-answer-guardrails";
import {
  buildFinalAnswerPrompt,
  DEFAULT_AGENT_MAX_OUTPUT_TOKENS,
  describeFinalAnswerParseFailure,
  FINAL_ANSWER_OPENAI_TEXT_FORMAT,
  parseFinalAnswer,
} from "./openclaw-ai";
import { sanitizeError } from "./openclaw-runner";
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
  ZeroGComputeProof,
} from "./types";
import type { OnChainToolFinalPayload } from "../onchain-tools/types";

type OpenAISynthesisInput = {
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
};

type OpenAISynthesisResult = {
  finalAnswer?: FinalAnswer;
  meta: FinalAnswerMeta;
  compute: ZeroGComputeProof;
};

export async function synthesizeFinalAnswerWithOpenAI(
  input: OpenAISynthesisInput
): Promise<OpenAISynthesisResult> {
  const endpoint = getOpenAIBaseUrl();
  const selection = resolveOpenAIModelSelection(
    input.requestedModel ?? process.env.OPENAI_AGENT_MODEL?.trim(),
    "agent"
  );
  const model = selection.usedModel || getDefaultOpenAIModel("agent");

  if (!hasOpenAIApiKey()) {
    return skippedSynthesis(selection, endpoint, "OPENAI_API_KEY is empty.");
  }

  try {
    const result = await requestFinalAnswerFromOpenAI(input, model);
    const finalAnswer = parseFinalAnswer(result.text);

    if (!finalAnswer) {
      throw new Error(describeFinalAnswerParseFailure(result.text));
    }

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
        synthesis: "openai",
        execution: "openai",
        fallbackFrom: selection.fallbackFrom,
        model: result.model || model,
        modelHonored: selection.modelHonored,
        requestedModel: selection.requestedModel,
        transport: "openai-responses",
        usedModel: result.model || model,
      },
      compute: {
        status: "used",
        endpoint,
        fallbackFrom: selection.fallbackFrom,
        model: result.model || model,
        modelHonored: selection.modelHonored,
        provider: "OpenAI",
        requestId: result.id,
        requestedModel: selection.requestedModel,
        usedModel: result.model || model,
        usage: result.usage,
      },
    };
  } catch (error) {
    const detail = sanitizeError(
      error instanceof Error ? error.message : String(error)
    );

    return {
      meta: {
        synthesis: "deterministic-fallback",
        execution: "deterministic-fallback",
        fallbackFrom: selection.fallbackFrom,
        model,
        modelHonored: selection.modelHonored,
        requestedModel: selection.requestedModel,
        transport: "openai-responses",
        error: detail || "OpenAI request failed.",
        usedModel: model,
      },
      compute: {
        status: "failed",
        endpoint,
        error: detail || "OpenAI request failed.",
        fallbackFrom: selection.fallbackFrom,
        model,
        modelHonored: selection.modelHonored,
        provider: "OpenAI",
        requestedModel: selection.requestedModel,
        usedModel: model,
      },
    };
  }
}

function skippedSynthesis(
  selection: ReturnType<typeof resolveOpenAIModelSelection>,
  endpoint: string,
  error: string
): OpenAISynthesisResult {
  const model = selection.usedModel;

  return {
    meta: {
      synthesis: "deterministic-fallback",
      execution: "deterministic-fallback",
      fallbackFrom: selection.fallbackFrom,
      model,
      modelHonored: selection.modelHonored,
      requestedModel: selection.requestedModel,
      transport: "openai-responses",
      error,
      usedModel: model,
    },
    compute: {
      status: "skipped",
      endpoint,
      error,
      fallbackFrom: selection.fallbackFrom,
      model,
      modelHonored: selection.modelHonored,
      provider: "OpenAI",
      requestedModel: selection.requestedModel,
      usedModel: model,
    },
  };
}

async function requestFinalAnswerFromOpenAI(
  input: OpenAISynthesisInput,
  model: string
) {
  const baseTokens = readAgentMaxOutputTokens();
  const boostedTokens = Math.min(Math.max(baseTokens * 2, 6144), 12000);
  const instructions =
    "You are Langclaw's Final Conclusion Agent. Return only valid JSON matching the required schema. Keep conclusion concise.";
  let lastError: Error | undefined;

  const runAttempt = async ({
    compact,
    maxOutputTokens,
    textFormat,
  }: {
    compact: boolean;
    maxOutputTokens: number;
    textFormat: typeof FINAL_ANSWER_OPENAI_TEXT_FORMAT | { type: "json_object" };
  }) => {
    const result = await createOpenAITextResponse({
      input: buildFinalAnswerPrompt(input, { compact }),
      instructions,
      maxOutputTokens,
      model,
      textFormat,
    });

    if (isUsableSynthesisResponse(result)) {
      return result;
    }

    throw new Error(
      "OpenAI synthesis response was incomplete before a valid final answer JSON object was produced."
    );
  };

  const attemptStrategies: Array<{
    compact: boolean;
    maxOutputTokens: number;
    textFormat: typeof FINAL_ANSWER_OPENAI_TEXT_FORMAT | { type: "json_object" };
  }> = [
    { compact: false, maxOutputTokens: baseTokens, textFormat: FINAL_ANSWER_OPENAI_TEXT_FORMAT },
    { compact: false, maxOutputTokens: baseTokens, textFormat: { type: "json_object" } },
    { compact: true, maxOutputTokens: boostedTokens, textFormat: FINAL_ANSWER_OPENAI_TEXT_FORMAT },
    { compact: true, maxOutputTokens: boostedTokens, textFormat: { type: "json_object" } },
  ];

  for (const [index, strategy] of attemptStrategies.entries()) {
    try {
      return await runAttempt(strategy);
    } catch (error) {
      const detail = sanitizeError(
        error instanceof Error ? error.message : String(error)
      );
      lastError = error instanceof Error ? error : new Error(detail);

      if (
        index === 0 &&
        shouldRetryFinalAnswerWithoutSchema(detail) &&
        !isRecoverableSynthesisFailure(detail)
      ) {
        continue;
      }

      if (!isRecoverableSynthesisFailure(detail)) {
        throw error;
      }
    }
  }

  throw (
    lastError ??
    new Error(
      "OpenAI synthesis failed after retries. Increase OPENAI_AGENT_MAX_OUTPUT_TOKENS or shorten the research payload."
    )
  );
}

function isUsableSynthesisResponse(
  result: Awaited<ReturnType<typeof createOpenAITextResponse>>
) {
  return !result.incomplete || Boolean(parseFinalAnswer(result.text));
}

function readAgentMaxOutputTokens() {
  return readPositiveInt(
    process.env.OPENAI_AGENT_MAX_OUTPUT_TOKENS,
    DEFAULT_AGENT_MAX_OUTPUT_TOKENS
  );
}

function isRecoverableSynthesisFailure(detail: string) {
  return /incomplete|max_output_tokens|length limit|context length|too large/i.test(
    detail
  );
}

function shouldRetryFinalAnswerWithoutSchema(detail: string) {
  return /json_schema|structured|text\.format|response_format|unsupported/i.test(
    detail
  );
}

function readPositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? "", 10);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
