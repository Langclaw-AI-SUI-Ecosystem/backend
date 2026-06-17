import assert from "node:assert/strict";
import test from "node:test";

import { synthesizeFinalAnswerWithOpenAI } from "./openai-synthesis";
import {
  buildFinalAnswer,
  buildConclusionSignal,
  buildSocialSignals,
  buildWorkflowProgressEvent,
  summarizeFailures,
  synthesizeWorkflowFinalAnswer,
  withFallbackCaveat,
} from "./workflow";
import type {
  DiscoverSignals,
  FinalAnswerMeta,
  ResearchReport,
  SourceCard,
} from "./types";
import type { OnChainToolFinalPayload } from "../onchain-tools/types";
import { jsonResponse, mockFetch, withEnv } from "../../test/helpers";

test("progress events include standardized timing fields", () => {
  const event = buildWorkflowProgressEvent(
    {
      agent: "Planner Agent",
      pendingSummary: "Waiting",
      skill: "openclaw/skills/planner.md",
      stepId: "planner",
    },
    "complete",
    "Planner completed.",
    {
      execution: "typescript-tool",
      model: "planner-model",
    }
  );

  assert.equal(event.stepId, "planner");
  assert.equal(event.agent, "Planner Agent");
  assert.equal(event.skill, "openclaw/skills/planner.md");
  assert.equal(event.status, "complete");
  assert.equal(event.summary, "Planner completed.");
  assert.equal(event.execution, "typescript-tool");
  assert.equal(event.model, "planner-model");
  assert.match(event.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(event.startedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
  assert.match(event.completedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(typeof event.durationMs, "number");
});

test("final conclusion signals keep sourceId and add sourceIds", () => {
  const source: SourceCard = {
    excerpt: "Evidence",
    id: "source-1",
    provider: "GitHub",
    title: "Repo evidence",
    type: "github_repo",
    url: "https://example.test/repo",
  };

  assert.deepEqual(
    buildConclusionSignal("Builder signal", source, "fallback"),
    {
      label: "Builder signal",
      sourceId: "source-1",
      sourceIds: ["source-1"],
      text: "Repo evidence",
    }
  );
});

test("final answer OpenAI proof includes requested and used model metadata", async () => {
  await withEnv(
    {
      OPENAI_API_KEY: "",
      OPENAI_AGENT_MODEL: "default-agent",
    },
    async () => {
      const result = await synthesizeFinalAnswerWithOpenAI({
        agentOutputs: {},
        errors: [],
        signals: {
          combined: {
            providers: [],
            sourceIds: [],
            status: "failed",
            summary: "No combined signal was available.",
            toolIds: [],
          },
          onchain: {
            providers: [],
            sourceIds: [],
            status: "failed",
            summary: "No on-chain signal was available.",
            toolIds: [],
          },
          social: {
            providers: [],
            sourceIds: [],
            status: "failed",
            summary: "No social signal was available.",
            toolIds: [],
          },
        },
        requestedModel: "agent-model",
        runtime: "typescript",
        sources: [],
        steps: [],
        topic: "Mantle agent research",
      });

      assert.equal(result.meta.requestedModel, "agent-model");
      assert.equal(result.meta.usedModel, "agent-model");
      assert.equal(result.meta.modelHonored, true);
      assert.equal(result.compute.requestedModel, "agent-model");
      assert.equal(result.compute.usedModel, "agent-model");
      assert.equal(result.compute.modelHonored, true);
      assert.equal(result.compute.status, "skipped");
      assert.equal(result.compute.provider, "OpenAI");
    }
  );
});

test("final answer OpenAI synthesis records request and usage metadata", async () => {
  let responseBody: Record<string, unknown> | undefined;
  const restore = mockFetch((url, init) => {
    const path = new URL(url).pathname;

    assert.equal(path, "/v1/responses");
    responseBody = JSON.parse(String(init?.body)) as Record<string, unknown>;

    return jsonResponse(
      {
        id: "resp-agent",
        model: "agent-openai-model",
        output_text: JSON.stringify({
          conclusion: [
            "OpenAI proof is enabled.",
            "",
            "- Responses API usage was recorded.",
            "",
            "Next step: Keep OpenAI configured.",
          ].join("\n"),
        }),
        usage: {
          input_tokens: 7,
          output_tokens: 5,
          total_tokens: 12,
        },
      }
    );
  });

  try {
    await withEnv(
      {
        OPENAI_API_KEY: "openai-key",
        OPENAI_BASE_URL: "https://api.openai.test/v1",
      },
      async () => {
        const result = await synthesizeFinalAnswerWithOpenAI({
          agentOutputs: {},
          errors: [],
          signals: {
            combined: {
              providers: ["Elfa", "Surf", "Nansen"],
              sourceIds: ["surf-1", "elfa-1"],
              status: "success",
              summary: "Combined signal summary for the model prompt.",
              toolIds: ["smart_money.nansen_smart_money_netflow"],
            },
            onchain: {
              providers: ["Nansen"],
              sourceIds: [],
              status: "success",
              summary: "On-chain signal summary for the model prompt.",
              toolIds: ["smart_money.nansen_smart_money_netflow"],
            },
            social: {
              providers: ["Elfa", "Surf"],
              sourceIds: ["surf-1", "elfa-1"],
              status: "success",
              summary: "Social signal summary for the model prompt.",
              toolIds: [],
            },
          },
          requestedModel: "agent-openai-model",
          runtime: "typescript",
          sources: [],
          steps: [],
          topic: "Mantle verified research",
        });

        assert.equal(responseBody?.model, "agent-openai-model");
        assert.match(
          String(responseBody?.input ?? ""),
          /Combined signal summary for the model prompt\./
        );
        assert.equal(result.compute.status, "used");
        assert.equal(result.compute.requestId, "resp-agent");
        assert.equal(result.compute.provider, "OpenAI");
        assert.equal(result.compute.usage?.promptTokens, 7);
        assert.equal(result.compute.usage?.completionTokens, 5);
      }
    );
  } finally {
    restore();
  }
});

test("final answer OpenAI synthesis retries with compact prompt when the first response is incomplete", async () => {
  let callCount = 0;
  const restore = mockFetch((url, init) => {
    const path = new URL(url).pathname;

    assert.equal(path, "/v1/responses");
    callCount += 1;
    const body = JSON.parse(String(init?.body)) as {
      input?: string;
      max_output_tokens?: number;
    };

    // The retry ladder makes two base-budget attempts (schema, then json_object)
    // at OPENAI_AGENT_MAX_OUTPUT_TOKENS before escalating to the compact +
    // boosted-token attempt, so the first two calls stay at 4096 and incomplete.
    if (callCount <= 2) {
      assert.equal(body.max_output_tokens, 4096);

      return jsonResponse({
        id: "resp-incomplete",
        model: "agent-openai-model",
        output_text: '{"conclusion":"Partial answer without closing brace"',
        status: "incomplete",
      });
    }

    assert.ok(body.max_output_tokens && body.max_output_tokens >= 6144);
    assert.match(String(body.input ?? ""), /omittedSourceCount/);

    return jsonResponse({
      id: "resp-complete",
      model: "agent-openai-model",
      output_text: JSON.stringify({
        conclusion: "Compact retry produced the final answer.",
      }),
      status: "completed",
    });
  });

  try {
    await withEnv(
      {
        OPENAI_AGENT_MAX_OUTPUT_TOKENS: "4096",
        OPENAI_API_KEY: "openai-key",
        OPENAI_BASE_URL: "https://api.openai.test/v1",
      },
      async () => {
        const result = await synthesizeFinalAnswerWithOpenAI({
          agentOutputs: {},
          errors: [],
          signals: {
            combined: {
              providers: ["Surf"],
              sourceIds: ["surf-1"],
              status: "success",
              summary: "Combined signal summary",
              toolIds: [],
            },
            onchain: {
              providers: [],
              sourceIds: [],
              status: "skipped",
              summary: "No on-chain signal",
              toolIds: [],
            },
            social: {
              providers: ["Surf"],
              sourceIds: ["surf-1"],
              status: "success",
              summary: "Social signal summary",
              toolIds: [],
            },
          },
          runtime: "typescript",
          sources: Array.from({ length: 12 }, (_, index) => ({
            excerpt: `Source excerpt ${index} `.repeat(20),
            id: `surf-${index}`,
            provider: "Surf",
            title: `Surf source ${index}`,
            type: "docs_page",
            url: `https://surf.test/${index}`,
          })),
          steps: [],
          topic: "Mantle verified research",
        });

        assert.ok(callCount >= 3);
        assert.equal(result.meta.synthesis, "openai");
        assert.match(
          result.finalAnswer?.answerMarkdown ?? "",
          /Compact retry produced the final answer/
        );
      }
    );
  } finally {
    restore();
  }
});

test("workflow final answer synthesis prefers OpenClaw when the research workflow uses OpenClaw", async () => {
  let openAiCalls = 0;

  const result = await synthesizeWorkflowFinalAnswer(
    {
      topic: "Detect liquidity anomalies on Mantle DEX pairs",
      sources: [],
      errors: [],
      runtime: "openclaw",
      steps: [],
      signals: {
        combined: {
          providers: ["GeckoTerminal"],
          sourceIds: [],
          status: "success",
          summary: "Combined signals were available.",
          toolIds: ["geckoterminal.pools.megafilter"],
        },
        onchain: {
          providers: ["GeckoTerminal"],
          sourceIds: [],
          status: "success",
          summary: "On-chain signals were available.",
          toolIds: ["geckoterminal.pools.megafilter"],
        },
        social: {
          providers: [],
          sourceIds: [],
          status: "skipped",
          summary: "No social signal was required.",
          toolIds: [],
        },
      },
      preferOpenClaw: true,
      sessionId: "langclaw-test-final-conclusion",
    },
    {
      openClaw: async () => ({
        finalAnswer: {
          answer: "OpenClaw synthesized the final answer.",
          answerMarkdown: "OpenClaw synthesized the final answer.",
          bullets: [],
          generatedBy: "Final Conclusion Agent",
        },
        meta: {
          synthesis: "openclaw-ai",
          execution: "openclaw-agent",
          model: "openclaw/test-model",
          sessionId: "langclaw-test-final-conclusion",
        },
      }),
      openAI: async () => {
        openAiCalls += 1;

        return {
          finalAnswer: {
            answer: "OpenAI should not run here.",
            bullets: [],
            generatedBy: "Final Conclusion Agent",
          },
          meta: {
            synthesis: "openai",
          },
          compute: {
            status: "used",
            provider: "OpenAI",
          },
        };
      },
    }
  );

  assert.equal(openAiCalls, 0);
  assert.equal(result.meta.synthesis, "openclaw-ai");
  assert.equal(result.compute.status, "used");
  assert.equal(result.compute.provider, "OpenClaw");
  assert.equal(result.finalAnswer?.answer, "OpenClaw synthesized the final answer.");
});

test("workflow final answer synthesis falls back to OpenAI when OpenClaw synthesis fails", async () => {
  let openAiCalls = 0;

  const result = await synthesizeWorkflowFinalAnswer(
    {
      topic: "Detect liquidity anomalies on Base DEX pairs",
      sources: [],
      errors: [],
      runtime: "openclaw",
      steps: [],
      signals: {
        combined: {
          providers: ["CoinGecko", "GeckoTerminal"],
          sourceIds: [],
          status: "partial",
          summary: "Combined signals were partial.",
          toolIds: ["coingecko.search", "geckoterminal.pools.megafilter"],
        },
        onchain: {
          providers: ["GeckoTerminal"],
          sourceIds: [],
          status: "partial",
          summary: "On-chain signals were partial.",
          toolIds: ["geckoterminal.pools.megafilter"],
        },
        social: {
          providers: [],
          sourceIds: [],
          status: "skipped",
          summary: "No social signal was required.",
          toolIds: [],
        },
      },
      preferOpenClaw: true,
      sessionId: "langclaw-test-final-conclusion",
    },
    {
      openClaw: async () => ({
        meta: {
          synthesis: "deterministic-fallback",
          execution: "deterministic-fallback",
          error: "OpenClaw model did not return a valid finalAnswer JSON object.",
          sessionId: "langclaw-test-final-conclusion",
        },
      }),
      openAI: async () => {
        openAiCalls += 1;

        return {
          finalAnswer: {
            answer: "OpenAI fallback synthesized the final answer.",
            answerMarkdown: "OpenAI fallback synthesized the final answer.",
            bullets: [],
            generatedBy: "Final Conclusion Agent",
          },
          meta: {
            synthesis: "openai",
            execution: "openai",
            model: "gpt-test",
          },
          compute: {
            status: "used",
            provider: "OpenAI",
            model: "gpt-test",
          },
        };
      },
    }
  );

  assert.equal(openAiCalls, 1);
  assert.equal(result.meta.synthesis, "openai");
  assert.equal(result.compute.provider, "OpenAI");
  assert.equal(
    result.finalAnswer?.answer,
    "OpenAI fallback synthesized the final answer."
  );
});

test("deterministic fallback appends the synthesis caveat only once", () => {
  const sources: SourceCard[] = [
    {
      excerpt: "Mantle AI agent hackathon activity.",
      id: "x-1",
      provider: "X",
      title: "Mantle AI agent update",
      type: "x_post",
      url: "https://example.test/x-1",
    },
  ];
  const onChain: OnChainToolFinalPayload = {
    answer: "On-chain enrichment ran but did not confirm smart-money accumulation.",
    bullets: [],
    caveat: "This is analysis-only.",
    generatedAt: "2026-05-23T00:00:00.000Z",
    plan: {
      analysisSource: "prompt",
      chain: "mantle",
      chainId: 5000,
      chainName: "Mantle",
      commands: [],
      domainCount: 14,
      intent: "trading-signal",
      nativeSymbol: "MNT",
      productChain: "sui-testnet",
      productChainId: 1,
      productChainName: "Sui Testnet",
      query: "Analyze smart-money accumulation for MNT on Mantle",
      registryCommandCount: 83,
    },
    recommendation: "Use the successful provider data, then rerun after fixing the failed provider configuration for fuller coverage.",
    title: "Mantle alpha signal analysis",
    tools: [
      {
        attemptedProviders: ["nansen", "dune"],
        commandId: "smart_money.nansen_smart_money_netflow",
        domain: "smart_money",
        error: "API field error",
        fallbackReason: "nansen: API field error | dune: missing query id",
        latencyMs: 12,
        provider: "nansen",
        scope: "legacy-fallback",
        status: "failed",
        summary: "API field error",
        title: "Smart money netflow",
      },
      {
        attemptedProviders: ["local"],
        commandId: "smart_money.smart_money_signal_synthesis",
        domain: "smart_money",
        latencyMs: 1,
        provider: "local",
        scope: "legacy-default",
        status: "success",
        summary: "Synthesized 0 successful tool results and 1 failed tool results into an analysis-only signal.",
        title: "Smart money signal synthesis",
      },
    ],
  };
  const meta: FinalAnswerMeta = {
    error: "OpenAI did not return a valid finalAnswer JSON object.",
    execution: "deterministic-fallback",
    model: "gpt-test",
    requestedModel: "gpt-test",
    synthesis: "deterministic-fallback",
    transport: "openai-responses",
    usedModel: "gpt-test",
  };
  const signals: DiscoverSignals = {
    combined: {
      providers: ["Elfa", "Nansen"],
      sourceIds: ["x-1"],
      status: "partial",
      summary: "Combined summary should appear in the deterministic fallback.",
      toolIds: ["smart_money.nansen_smart_money_netflow"],
    },
    onchain: {
      providers: ["Dune"],
      sourceIds: [],
      status: "partial",
      summary: "On-chain summary should appear in the deterministic fallback.",
      toolIds: ["smart_money.nansen_smart_money_netflow"],
    },
    social: {
      providers: ["X"],
      sourceIds: ["x-1"],
      status: "success",
      summary: "Social summary should appear in the deterministic fallback.",
      toolIds: [],
    },
  };
  const errors = [
    {
      message: "402 Payment Required",
      provider: "Surf" as const,
    },
    {
      message: "runtime timeout",
      provider: "Elfa" as const,
    },
  ];

  const answer = buildFinalAnswer(
    "Analyze smart-money accumulation for MNT on Mantle",
    sources,
    errors,
    "typescript",
    signals,
    onChain
  );
  const withCaveat = withFallbackCaveat(answer, meta);
  const caveatMatches = withCaveat.answerMarkdown?.match(/Caveat:/g) ?? [];

  assert.match(answer.answerMarkdown ?? "", /^Short conclusion$/m);
  assert.match(
    answer.answerMarkdown ?? "",
    /Combined summary should appear in the deterministic fallback\./
  );
  assert.match(
    answer.answerMarkdown ?? "",
    /Social summary should appear in the deterministic fallback\./
  );
  assert.match(
    answer.answerMarkdown ?? "",
    /On-chain summary should appear in the deterministic fallback\./
  );
  assert.match(
    answer.answerMarkdown ?? "",
    /Smart-money signal is still weak on Mantle/i
  );
  assert.doesNotMatch(
    answer.answerMarkdown ?? "",
    /did not confirm verified smart-money accumulation/i
  );
  assert.match(answer.caveat ?? "", /Surf failed/i);
  assert.match(answer.caveat ?? "", /Elfa failed/i);
  assert.match(answer.caveat ?? "", /Nansen row-level wallet-flow coverage was unavailable/i);
  assert.match(answer.caveat ?? "", /analysis-only/i);
  assert.match(answer.caveat ?? "", /directional research/i);
  assert.equal(caveatMatches.length, 1);
  assert.match(
    withCaveat.answerMarkdown ?? "",
    /AI synthesis failed, deterministic fallback used/
  );
});

test("report-backed fallback stays user-facing instead of rendering the full report markdown", () => {
  const report: ResearchReport = {
    asOfUtc: "2026-05-23T00:00:00.000Z",
    bottomLine: "Treat this as directional research only.",
    caveats: ["Coverage gaps reduced confidence in this run."],
    confidence: "medium",
    entities: [],
    executiveSummary:
      "Mantle liquidity signals are usable, but pair-level confirmation is still incomplete.",
    kind: "liquidity-anomaly",
    recommendations: [
      "Confirm the top pool with direct holder and LP-change checks before escalating.",
    ],
    sections: [
      {
        id: "combined-view",
        markdown: "Combined signal summary.",
        sourceIds: [],
        title: "Combined View",
        toolIds: [],
      },
    ],
    tables: [],
    title: "Mantle liquidity anomaly report",
  };

  const answer = buildFinalAnswer(
    "Detect liquidity anomalies on Mantle DEX pairs",
    [],
    [],
    "typescript",
    {
      combined: {
        providers: ["DEX Screener"],
        sourceIds: [],
        status: "partial",
        summary: "Combined signal is partial.",
        toolIds: [],
      },
      onchain: {
        providers: ["DEX Screener"],
        sourceIds: [],
        status: "partial",
        summary: "On-chain signal is partial.",
        toolIds: [],
      },
      social: {
        providers: [],
        sourceIds: [],
        status: "skipped",
        summary: "No social signal was available.",
        toolIds: [],
      },
    },
    undefined,
    undefined,
    undefined,
    report
  );

  assert.equal(answer.answer, report.executiveSummary);
  assert.doesNotMatch(answer.answerMarkdown ?? "", /^#/m);
  assert.doesNotMatch(answer.answerMarkdown ?? "", /## Bottom Line/i);
  assert.match(
    answer.answerMarkdown ?? "",
    /Mantle liquidity signals are usable, but pair-level confirmation is still incomplete\./
  );
  assert.match(
    answer.answerMarkdown ?? "",
    /Confirm the top pool with direct holder and LP-change checks before escalating\./
  );
  assert.equal((answer.answerMarkdown?.match(/Caveat:/g) ?? []).length, 1);
});

test("report-backed fallback does not reject liquidity anomaly rankings when pair entities are present", () => {
  const report: ResearchReport = {
    asOfUtc: "2026-05-23T00:00:00.000Z",
    bottomLine:
      "Use the ranked pair shortlist as best-effort research, then confirm holder flow and LP changes manually.",
    caveats: ["GeckoTerminal failed, so coverage stayed partial."],
    confidence: "medium",
    entities: [
      {
        category: "dex-pair",
        id: "0x2d70cBAbf4d8e61d5317b62cBe912935FD94e0FE",
        label: "CELO / USDm",
        metrics: {
          pairAddress: "0x2d70cBAbf4d8e61d5317b62cBe912935FD94e0FE",
          priceChange24h: -5.76,
          reserveUsd: 8251.71,
          turnover24h: 6.27,
          txns24h: 2081,
          volume24hUsd: 51706.63,
        },
        rank: 1,
        severity: "high",
        sourceIds: [],
        summary: "Reserves are $8.3K, 24h volume is $51.7K, turnover is 6.27x.",
        toolIds: ["pair_liquidity.liquidity_pair_search"],
      },
    ],
    executiveSummary:
      "This run returned a ranked pair shortlist from partial coverage for Celo. CELO / USDm leads the current anomaly view.",
    kind: "liquidity-anomaly",
    recommendations: ["Confirm the top pair with holder and LP-change checks before escalating."],
    sections: [
      {
        id: "signal-summary",
        markdown:
          "Ranked pair shortlist from partial coverage. CELO / USDm is the primary anomaly.",
        sourceIds: [],
        title: "Signal Summary",
        toolIds: ["pair_liquidity.liquidity_pair_search"],
      },
    ],
    tables: [
      {
        columns: [
          "pair",
          "pool",
          "reserveUsd",
          "volume24hUsd",
          "turnover24h",
          "priceChange24h",
          "txns24h",
          "severity",
        ],
        id: "anomaly-table",
        rows: [
          {
            pair: "CELO / USDm",
            pool: "0x2d70cBAbf4d8e61d5317b62cBe912935FD94e0FE",
            priceChange24h: -5.76,
            reserveUsd: 8251.71,
            severity: "high",
            turnover24h: 6.27,
            txns24h: 2081,
            volume24hUsd: 51706.63,
          },
        ],
        title: "Anomaly Table",
      },
    ],
    title: "Celo liquidity anomaly report",
  };
  const onChain: OnChainToolFinalPayload = {
    answer:
      "No direct pair-level table was available, so treat the anomaly brief as narrative-only.",
    bullets: [],
    caveat: "This is analysis-only.",
    generatedAt: "2026-05-23T00:00:00.000Z",
    plan: {
      analysisSource: "prompt",
      chain: "celo",
      chainId: 42220,
      chainName: "Celo",
      commands: [],
      domainCount: 14,
      intent: "trading-signal",
      nativeSymbol: "CELO",
      productChain: "sui-testnet",
      productChainId: 1,
      productChainName: "Sui Testnet",
      query: "Celo",
      registryCommandCount: 83,
    },
    recommendation: "Confirm the top pair with holder and LP-change checks before escalating.",
    report,
    title: "Celo liquidity anomaly report",
    tools: [
      {
        commandId: "pair_liquidity.liquidity_pair_search",
        domain: "pair_liquidity",
        latencyMs: 12,
        provider: "dexscreener",
        scope: "legacy-default",
        status: "success",
        summary: "Searched DEX pairs for Celo.",
        title: "Liquidity pair search",
      },
    ],
  };

  const answer = buildFinalAnswer(
    "Detect liquidity anomalies on Celo DEX pairs",
    [],
    [],
    "typescript",
    {
      combined: {
        providers: ["DEX Screener"],
        sourceIds: [],
        status: "partial",
        summary: "Combined signal is partial.",
        toolIds: ["pair_liquidity.liquidity_pair_search"],
      },
      onchain: {
        providers: ["DEX Screener"],
        sourceIds: [],
        status: "success",
        summary: "On-chain signal is usable.",
        toolIds: ["pair_liquidity.liquidity_pair_search"],
      },
      social: {
        providers: [],
        sourceIds: [],
        status: "failed",
        summary: "Social signal is incomplete.",
        toolIds: [],
      },
    },
    onChain,
    undefined,
    undefined,
    report
  );

  assert.match(answer.answerMarkdown ?? "", /CELO \/ USDm/);
  assert.doesNotMatch(answer.answerMarkdown ?? "", /No direct pair-level table was available/i);
  assert.doesNotMatch(answer.answerMarkdown ?? "", /cannot rank/i);
  assert.match(
    answer.answerMarkdown ?? "",
    /ranked pair shortlist from partial coverage/i
  );
});

test("report-backed fallback does not repeat stale no-ranking text when DeFi entities are present", () => {
  const report: ResearchReport = {
    asOfUtc: "2026-05-23T00:00:00.000Z",
    bottomLine:
      "Use the ranked shortlist as best-effort Mantle research, then confirm protocol risk manually.",
    caveats: ["Coverage gaps reduced confidence in this run."],
    confidence: "medium",
    entities: [
      {
        category: "defi-protocol",
        id: "agni-finance",
        label: "Agni Finance",
        metrics: {
          bestApy: 12,
          coverage: "composite",
          momentumScore: 16.1,
          poolCount: 2,
          score: 88.4,
          tvlUsd: 1200000,
        },
        rank: 1,
        severity: "high",
        sourceIds: [],
        summary: "Composite ranking used TVL, APY, and momentum.",
        toolIds: ["defi_tvl.defillama_protocols"],
      },
    ],
    executiveSummary:
      "This run returned a ranked shortlist from partial coverage for Mantle. Agni Finance leads the current view with $1.2M TVL and +12% best APY.",
    kind: "defi-yield",
    recommendations: ["Confirm protocol risk before escalating the shortlist."],
    sections: [
      {
        id: "signal-summary",
        markdown:
          "Ranked shortlist from partial coverage. 1 protocol used composite scoring.",
        sourceIds: [],
        title: "Signal Summary",
        toolIds: ["defi_tvl.defillama_protocols"],
      },
    ],
    tables: [
      {
        columns: [
          "rank",
          "protocol",
          "score",
          "tvlUsd",
          "bestApy",
          "momentumScore",
          "poolCount",
          "coverage",
        ],
        id: "yield-table",
        rows: [
          {
            bestApy: 12,
            coverage: "composite",
            momentumScore: 16.1,
            poolCount: 2,
            protocol: "Agni Finance",
            rank: 1,
            score: 88.4,
            tvlUsd: 1200000,
          },
        ],
        title: "Yield Ranking",
      },
    ],
    title: "Mantle Yield and TVL Brief",
  };
  const onChain: OnChainToolFinalPayload = {
    answer:
      "This run returned narrative DeFi context for Mantle, but not enough row-level data for a ranked yield table.",
    bullets: [],
    caveat: "This is analysis-only.",
    generatedAt: "2026-05-23T00:00:00.000Z",
    plan: {
      analysisSource: "prompt",
      chain: "mantle",
      chainId: 5000,
      chainName: "Mantle",
      commands: [],
      domainCount: 14,
      intent: "defi",
      nativeSymbol: "MNT",
      productChain: "sui-testnet",
      productChainId: 1,
      productChainName: "Sui Testnet",
      query: "Rank Mantle protocols by TVL and yield momentum",
      registryCommandCount: 83,
    },
    recommendation: "Confirm protocol risk before escalating the shortlist.",
    report,
    title: "Mantle Yield and TVL Brief",
    tools: [
      {
        commandId: "defi_tvl.defillama_protocols",
        domain: "defi_tvl",
        latencyMs: 12,
        provider: "defillama",
        scope: "legacy-default",
        status: "success",
        summary: "Fetched DeFiLlama protocol TVL list.",
        title: "DeFi protocols TVL",
      },
    ],
  };

  const answer = buildFinalAnswer(
    "Rank Mantle protocols by TVL and yield momentum",
    [],
    [],
    "typescript",
    {
      combined: {
        providers: ["Surf", "DeFiLlama"],
        sourceIds: [],
        status: "partial",
        summary: "Combined signal is partial.",
        toolIds: ["defi_tvl.defillama_protocols"],
      },
      onchain: {
        providers: ["DeFiLlama"],
        sourceIds: [],
        status: "success",
        summary: "On-chain signal is usable.",
        toolIds: ["defi_tvl.defillama_protocols"],
      },
      social: {
        providers: ["Surf"],
        sourceIds: [],
        status: "partial",
        summary: "Social signal is partial.",
        toolIds: [],
      },
    },
    onChain,
    undefined,
    undefined,
    report
  );

  assert.match(answer.answerMarkdown ?? "", /Agni Finance/);
  assert.doesNotMatch(answer.answerMarkdown ?? "", /not enough row-level data/i);
  assert.match(
    answer.answerMarkdown ?? "",
    /ranked shortlist from partial coverage/i
  );
});

test("report-backed fallback does not reject token rankings when discovery entities are present", () => {
  const report: ResearchReport = {
    asOfUtc: "2026-05-23T00:00:00.000Z",
    bottomLine:
      "Use the ranked on-chain token shortlist as best-effort research, then confirm liquidity, holders, and token risk manually.",
    caveats: ["GeckoTerminal failed, so coverage stayed partial."],
    confidence: "medium",
    entities: [
      {
        category: "token",
        id: "solana-So11111111111111111111111111111111111111112",
        label: "SOLX",
        metrics: {
          boostAmount: 800,
          coverage: "boost+pool",
          liquidityUsd: 150000,
          poolCount: 1,
          priceChange24h: 21.5,
          score: 92.4,
          tokenAddress: "So11111111111111111111111111111111111111112",
          volume24hUsd: 450000,
        },
        rank: 1,
        severity: "high",
        sourceIds: [],
        summary: "Ranked from observed boost and pool evidence.",
        toolIds: ["token_discovery.trending_boosted_tokens"],
      },
    ],
    executiveSummary:
      "This run returned a ranked on-chain shortlist from partial coverage for Solana. SOLX leads the current view.",
    kind: "token-discovery",
    recommendations: ["Confirm liquidity and token risk before escalating the shortlist."],
    sections: [
      {
        id: "signal-summary",
        markdown:
          "Ranked on-chain shortlist from partial coverage. 1 token used boost+pool coverage.",
        sourceIds: [],
        title: "Signal Summary",
        toolIds: ["token_discovery.trending_boosted_tokens"],
      },
    ],
    tables: [
      {
        columns: [
          "rank",
          "token",
          "score",
          "tokenAddress",
          "boostAmount",
          "liquidityUsd",
          "volume24hUsd",
          "priceChange24h",
          "poolCount",
          "coverage",
        ],
        id: "token-discovery-table",
        rows: [
          {
            boostAmount: 800,
            coverage: "boost+pool",
            liquidityUsd: 150000,
            poolCount: 1,
            priceChange24h: 21.5,
            rank: 1,
            score: 92.4,
            token: "SOLX",
            tokenAddress: "So11111111111111111111111111111111111111112",
            volume24hUsd: 450000,
          },
        ],
        title: "Token Discovery Ranking",
      },
    ],
    title: "Solana token discovery report",
  };
  const onChain: OnChainToolFinalPayload = {
    answer:
      "This run returned token discovery context, but not enough exposed details for ranking.",
    bullets: [],
    caveat: "This is analysis-only.",
    generatedAt: "2026-05-23T00:00:00.000Z",
    plan: {
      analysisSource: "prompt",
      chain: "solana",
      chainId: 1,
      chainName: "Solana",
      commands: [],
      domainCount: 14,
      intent: "token-discovery",
      nativeSymbol: "SOL",
      productChain: "sui-testnet",
      productChainId: 1,
      productChainName: "Sui Testnet",
      query: "token Solana yang sedang tren",
      registryCommandCount: 83,
    },
    recommendation: "Confirm liquidity and token risk before escalating the shortlist.",
    report,
    title: "Solana token discovery report",
    tools: [
      {
        commandId: "token_discovery.trending_boosted_tokens",
        domain: "token_discovery",
        latencyMs: 12,
        provider: "dexscreener",
        scope: "legacy-default",
        status: "success",
        summary: "Fetched boosted tokens.",
        title: "Trending boosted tokens",
      },
    ],
  };

  const answer = buildFinalAnswer(
    "token Solana yang sedang tren",
    [],
    [],
    "typescript",
    {
      combined: {
        providers: ["DEX Screener"],
        sourceIds: [],
        status: "partial",
        summary: "Combined signal is partial.",
        toolIds: ["token_discovery.trending_boosted_tokens"],
      },
      onchain: {
        providers: ["DEX Screener"],
        sourceIds: [],
        status: "success",
        summary: "On-chain signal is usable.",
        toolIds: ["token_discovery.trending_boosted_tokens"],
      },
      social: {
        providers: [],
        sourceIds: [],
        status: "failed",
        summary: "Social signal is incomplete.",
        toolIds: [],
      },
    },
    onChain,
    undefined,
    undefined,
    report
  );

  assert.match(answer.answerMarkdown ?? "", /SOLX/);
  assert.doesNotMatch(answer.answerMarkdown ?? "", /not enough exposed details/i);
  assert.doesNotMatch(answer.answerMarkdown ?? "", /cannot rank/i);
  assert.match(
    answer.answerMarkdown ?? "",
    /ranked on-chain shortlist from partial coverage/i
  );
});

test("summarizeFailures includes compact provider error detail", () => {
  const summary = summarizeFailures([
    {
      message: "402 Payment Required from Elfa billing",
      provider: "Elfa",
    },
  ]);

  assert.match(summary, /Provider issues: Elfa \(source unavailable\)\./);
});

test("buildSocialSignals returns partial when a social provider fails but others succeed", () => {
  const signals = buildSocialSignals({
    chain: "mantle",
    errors: [
      {
        message: "Elfa returned no trending narratives.",
        provider: "Elfa",
      },
    ],
    sources: [
      {
        excerpt: "Surf market signal",
        id: "surf-1",
        provider: "Surf",
        title: "Mantle market signal",
        type: "docs_page",
        url: "https://surf.test/mantle",
      },
    ],
  });

  assert.equal(signals.status, "partial");
  assert.match(signals.summary, /some social momentum providers failed/i);
  assert.match(signals.caveat ?? "", /Elfa failed/i);
});

test("buildSocialSignals stays success when direct social providers all succeed", () => {
  const signals = buildSocialSignals({
    chain: "mantle",
    errors: [],
    sources: [
      {
        excerpt: "Surf market signal",
        id: "surf-1",
        provider: "Surf",
        title: "Mantle market signal",
        type: "docs_page",
        url: "https://surf.test/mantle",
      },
      {
        excerpt: "Elfa narrative",
        id: "elfa-1",
        provider: "Elfa",
        title: "Elfa narrative: AI agents",
        type: "docs_page",
        url: "https://x.com/example/status/1",
      },
    ],
  });

  assert.equal(signals.status, "success");
});
