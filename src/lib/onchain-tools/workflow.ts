import { executeOnChainPlan } from "./executor";
import { getProductChain, readChainEnv, type ProductChainId } from "../chain-config";
import { persistGenericProductProof } from "../langclaw/proof";
import { planOnChainTools, summarizePlan } from "./planner";
import {
  formatOnChainAnswer,
  synthesizeOnChainAnswer,
} from "./synthesizer";
import type {
  OnChainContextMessage,
  OnChainToolCallEvent,
  OnChainToolFinalPayload,
  OnChainToolResult,
} from "./types";
import type { ZeroGTokenUsage } from "../langclaw/types";

export async function runOnChainToolWorkflow({
  chain,
  context,
  message,
  onToolCall,
  onToolPlan,
  onToolResult,
  signal,
}: {
  chain?: string;
  context: OnChainContextMessage[];
  message: string;
  onToolCall?: (event: OnChainToolCallEvent) => void | Promise<void>;
  onToolPlan?: (plan: ReturnType<typeof summarizePlan>) => void | Promise<void>;
  onToolResult?: (event: OnChainToolResult) => void | Promise<void>;
  signal?: AbortSignal;
}): Promise<{
  content: string;
  payload: OnChainToolFinalPayload;
  tokenUsage: ZeroGTokenUsage;
}> {
  const plan = planOnChainTools({ chain, context, message });
  await onToolPlan?.(summarizePlan(plan));
  const results = await executeOnChainPlan({
    onToolCall,
    onToolResult,
    plan,
    signal,
  });
  const payload = synthesizeOnChainAnswer({ plan, results });
  const productChain = getProductChain(plan.productChain as ProductChainId);

  if (readChainEnv(productChain, "INTEL_PROOF_ENABLED") === "true") {
    payload.proof = await persistGenericProductProof({
      chain: plan.productChain,
      evidence: {
        answer: payload.answer,
        bullets: payload.bullets,
        caveat: payload.caveat,
        chainContext: {
          analysisChain: {
            chain: plan.chain,
            chainId: plan.chainId,
            chainName: plan.chainName,
            source: plan.analysisSource,
          },
          productChain: {
            chain: plan.productChain,
            chainId: plan.productChainId,
            chainName: plan.productChainName,
          },
        },
        plan: summarizePlan(plan),
        report: payload.report,
        recommendation: payload.recommendation,
        tools: results.map((result) => ({
          attemptedProviders: result.attemptedProviders,
          commandId: result.commandId,
          domain: result.domain,
          error: result.error,
          fallbackReason: result.fallbackReason,
          provider: result.provider,
          scope: result.scope,
          sourceUrl: result.sourceUrl,
          status: result.status,
          summary: result.summary,
          title: result.title,
        })),
      },
      generatedAt: payload.generatedAt,
      runId: buildOnChainRunId(),
      signalType: signalTypeForPlan(plan.intent),
      topic: message,
    });
  }
  const content = formatOnChainAnswer(payload);
  const tokenUsage = estimateOnChainTokenUsage({
    content,
    context,
    message,
    payload,
    results,
  });

  return {
    content,
    payload,
    tokenUsage,
  };
}

function estimateOnChainTokenUsage({
  content,
  context,
  message,
  payload,
  results,
}: {
  content: string;
  context: OnChainContextMessage[];
  message: string;
  payload: OnChainToolFinalPayload;
  results: OnChainToolResult[];
}): ZeroGTokenUsage {
  const inputText = [
    `${payload.plan.chainName} intelligence on-chain tool workflow on product chain ${payload.plan.productChainName}.`,
    ...context.map((item) => `${item.role}: ${item.content}`),
    `user: ${message}`,
    `plan: ${JSON.stringify(payload.plan)}`,
    `tool evidence: ${results
      .map((result) =>
        [
          result.title,
          result.provider,
          result.status,
          result.summary,
          result.sourceUrl,
          result.error,
        ]
          .filter(Boolean)
          .join(" | ")
      )
      .join("\n")}`,
  ].join("\n");
  const inputTokens = estimateTokens(inputText);
  const outputTokens = estimateTokens(content);

  return {
    completionTokens: outputTokens,
    inputTokens,
    outputTokens,
    promptTokens: inputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

function estimateTokens(text: string) {
  return Math.max(1, Math.ceil(text.length / 4));
}

function buildOnChainRunId() {
  return `intel_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function signalTypeForPlan(intent: string) {
  if (intent === "wallet") {
    return "smart-money";
  }

  if (intent === "smart-money") {
    return "smart-money";
  }

  if (intent === "defi") {
    return "tvl-yield-momentum";
  }

  if (intent === "security") {
    return "risk-signal";
  }

  if (intent === "trading-signal") {
    return "liquidity-anomaly";
  }

  return "sui-alpha";
}
