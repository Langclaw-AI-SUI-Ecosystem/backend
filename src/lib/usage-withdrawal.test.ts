import assert from "node:assert/strict";
import test from "node:test";

import {
  readUsageVaultBalanceNeuron,
  UsageHttpError,
} from "./usage";

test("reads the Sui usage vault balance from Move object content", () => {
  assert.equal(
    readUsageVaultBalanceNeuron({
      data: {
        content: {
          fields: {
            balance: "170000000",
          },
        },
      },
    }),
    "170000000"
  );
});

test("rejects a Sui usage vault object without a numeric balance", () => {
  assert.throws(
    () =>
      readUsageVaultBalanceNeuron({
        data: { content: { fields: { balance: "not-a-number" } } },
      }),
    (error: unknown) =>
      error instanceof UsageHttpError &&
      error.status === 503 &&
      error.message.includes("balance could not be read")
  );
});
