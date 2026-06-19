import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const backendRoot = process.cwd();
const serverSource = readFileSync(join(backendRoot, "src/server.ts"), "utf8");
const usageRouteSource = readFileSync(join(backendRoot, "src/routes/usage.ts"), "utf8");

test("usage withdrawal routes are registered behind wallet-authenticated handlers", () => {
  assert.ok(
    serverSource.includes("POST /api/usage/withdraw/request"),
    "Expected backend to expose a user withdrawal request route.",
  );
  assert.ok(
    serverSource.includes("POST /api/usage/withdrawals"),
    "Expected backend to expose a user withdrawal list route.",
  );
  assert.ok(
    usageRouteSource.includes("requestUsageWithdrawalForChain") &&
      usageRouteSource.includes("listUsageWithdrawalRequestsForChain"),
    "Expected user withdrawal routes to call wallet-authenticated usage helpers.",
  );
});
