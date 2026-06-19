import assert from "node:assert/strict";
import test from "node:test";

import { UsageHttpError, verifyUsageDeposit } from "./usage";

test("deposit verification requires wallet proof before reading public chain data", async () => {
  await assert.rejects(
    verifyUsageDeposit({
      txHash: "11111111111111111111111111111111111111111111",
      wallet: {},
    }),
    (error: unknown) => {
      assert.ok(error instanceof UsageHttpError);
      assert.equal(error.status, 401);
      assert.equal(error.message, "Wallet signature is required.");
      return true;
    },
  );
});
