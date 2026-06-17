import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const backendRoot = process.cwd();
const serverSource = readFileSync(join(backendRoot, "src/server.ts"), "utf8");
const adminRouteSource = readFileSync(join(backendRoot, "src/routes/admin.ts"), "utf8");

test("admin usage vault routes are registered behind admin route handlers", () => {
  assert.ok(
    serverSource.includes("POST /api/admin/usage-vault/status"),
    "Expected backend to expose an admin status route.",
  );
  assert.ok(
    serverSource.includes("POST /api/admin/usage-vault/withdrawals/verify"),
    "Expected backend to expose an admin withdrawal audit route.",
  );
  assert.ok(
    adminRouteSource.includes("readUsageVaultAdminStatus") &&
      adminRouteSource.includes("verifyUsageVaultWithdrawal"),
    "Expected admin routes to use usage vault admin authorization helpers.",
  );
});
