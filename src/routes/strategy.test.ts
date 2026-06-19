import assert from "node:assert/strict";
import test from "node:test";

import {
  handleStrategyBacktest,
  handleStrategyPaperTrade,
  handleStrategyScanPairs,
} from "./strategy";

for (const [name, handler] of [
  ["backtest", handleStrategyBacktest],
  ["paper trade", handleStrategyPaperTrade],
  ["pair scan", handleStrategyScanPairs],
] as const) {
  test(`strategy ${name} rejects anonymous requests`, async () => {
    const response = await handler(
      new Request(`http://localhost/api/strategy/${name}`, {
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
      configured: false,
      error: "Wallet signature or API key is required.",
    });
  });
}
