import assert from "node:assert/strict";
import test from "node:test";

import { buildProofReadinessReport } from "./proof-readiness";
import { withEnv } from "../test/helpers";

const testPrivateKey =
  "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const registryPackageId =
  "0xe69755e4249c4978c39fbe847ca9674ce7af3505e69755e4249c4978c39fbe84";
const recorderAddress =
  "0x2ca915ef6be8d2d48ccd3c5daf715546af873a4c2ca915ef6be8d2d48ccd3c5d";

function buildClient({
  latestAgentId = "94",
  latestRunId = "run-1",
  balanceMist = "1000000000",
}: {
  latestAgentId?: string;
  latestRunId?: string;
  balanceMist?: string;
} = {}) {
  return {
    async getChainIdentifier() {
      return "sui:mainnet";
    },
    async getBalance(_input: { owner: string; coinType?: string }) {
      return { totalBalance: balanceMist };
    },
    async queryEvents(_input: {
      query: Record<string, unknown>;
      limit?: number;
      order?: "ascending" | "descending";
    }) {
      return {
        data: [
          {
            type: `${registryPackageId}::decision_registry::DecisionRecorded`,
            parsedJson: {
              agent_id: latestAgentId,
              run_id: latestRunId,
              decision_hash:
                "0x1111111111111111111111111111111111111111111111111111111111111111",
              evidence_uri: "langclaw://evidence/run/hash",
              signal_type: "smart-money",
              recorder: recorderAddress,
            },
          },
        ],
      };
    },
  };
}

const readyEnv = {
  SUI_AGENT_PRIVATE_KEY: testPrivateKey,
  SUI_AGENT_ID: "94",
  SUI_CHAIN_ENABLED: "true",
  SUI_CHAIN_RPC_URL: "https://fullnode.mainnet.sui.test",
  SUI_INTEL_PROOF_ENABLED: "true",
  SUI_LANGCLAW_REGISTRY_PACKAGE_ID: registryPackageId,
};

test("proof readiness passes when Sui proof env and registry are usable", async () => {
  await withEnv(readyEnv, async () => {
    const report = await buildProofReadinessReport({
      publicClient: buildClient(),
      recorderAddress,
    });

    assert.equal(report.ready, true);
    assert.equal(report.status, "ready");
    assert.equal(report.chain, "sui-mainnet");
    assert.equal(report.latestDecision?.agentId, "94");
    assert.ok(report.checks.every((check) => check.status === "pass"));
  });
});

test("proof readiness fails when the recorder key is missing", async () => {
  await withEnv(
    {
      ...readyEnv,
      SUI_AGENT_PRIVATE_KEY: undefined,
      SUI_PRIVATE_KEY: undefined,
    },
    async () => {
      const report = await buildProofReadinessReport({
        publicClient: buildClient(),
        recorderAddress,
      });

      assert.equal(report.ready, false);
      assert.equal(report.status, "not_ready");
      assert.equal(
        report.checks.find((check) => check.id === "agent-private-key")?.status,
        "fail"
      );
    }
  );
});

test("proof readiness accepts SUI_PRIVATE_KEY as the recorder fallback", async () => {
  await withEnv(
    {
      ...readyEnv,
      SUI_AGENT_PRIVATE_KEY: undefined,
      SUI_PRIVATE_KEY: testPrivateKey,
    },
    async () => {
      const report = await buildProofReadinessReport({
        publicClient: buildClient(),
        recorderAddress,
      });

      assert.equal(report.ready, true);
      assert.equal(report.status, "ready");
      assert.equal(
        report.checks.find((check) => check.id === "agent-private-key")?.status,
        "pass"
      );
    }
  );
});

test("proof readiness warns when the latest decision belongs to another agent", async () => {
  await withEnv(readyEnv, async () => {
    const report = await buildProofReadinessReport({
      publicClient: buildClient({
        latestAgentId: "9109",
        latestRunId: "run-2",
      }),
      recorderAddress,
    });

    assert.equal(report.ready, true);
    assert.equal(report.status, "warning");
    assert.equal(report.latestDecision?.agentId, "9109");
    assert.equal(report.latestDecision?.decisionId, "run-2");
    assert.equal(
      report.checks.find((check) => check.id === "latest-decision")?.status,
      "warn"
    );
  });
});

test("proof readiness warns when direct on-chain tool proof is disabled", async () => {
  await withEnv(
    {
      ...readyEnv,
      SUI_INTEL_PROOF_ENABLED: "false",
    },
    async () => {
      const report = await buildProofReadinessReport({
        publicClient: buildClient(),
        recorderAddress,
      });

      assert.equal(report.ready, true);
      assert.equal(report.status, "warning");
      assert.equal(
        report.checks.find((check) => check.id === "onchain-tool-proof-enabled")?.status,
        "warn"
      );
    }
  );
});
