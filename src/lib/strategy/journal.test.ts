import assert from "node:assert/strict";
import test from "node:test";

import { persistTradingJournalRecord } from "./journal";
import { withEnv } from "../../test/helpers";

test("trading journal proof returns prepared when chain recording is disabled", async () => {
  await withEnv(
    {
      LANGCLAW_TRADING_JOURNAL_ADDRESS: "0x1111111111111111111111111111111111111111",
      SUI_AGENT_ID: "94",
      SUI_TRADING_JOURNAL_ENABLED: "false",
    },
    async () => {
      const proof = await persistTradingJournalRecord({
        action: "buy",
        decisionHash:
          "0x1111111111111111111111111111111111111111111111111111111111111111",
        evidenceUri: "langclaw://strategy/run-1",
        market: "sui-mainnet:0x2d70cbabf4d8e61d5317b62cbe912935fd94e0fe",
        pnlBps: 120,
        resultHash:
          "0x2222222222222222222222222222222222222222222222222222222222222222",
        runId: "run-1",
        status: "backtested",
        strategyId: "sui-liquidity-momentum-v1",
      });

      assert.equal(proof.status, "prepared");
      assert.equal(proof.agentId, "94");
      assert.equal(proof.chainId, 0);
      assert.match(proof.error ?? "", /SUI_TRADING_JOURNAL_ENABLED/);
    }
  );
});

test("trading journal proof uses selected Sui chain config", async () => {
  await withEnv(
    {
      SUI_LANGCLAW_TRADING_JOURNAL_ADDRESS:
        "0x2222222222222222222222222222222222222222",
      SUI_TRADING_JOURNAL_ENABLED: "false",
    },
    async () => {
      const proof = await persistTradingJournalRecord({
        action: "hold",
        chain: "sui-testnet",
        decisionHash:
          "0x1111111111111111111111111111111111111111111111111111111111111111",
        evidenceUri: "langclaw://strategy/run-sui",
        market: "sui-testnet:0x2d70cbabf4d8e61d5317b62cbe912935fd94e0fe",
        pnlBps: 0,
        resultHash:
          "0x2222222222222222222222222222222222222222222222222222222222222222",
        runId: "run-sui",
        status: "backtested",
        strategyId: "sui-testnet-liquidity-momentum-v1",
      });

      assert.equal(proof.status, "prepared");
      assert.equal(proof.chain, "sui-testnet");
      assert.equal(proof.chainId, 1);
      assert.equal(proof.chainName, "Sui Testnet");
      assert.match(proof.error ?? "", /SUI_TRADING_JOURNAL_ENABLED/);
    }
  );
});
