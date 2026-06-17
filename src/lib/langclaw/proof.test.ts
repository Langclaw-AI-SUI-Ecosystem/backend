import assert from "node:assert/strict";
import test from "node:test";

import { waitForSubmittedTransactionReceipt } from "./proof";

test("waits for submitted transaction receipts", async () => {
  let attempts = 0;
  const receipt = await waitForSubmittedTransactionReceipt({
    attempts: 3,
    intervalMs: 1,
    publicClient: {
      async getTransactionReceipt() {
        attempts += 1;

        return attempts === 2 ? { status: "success" as const } : null;
      },
    },
    txHash:
      "0x1111111111111111111111111111111111111111111111111111111111111111",
  });

  assert.deepEqual(receipt, { status: "success" });
  assert.equal(attempts, 2);
});
