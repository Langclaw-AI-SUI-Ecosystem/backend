import assert from "node:assert/strict";
import test from "node:test";

import { buildAlphaSignal } from "./alpha-quality";
import type {
  DiscoverSignals,
  ResearchReport,
  WorkflowChainContext,
  ZeroGProof,
} from "./types";
import type { OnChainToolFinalPayload } from "../onchain-tools/types";

const chainContext: WorkflowChainContext = {
  productChain: {
    chainId: 1,
    id: "sui-testnet",
    name: "Sui Testnet",
    nativeSymbol: "SUI",
  },
  analysisChain: {
    chainId: 0,
    id: "sui",
    name: "Sui",
    nativeSymbol: "SUI",
    source: "product-fallback",
    supported: true,
  },
};

const signals: DiscoverSignals = {
  combined: {
    providers: ["Surf", "Dune"],
    sourceIds: ["source-1"],
    status: "success",
    summary: "Social and on-chain evidence aligned.",
    toolIds: ["smart_money.surf"],
  },
  onchain: {
    providers: ["Surf", "Dune"],
    sourceIds: [],
    status: "success",
    summary: "On-chain enrichment returned direct rows.",
    toolIds: ["smart_money.surf"],
  },
  social: {
    providers: ["Surf"],
    sourceIds: ["source-1"],
    status: "success",
    summary: "Social context is available.",
    toolIds: [],
  },
};

const smartMoneyReport: ResearchReport = {
  asOfUtc: "2026-05-24T00:00:00.000Z",
  bottomLine: "Direct wallet-flow evidence supports a watchlist.",
  caveats: [],
  confidence: "high",
  entities: [],
  executiveSummary: "Direct smart-money evidence exists on Sui.",
  kind: "smart-money",
  recommendations: ["Confirm with a second source before escalation."],
  sections: [],
  tables: [],
  title: "Sui smart-money report",
};

const onChain: OnChainToolFinalPayload = {
  answer: "Surf returned row-level smart-money rows.",
  bullets: ["Evidence: row-level wallet flow."],
  caveat: "Analysis only.",
  generatedAt: "2026-05-24T00:00:00.000Z",
  plan: {
    analysisSource: "product-fallback",
    chain: "sui",
    chainId: 0,
    chainName: "Sui",
    commands: [
      {
        commandId: "smart_money.surf",
        domain: "smart_money",
        provider: "surf",
        reason: "Find wallet-flow rows.",
        title: "Surf smart money",
      },
    ],
    domainCount: 1,
    intent: "smart-money",
    nativeSymbol: "SUI",
    productChain: "sui-testnet",
    productChainId: 1,
    productChainName: "Sui Testnet",
    registryCommandCount: 84,
  },
  recommendation: "Watch confirmed candidates only.",
  title: "Sui alpha",
  tools: [
    {
      commandId: "smart_money.surf",
      data: {
        rows: [
          {
            account: "0x1111111111111111111111111111111111111111",
            amount_usd: 125000,
            symbol: "CELO",
          },
        ],
      },
      domain: "smart_money",
      latencyMs: 10,
      provider: "surf",
      status: "success",
      summary: "Surf returned direct wallet-flow rows.",
      title: "Surf smart money",
    },
  ],
};

const proof: ZeroGProof = {
  chain: {
    agentId: "94",
    briefHash: "0xbrief",
    chain: "celo",
    decisionHash: "0xdecision",
    decisionId: "182",
    signalType: "smart-money",
    status: "anchored",
  },
  storage: {
    evidenceUri: "langclaw://evidence/run/hash",
    rootHash: "0xdecision",
    status: "prepared",
  },
};

test("high quality Celo smart-money signal becomes alert eligible", () => {
  const alphaSignal = buildAlphaSignal({
    chainContext,
    generatedAt: "2026-05-24T00:00:00.000Z",
    onChain,
    proof,
    report: smartMoneyReport,
    signals,
    sources: [
      {
        excerpt: "Celo smart-money flow context.",
        id: "source-1",
        provider: "Surf",
        title: "Celo context",
        type: "docs_page",
        url: "https://example.com",
      },
    ],
    topic: "Find smart-money accumulation on Celo",
  });

  assert.equal(alphaSignal.alertEligible, true);
  assert.equal(alphaSignal.quality.sourceCoverage.directWalletFlow, true);
  assert.equal(alphaSignal.quality.sourceCoverage.onchain, true);
  assert.equal(alphaSignal.quality.sourceCoverage.proof, true);
  assert.ok(alphaSignal.quality.score >= 70);
});

test("social-only signal is blocked by false positive checks", () => {
  const alphaSignal = buildAlphaSignal({
    chainContext,
    report: {
      ...smartMoneyReport,
      confidence: "medium",
      executiveSummary: "Social context exists without direct on-chain rows.",
    },
    signals: {
      ...signals,
      onchain: {
        providers: [],
        sourceIds: [],
        status: "skipped",
        summary: "On-chain enrichment was skipped.",
        toolIds: [],
      },
    },
    sources: [],
    topic: "Find smart-money accumulation on Celo",
  });

  assert.equal(alphaSignal.alertEligible, false);
  assert.equal(
    alphaSignal.quality.falsePositiveChecks.find(
      (check) => check.id === "social_only_guard"
    )?.status,
    "fail"
  );
});

test("external low-confidence fallback cannot trigger alpha alert", () => {
  const alphaSignal = buildAlphaSignal({
    chainContext,
    onChain: {
      ...onChain,
      tools: onChain.tools.map((tool) => ({
        ...tool,
        data: {
          ...(tool.data as Record<string, unknown>),
          routeDebug: {
            selectedRoute: "dune.smart_money_sql.external_token_signal",
          },
        },
      })),
    },
    proof,
    report: {
      ...smartMoneyReport,
      caveats: ["Used an external low-confidence token signal."],
    },
    signals,
    sources: [],
    topic: "Find smart-money accumulation for CELO on Celo",
  });

  assert.equal(alphaSignal.alertEligible, false);
  assert.equal(
    alphaSignal.quality.falsePositiveChecks.find(
      (check) => check.id === "external_low_confidence_guard"
    )?.status,
    "fail"
  );
});

test("supplemental external context warns but does not block direct Celo alpha", () => {
  const alphaSignal = buildAlphaSignal({
    chainContext,
    onChain: {
      ...onChain,
      tools: onChain.tools.map((tool) => ({
        ...tool,
        data: {
          ...(tool.data as Record<string, unknown>),
          routeDebug: {
            selectedRoute: "dune.smart_money_sql.primary",
          },
        },
        summary:
          "Supplemental Ethereum CELO CEX transfer lookup returned 1 row as external low-confidence context.",
      })),
    },
    proof,
    report: {
      ...smartMoneyReport,
      caveats: ["Supplemental external low-confidence context was labeled."],
    },
    signals,
    sources: [],
    topic: "Find smart-money accumulation on Celo",
  });

  assert.equal(alphaSignal.alertEligible, true);
  assert.equal(
    alphaSignal.quality.falsePositiveChecks.find(
      (check) => check.id === "external_low_confidence_guard"
    )?.status,
    "warn"
  );
});

test("negated external fallback text in user prompt does not trip the external guard", () => {
  const alphaSignal = buildAlphaSignal({
    chainContext,
    onChain,
    proof,
    report: smartMoneyReport,
    signals,
    sources: [],
    topic:
      "Find smart-money accumulation on Celo. Do not use external low-confidence token context.",
  });

  assert.equal(
    alphaSignal.quality.falsePositiveChecks.find(
      (check) => check.id === "external_low_confidence_guard"
    )?.status,
    "pass"
  );
});

test("CEX deposit-only wording cannot count as accumulation", () => {
  const alphaSignal = buildAlphaSignal({
    chainContext,
    onChain: {
      ...onChain,
      answer: "CEX deposit evidence exists.",
      bullets: ["Evidence: CEX deposit rows."],
      recommendation: "Do not treat deposit-only rows as accumulation.",
      tools: onChain.tools.map((tool) => ({
        ...tool,
        summary: "CEX deposit rows only.",
      })),
    },
    proof,
    report: {
      ...smartMoneyReport,
      bottomLine: "CEX deposit evidence exists. No other confirmation was retrieved.",
      executiveSummary: "CEX deposit evidence exists.",
    },
    signals,
    sources: [],
    topic: "Find smart-money accumulation on Celo",
  });

  assert.equal(alphaSignal.alertEligible, false);
  assert.equal(
    alphaSignal.quality.falsePositiveChecks.find(
      (check) => check.id === "cex_deposit_guard"
    )?.status,
    "fail"
  );
});
