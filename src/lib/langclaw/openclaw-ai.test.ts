import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFinalAnswerPrompt,
  describeFinalAnswerParseFailure,
  FINAL_ANSWER_OPENAI_TEXT_FORMAT,
  parseFinalAnswer,
  type OpenClawFinalAnswerInput,
} from "./openclaw-ai";

test("final answer text format asks the model for conclusion only", () => {
  assert.equal(FINAL_ANSWER_OPENAI_TEXT_FORMAT.type, "json_schema");
  if (FINAL_ANSWER_OPENAI_TEXT_FORMAT.type !== "json_schema") {
    throw new Error("Final answer text format must use json_schema.");
  }

  const schema = FINAL_ANSWER_OPENAI_TEXT_FORMAT.schema as {
    additionalProperties?: boolean;
    properties?: Record<string, unknown>;
    required?: string[];
  };

  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties ?? {}), ["conclusion"]);
  assert.deepEqual(schema.required, ["conclusion"]);
});

test("parseFinalAnswer maps conclusion JSON to the compatible FinalAnswer shape", () => {
  const conclusion = [
    "Mantle builder activity is active, but token-level confirmation is still required.",
    "",
    "- Social and docs signals are visible.",
    "- Add the strongest signal to the watchlist only after provider coverage is checked.",
  ].join("\n");
  const parsed = parseFinalAnswer(JSON.stringify({ conclusion }));

  assert.deepEqual(parsed, {
    answer: conclusion,
    answerMarkdown: conclusion,
    bullets: [],
    caveat: undefined,
    generatedBy: "Final Conclusion Agent",
    recommendation: undefined,
    title: undefined,
  });
});

test("parseFinalAnswer accepts freeform markdown answers without legacy sections", () => {
  const parsed = parseFinalAnswer(
    JSON.stringify({
      answerMarkdown: [
        "Mantle builder activity is active, but the strongest conviction still needs token-level confirmation.",
        "",
        "- Social and docs signals are visible.",
        "- On-chain enrichment should only run when the prompt names a token, wallet, or protocol.",
      ].join("\n"),
      generatedBy: "Final Conclusion Agent",
    })
  );

  assert.deepEqual(parsed, {
    answer:
      "Mantle builder activity is active, but the strongest conviction still needs token-level confirmation.\n\n- Social and docs signals are visible.\n- On-chain enrichment should only run when the prompt names a token, wallet, or protocol.",
    answerMarkdown:
      "Mantle builder activity is active, but the strongest conviction still needs token-level confirmation.\n\n- Social and docs signals are visible.\n- On-chain enrichment should only run when the prompt names a token, wallet, or protocol.",
    bullets: [],
    caveat: undefined,
    generatedBy: "Final Conclusion Agent",
    recommendation: undefined,
    title: undefined,
  });
});

test("parseFinalAnswer accepts nested finalAnswer objects and content aliases", () => {
  const parsed = parseFinalAnswer(
    JSON.stringify({
      finalAnswer: {
        content: "Nested finalAnswer content is accepted.",
      },
    })
  );

  assert.equal(parsed?.answerMarkdown, "Nested finalAnswer content is accepted.");
});

test("parseFinalAnswer accepts prose markdown when the model ignores JSON mode", () => {
  const parsed = parseFinalAnswer(
    [
      "Mantle builder activity is active, but token-level confirmation is still required.",
      "",
      "- Social and docs signals are visible.",
      "- On-chain enrichment should only run when the prompt names a token.",
    ].join("\n")
  );

  assert.match(
    parsed?.answerMarkdown ?? "",
    /Mantle builder activity is active/
  );
});

test("describeFinalAnswerParseFailure distinguishes empty and malformed outputs", () => {
  assert.equal(
    describeFinalAnswerParseFailure(""),
    "OpenAI returned empty synthesis output."
  );
  assert.equal(
    describeFinalAnswerParseFailure('{"answerMarkdown":'),
    "OpenAI returned malformed or truncated finalAnswer JSON."
  );
});

test("buildFinalAnswerPrompt includes detected response language", () => {
  const prompt = buildFinalAnswerPrompt({
    agentOutputs: {},
    errors: [],
    runtime: "typescript",
    signals: {
      combined: {
        providers: [],
        sourceIds: [],
        status: "partial",
        summary: "No strong signal yet.",
        toolIds: [],
      },
      onchain: {
        providers: [],
        sourceIds: [],
        status: "partial",
        summary: "On-chain coverage is partial.",
        toolIds: [],
      },
      social: {
        providers: [],
        sourceIds: [],
        status: "partial",
        summary: "Social coverage is partial.",
        toolIds: [],
      },
    },
    sources: [],
    steps: [],
    topic: "kenapa smart-money Mantle masih jelek ya?",
  });

  assert.match(prompt, /Detected response language: Indonesian \((high|medium)\)/);
  assert.match(prompt, /"responseLanguage"/);
  assert.match(prompt, /Write all user-visible prose in Indonesian/);
  assert.match(prompt, /Mirror the latest user message's language/);
});

test("compact final answer prompt is smaller than the full research payload prompt", () => {
  const defiReport = {
    asOfUtc: "2026-05-23T00:00:00.000Z",
    bottomLine:
      "Use the ranked shortlist as best-effort Mantle research, then confirm protocol risk manually.",
    caveats: ["Coverage gaps reduced confidence in this run."],
    confidence: "medium" as const,
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
        severity: "high" as const,
        sourceIds: [],
        summary: "Composite ranking used TVL, APY, and momentum.",
        toolIds: ["defi_tvl.defillama_protocols"],
      },
    ],
    executiveSummary:
      "This run returned a ranked shortlist from partial coverage for Mantle. Agni Finance leads the current view with $1.2M TVL and +12% best APY.",
    kind: "defi-yield" as const,
    recommendations: ["Confirm protocol risk before escalating the shortlist."],
    sections: [
      {
        id: "signal-summary",
        markdown: "Ranked shortlist from partial coverage.",
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
  const baseInput = {
    agentOutputs: {
      planner: {
        providerPlan: [],
        scoringFocus: ["liquidity"],
        summary: "Planner summary ".repeat(20),
      },
      trend: {
        rankedTrends: [],
        score: 8,
        summary: "Trend summary ".repeat(20),
        topTrend: "Mantle liquidity",
      },
      evidence: {
        bundleSummary: "Evidence bundle ".repeat(20),
        claimMap: [],
        evidenceUri: "langclaw://evidence/test",
        rootHash: "0xabc",
        storageStatus: "prepared" as const,
      },
      verifier: {
        briefHashInput: "brief-hash",
        chainStatus: "prepared" as const,
        storageStatus: "prepared" as const,
        unsupportedClaims: [],
        verificationSummary: "Verifier summary ".repeat(20),
      },
    },
    errors: [],
    onChain: {
      answer: "On-chain answer ".repeat(40),
      bullets: [],
      caveat: "Analysis-only.",
      generatedAt: "2026-05-23T00:00:00.000Z",
      plan: {
        analysisSource: "prompt" as const,
        chain: "mantle",
        chainId: 5000,
        chainName: "Mantle",
        commands: [],
        domainCount: 14,
        intent: "smart-money",
        nativeSymbol: "MNT",
        productChain: "sui-testnet" as const,
        productChainId: 1,
        productChainName: "Sui Testnet",
        query: "Analyze smart-money accumulation for MNT on Mantle",
        registryCommandCount: 83,
      },
      report: defiReport,
      recommendation: "Recommendation ".repeat(20),
      title: "Mantle on-chain brief",
      tools: Array.from({ length: 12 }, (_, index) => ({
        attemptedProviders: ["nansen" as const],
        commandId: `tool-${index}`,
        domain: "smart_money",
        latencyMs: 10,
        provider: "nansen" as const,
        scope: "legacy-fallback" as const,
        status: "failed" as const,
        summary: `Tool summary ${index} `.repeat(8),
        title: `Tool ${index}`,
      })),
    },
    runtime: "typescript" as const,
    report: defiReport,
    signals: {
      combined: {
        providers: ["Surf"],
        sourceIds: ["surf-1"],
        status: "success" as const,
        summary: "Combined summary",
        toolIds: [],
      },
      onchain: {
        providers: ["Nansen"],
        sourceIds: [],
        status: "partial" as const,
        summary: "On-chain summary",
        toolIds: ["tool-1"],
      },
      social: {
        providers: ["Surf"],
        sourceIds: ["surf-1"],
        status: "success" as const,
        summary: "Social summary",
        toolIds: [],
      },
    },
    sources: Array.from({ length: 16 }, (_, index) => ({
      excerpt: `Source excerpt ${index} `.repeat(30),
      id: `surf-${index}`,
      provider: "Surf" as const,
      title: `Surf source ${index}`,
      type: "docs_page" as const,
      url: `https://surf.test/${index}`,
    })),
    steps: Array.from({ length: 8 }, (_, index) => ({
      agent: `Agent ${index}`,
      execution: "typescript-tool" as const,
      skill: `skill-${index}`,
      status: "complete" as const,
      summary: `Step summary ${index} `.repeat(12),
    })),
    topic: "Analyze smart-money accumulation for MNT on Mantle",
  } satisfies OpenClawFinalAnswerInput;

  const fullPrompt = buildFinalAnswerPrompt(baseInput);
  const compactPrompt = buildFinalAnswerPrompt(baseInput, { compact: true });

  assert.ok(compactPrompt.length < fullPrompt.length * 0.75);
  assert.match(compactPrompt, /omittedSourceCount/);
  assert.match(compactPrompt, /Agni Finance/);
  assert.match(compactPrompt, /"score":\s*88\.4/);
  assert.match(compactPrompt, /"momentumScore":\s*16\.1/);
  assert.match(
    compactPrompt,
    /prefer a best-effort shortlist with explicit gaps instead of saying no ranking is available/i
  );
});

test("buildFinalAnswerPrompt includes structured caveat and proof guardrails", () => {
  const prompt = buildFinalAnswerPrompt({
    agentOutputs: {},
    errors: [
      {
        message: "402 Payment Required",
        provider: "Surf",
      },
    ],
    onChain: {
      answer: "Analysis-only on-chain result.",
      bullets: [],
      caveat: "Analysis-only.",
      generatedAt: "2026-05-23T00:00:00.000Z",
      plan: {
        analysisSource: "prompt" as const,
        chain: "mantle",
        chainId: 5000,
        chainName: "Mantle",
        commands: [],
        domainCount: 14,
        intent: "smart-money",
        nativeSymbol: "MNT",
        productChain: "sui-testnet" as const,
        productChainId: 1,
        productChainName: "Sui Testnet",
        query: "Analyze smart-money accumulation for MNT on Mantle",
        registryCommandCount: 83,
      },
      recommendation: "Fix provider inputs and rerun.",
      title: "Mantle on-chain brief",
      tools: [
        {
          attemptedProviders: ["nansen", "dune"],
          commandId: "smart_money.nansen_smart_money_netflow",
          domain: "smart_money",
          error: "422 Unknown field",
          fallbackReason: "nansen: 422 Unknown field | dune: 400 query id missing",
          latencyMs: 12,
          provider: "nansen",
          scope: "legacy-fallback",
          status: "failed",
          summary: "422 Unknown field",
          title: "Smart money netflow",
        },
      ],
    },
    runtime: "typescript",
    signals: {
      combined: {
        providers: ["Surf", "Nansen"],
        sourceIds: ["x-1"],
        status: "partial",
        summary: "Combined signal is partial.",
        toolIds: ["smart_money.nansen_smart_money_netflow"],
      },
      onchain: {
        providers: ["Nansen"],
        sourceIds: [],
        status: "partial",
        summary: "On-chain signal is partial.",
        toolIds: ["smart_money.nansen_smart_money_netflow"],
      },
      social: {
        providers: ["Surf"],
        sourceIds: ["x-1"],
        status: "partial",
        summary: "Social signal is partial.",
        toolIds: [],
      },
    },
    sources: [],
    steps: [],
    topic: "Analyze smart-money accumulation for MNT on Mantle",
  });

  assert.match(prompt, /backend handles caveat metadata separately/i);
  assert.doesNotMatch(prompt, /Surf-style research note/i);
  assert.match(prompt, /Read, Evidence, Candidates, Limits, and Conclusion/i);
  assert.match(prompt, /Never describe the answer format using competitor branding/i);
  assert.match(prompt, /Do not expose internal snake_case labels/i);
  assert.match(prompt, /compact top-5 shortlist/i);
  assert.match(prompt, /Markdown table under Candidates/i);
  assert.match(prompt, /Read, Limits, and Conclusion must be short paragraphs/i);
  assert.match(prompt, /Limits must be specific to the analysis/i);
  assert.match(prompt, /Do not use the phrase 'this run'/i);
  assert.match(prompt, /smart-money signal is weak/i);
  assert.match(prompt, /standard checks were unavailable/i);
  assert.match(prompt, /Belum ada bukti akumulasi terverifikasi/i);
  assert.match(prompt, /Do not turn empty smart-money rows into wallet rankings/i);
  assert.match(prompt, /Do not end smart-money answers by telling the user to rerun the same task/i);
  assert.match(prompt, /Do not claim.*evidenceUri.*Sui anchoring.*transaction/i);
  assert.match(prompt, /"conclusion":/);
  assert.doesNotMatch(prompt, /"answerMarkdown":/);
  assert.match(prompt, /"report"/i);
  assert.doesNotMatch(prompt, /primary structured contract/i);
  assert.doesNotMatch(prompt, /402 Payment Required/i);
  assert.match(prompt, /Source unavailable/i);
  assert.match(prompt, /Row-level wallet-flow coverage was unavailable/i);
  assert.doesNotMatch(prompt, /422 Unknown field/i);
});
