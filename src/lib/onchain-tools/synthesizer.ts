import { onChainDomainLabels } from "./registry";
import { summarizePlan } from "./planner";
import {
  isDirectProviderIssue,
  isUsableDirectProviderResult,
} from "./evidence";
import { buildOnChainResearchReport } from "../langclaw/report";
import type {
  OnChainPlan,
  OnChainToolFinalPayload,
  OnChainToolResult,
} from "./types";

export function synthesizeOnChainAnswer({
  plan,
  results,
}: {
  plan: OnChainPlan;
  results: OnChainToolResult[];
}): OnChainToolFinalPayload {
  const successful = results.filter((result) => result.status === "success");
  const failed = results.filter((result) => result.status === "failed");
  const usableDirect = results.filter(isUsableDirectProviderResult);
  const directIssues = results.filter(isDirectProviderIssue);
  const domains = Array.from(new Set(results.map((result) => result.domain)));
  const domainText = domains.map((domain) => onChainDomainLabels[domain]).join(", ");
  const chainName = plan.chainName || plan.chain;
  const title = titleFor(plan.intent, chainName);
  const bullets = buildBullets(results, plan);
  const isSmartMoneyWithoutRows =
    plan.intent === "smart-money" && usableDirect.length === 0;
  const answer =
    usableDirect.length > 0
      ? `I ran ${results.length} ${chainName} intelligence tools across ${domainText || "selected domains"} for ${plan.chain}. ${usableDirect.length} direct provider result(s) returned usable evidence.`
      : isSmartMoneyWithoutRows
        ? `I ran ${results.length} ${chainName} intelligence tools for ${plan.chain}. Smart-money signal is still weak because direct wallet-flow rows were not available.`
      : `I tried ${results.length} ${chainName} intelligence tools for ${plan.chain}, but no provider returned usable evidence.`;
  const caveat = buildCaveat(directIssues.length ? directIssues : failed, plan);
  const recommendation = buildRecommendation(
    plan.intent,
    usableDirect,
    directIssues,
    plan
  );
  const report = buildOnChainResearchReport({
    answer,
    caveat,
    generatedAt: new Date().toISOString(),
    plan: summarizePlan(plan),
    recommendation,
    tools: results,
  });

  return {
    answer,
    bullets,
    caveat,
    generatedAt: report.asOfUtc,
    plan: summarizePlan(plan),
    providerTrace: buildProviderTrace(plan, results),
    recommendation,
    report,
    title,
    tools: results,
  };
}

export function formatOnChainAnswer(payload: OnChainToolFinalPayload) {
  const showCaveat = payload.report?.kind !== "smart-money";
  const lines = [
    payload.answer,
    "",
    ...payload.bullets.slice(0, 5).map((bullet) => `- ${bullet}`),
    "",
    `Recommendation: ${payload.recommendation}`,
    ...(showCaveat ? ["", `Caveat: ${payload.caveat}`] : []),
  ];

  return lines.filter(Boolean).join("\n");
}

function titleFor(intent: string, chainName: string) {
  if (intent === "wallet") {
    return `${chainName} wallet intelligence`;
  }

  if (intent === "smart-money") {
    return `${chainName} smart money analysis`;
  }

  if (intent === "security") {
    return `${chainName} security analysis`;
  }

  if (intent === "defi") {
    return `${chainName} DeFi intelligence`;
  }

  if (intent === "trading-signal") {
    return `${chainName} alpha signal analysis`;
  }

  return `${chainName} token intelligence`;
}

function buildBullets(results: OnChainToolResult[], plan: OnChainPlan) {
  const successful = results.filter((result) => result.status === "success");
  const failed = results.filter((result) => result.status === "failed");
  const usableDirect = results.filter(isUsableDirectProviderResult);
  const directIssues = results.filter(isDirectProviderIssue);
  const confidence =
    usableDirect.length >= 4 && !directIssues.length
      ? "High"
      : usableDirect.length >= 2
        ? "Medium"
        : usableDirect.length === 1
          ? "Low"
          : "Insufficient";
  const evidence = usableDirect.length
    ? usableDirect
        .slice(0, 4)
        .map((result) => `${result.title} (${result.provider})`)
        .join("; ")
    : plan.intent === "smart-money"
      ? "Direct wallet-flow rows were not available."
      : "No provider returned usable source data.";
  const sourceBullets = results.slice(0, 8).map((result) => {
    const status = result.status === "success" ? "Evidence" : "Source gap";
    const source = result.sourceUrl ? ` Source: ${result.sourceUrl}` : "";
    const summary =
      plan.intent === "smart-money" && isDirectProviderIssue(result)
        ? "row-level wallet-flow coverage was unavailable."
        : result.summary;

    return `${status}: ${result.title} (${result.provider}) - ${summary}${source}`;
  });

  return [
    `Signal: ${summarizeSignal(results)}.`,
    `Evidence: ${evidence}`,
    `Confidence: ${confidence}, based on ${usableDirect.length} usable direct result(s) and ${directIssues.length || failed.length} source gap(s).`,
    `Risk note: ${buildRiskNote(directIssues.length ? directIssues : failed, plan)}`,
    `Recommended watch/action: ${buildWatchAction(usableDirect, directIssues.length ? directIssues : failed, plan)}`,
    ...(sourceBullets.length ? sourceBullets : ["Source gap: No tool output was available."]),
  ];
}

function buildRecommendation(
  intent: string,
  successful: OnChainToolResult[],
  failed: OnChainToolResult[],
  plan: OnChainPlan
) {
  const chainName = plan.chainName || plan.chain;

  if (intent === "smart-money") {
    if (!successful.length) {
      return `Keep this as coverage-limited smart-money research on ${chainName}. Standard follow-up checks were attempted where row data existed; unavailable checks are listed in the report.`;
    }

    return "Use confirmed smart-money only when labels, retention, sell pressure, and second-source checks support it. Keep DEX-only rows in the large-flow watchlist.";
  }

  if (!successful.length) {
    return `Do not make a decision from this analysis. Add a ${chainName} token address, wallet address, or configured Dune query and run it again.`;
  }

  if (intent === "trading-signal") {
    return `Use this as analysis only. Confirm ${chainName} liquidity, holder flow, and security flags before any manual trading decision.`;
  }

  if (intent === "security") {
    return "Prioritize high-risk flags first. Treat clean results as preliminary until verified with a second source.";
  }

  if (failed.length) {
    return "Use the successful provider data, then rerun after fixing the failed provider configuration for fuller coverage.";
  }

  return "Use these source-backed results as a starting point for deeper manual review.";
}

function buildCaveat(failed: OnChainToolResult[], plan: OnChainPlan) {
  const providerGap = plan.providerGaps?.length
    ? " Coverage is limited by available row-level data."
    : "";

  if (!failed.length) {
    return `Analysis only. No transaction was signed or executed.${providerGap}`;
  }

  if (plan.intent === "smart-money") {
    return `Smart-money coverage is partial because row-level wallet-flow checks were incomplete. No transaction was signed or executed.${providerGap}`;
  }

  return `Analysis only. ${failed.length} source gap(s) limited confidence. No transaction was signed or executed.${providerGap}`;
}

function summarizeSignal(results: OnChainToolResult[]) {
  const successful = results.find((result) => result.status === "success");

  if (!successful) {
    return "insufficient alpha evidence";
  }

  if (results.some((result) => result.domain === "smart_money")) {
    if (!results.some(isUsableDirectProviderResult)) {
      return "smart-money signal needs more direct wallet-flow rows";
    }

    return "smart-money or holder-flow activity needs monitoring";
  }

  if (results.some((result) => result.domain === "pair_liquidity")) {
    return "liquidity and volume conditions need monitoring";
  }

  if (results.some((result) => result.domain === "defi_tvl" || result.domain === "yield_pools")) {
    return "protocol TVL or yield momentum is the main watch area";
  }

  if (results.some((result) => result.domain === "trading_signal_analysis")) {
    return "market, liquidity, and risk evidence can support an alpha watchlist";
  }

  return "token or protocol activity has usable evidence";
}

function buildRiskNote(failed: OnChainToolResult[], plan: OnChainPlan) {
  const providerGap = plan.providerGaps?.length
    ? " Some row-level data sources were unavailable."
    : "";

  if (!failed.length) {
    return `No failed provider calls were reported, but the result is still a point-in-time analysis.${providerGap}`;
  }

  const providers = Array.from(new Set(failed.map((result) => result.provider))).join(", ");

  if (plan.intent === "smart-money") {
    return `Row-level wallet-flow coverage from ${providers} was incomplete; treat unsupported accumulation claims as hypotheses.${providerGap}`;
  }

  return `Source coverage gaps reduce confidence; treat unsupported claims as hypotheses.${providerGap}`;
}

function buildWatchAction(
  successful: OnChainToolResult[],
  failed: OnChainToolResult[],
  plan: OnChainPlan
) {
  const chainName = plan.chainName || plan.chain;

  if (!successful.length) {
    return plan.intent === "smart-money"
      ? `record which ${chainName} wallet-flow checks were unavailable before making a smart-money claim.`
      : `rerun with a specific ${chainName} wallet, token, pair, or Dune query.`;
  }

  if (failed.length) {
    return plan.intent === "smart-money"
      ? "track successful rows now and keep unavailable enrichment checks explicit."
      : "track the successful evidence now, then rerun after fixing provider inputs for fuller coverage.";
  }

  return `add the strongest signal to the ${chainName} Alpha watchlist and record the decision proof.`;
}

function buildProviderTrace(plan: OnChainPlan, results: OnChainToolResult[]) {
  const traces = [...(plan.providerTrace ?? [])];

  for (const result of results) {
    const attempted = result.attemptedProviders ?? [];
    const failedAttempts = attempted.slice(0, Math.max(0, attempted.length - 1));

    for (const provider of failedAttempts) {
      traces.push({
        message: result.fallbackReason ?? `${provider} fallback was triggered.`,
        provider,
        scope: "legacy-fallback",
        status: "failed",
      });
    }

    traces.push({
      message:
        result.status === "success"
          ? result.summary
          : formatProviderTraceMessage(result),
      provider: result.provider,
      scope: result.scope ?? "legacy-default",
      status: result.status === "success" ? "success" : "failed",
    });
  }

  return traces;
}

function formatProviderTraceMessage(result: OnChainToolResult) {
  if (result.domain === "smart_money" && isDirectProviderIssue(result)) {
    return "Row-level smart-money wallet-flow coverage was unavailable.";
  }

  return result.error ?? result.summary;
}
