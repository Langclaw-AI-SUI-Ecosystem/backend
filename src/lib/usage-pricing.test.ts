import assert from "node:assert/strict";
import test from "node:test";

import {
  applyMarkupNeuron,
  buildUsageMeter,
  calculateMarkupNeuron,
  calculateTokenCostNeuron,
  formatUsageModelLabel,
  mapUiTokenUsage,
  readUsageMarkupBps,
  selectUsageCost,
} from "./usage-pricing";
import { withEnv } from "../test/helpers";

test("calculates raw cost from token usage", () => {
  assert.equal(
    calculateTokenCostNeuron({
      completionPriceNeuron: "5",
      completionTokens: 7,
      promptPriceNeuron: "2",
      promptTokens: 11,
    }),
    "57"
  );
});

test("uses Router trace cost before token pricing", () => {
  const selected = selectUsageCost({
    completionPriceNeuron: "5",
    computeStatus: "used",
    promptPriceNeuron: "2",
    reservedNeuron: "999",
    routerTrace: { billing: { totalCostNeuron: "123" } },
    tokenUsage: { completionTokens: 7, promptTokens: 11 },
  });

  assert.deepEqual(selected, {
    chargedRawNeuron: "123",
    costSource: "router-trace",
    status: "charged",
  });
});

test("falls back to reserved estimate when trace and usage are missing", () => {
  const selected = selectUsageCost({
    completionPriceNeuron: "5",
    computeStatus: "used",
    promptPriceNeuron: "2",
    reservedNeuron: "999",
  });

  assert.deepEqual(selected, {
    chargedRawNeuron: "999",
    costSource: "reserved-estimate",
    status: "estimated",
  });
});

test("uses UI input/output token estimates for token pricing", () => {
  const selected = selectUsageCost({
    completionPriceNeuron: "5",
    computeStatus: "used",
    promptPriceNeuron: "2",
    reservedNeuron: "999",
    tokenUsage: { inputTokens: 11, outputTokens: 7 },
  });

  assert.deepEqual(selected, {
    chargedRawNeuron: "57",
    costSource: "token-estimate",
    status: "charged",
  });
});

test("default usage markup is 30 percent", async () => {
  await withEnv({ LANGCLAW_USAGE_MARKUP_BPS: undefined }, () => {
    assert.equal(readUsageMarkupBps(), 3000);
    assert.equal(calculateMarkupNeuron("1000", readUsageMarkupBps()), "300");
    assert.equal(applyMarkupNeuron("1000", readUsageMarkupBps()), "1300");
  });
});

test("honors custom LANGCLAW_USAGE_MARKUP_BPS", async () => {
  await withEnv({ LANGCLAW_USAGE_MARKUP_BPS: "1250" }, () => {
    assert.equal(readUsageMarkupBps(), 1250);
    assert.equal(calculateMarkupNeuron("1000", readUsageMarkupBps()), "125");
    assert.equal(applyMarkupNeuron("1000", readUsageMarkupBps()), "1125");
  });
});

test("maps token usage into UI-ready fields while keeping legacy fields", () => {
  assert.deepEqual(
    mapUiTokenUsage({
      cachedInputTokens: 3,
      completionTokens: 7,
      maxTokens: 64,
      promptTokens: 11,
      reasoningTokens: 2,
      totalTokens: 18,
    }),
    {
      cachedInputTokens: 3,
      completionTokens: 7,
      inputTokens: 11,
      maxTokens: 64,
      outputTokens: 7,
      promptTokens: 11,
      reasoningTokens: 2,
      totalTokens: 18,
    }
  );
});

test("builds usage meter data for the model badge and detail popover", () => {
  const meter = buildUsageMeter({
    model: "openai/gpt-5-mini",
    tokenUsage: {
      inputTokens: 563,
      outputTokens: 149,
      reasoningTokens: 128,
    },
    totalConsumeNeuron: "439",
  });

  assert.equal(meter.modelLabel, "GPT-5 mini");
  assert.equal(meter.badge.modelLabel, "GPT-5 mini");
  assert.equal(meter.badge.totalConsumeLabel, "439");
  assert.equal(meter.outputDetails.totalTokens, 149);
  assert.deepEqual(
    meter.outputDetails.items.map((item) => [item.key, item.tokens]),
    [
      ["deep_thinking", 128],
      ["text_output", 21],
    ]
  );
  assert.equal(meter.consumeDetails.totalTokens, 712);
  assert.deepEqual(
    meter.consumeDetails.items.map((item) => [item.key, item.tokens]),
    [
      ["uncached_input", 563],
      ["output", 149],
    ]
  );
  assert.equal(meter.tokenCost, 712);
  assert.equal(meter.totalConsumeNeuron, "439");
});

test("usage meter excludes cached input from token cost", () => {
  const meter = buildUsageMeter({
    model: "custom-chat",
    tokenUsage: {
      cachedInputTokens: 3,
      inputTokens: 11,
      outputTokens: 7,
    },
    totalConsumeNeuron: "57",
  });

  assert.equal(meter.consumeDetails.totalTokens, 15);
  assert.equal(meter.consumeDetails.cachedInputTokens, 3);
  assert.deepEqual(
    meter.consumeDetails.items.map((item) => [item.key, item.tokens]),
    [
      ["uncached_input", 8],
      ["output", 7],
    ]
  );
});

test("formats GPT model labels for compact backend display data", () => {
  assert.equal(formatUsageModelLabel("gpt-5-mini"), "GPT-5 mini");
  assert.equal(formatUsageModelLabel("openai/gpt-4o-mini"), "GPT-4o mini");
});
