import assert from "node:assert/strict";
import test from "node:test";

import { withEnv } from "../../test/helpers";
import { isTelegramLinkRequired } from "./account-auth";

test("Telegram link gate is fail-closed in production", async () => {
  await withEnv({ NODE_ENV: "production", LANGCLAW_REQUIRE_TELEGRAM: undefined }, async () => {
    assert.equal(isTelegramLinkRequired(), true);
  });

  await withEnv({ NODE_ENV: "production", LANGCLAW_REQUIRE_TELEGRAM: "false" }, async () => {
    assert.equal(isTelegramLinkRequired(), false);
  });

  await withEnv({ NODE_ENV: "test", LANGCLAW_REQUIRE_TELEGRAM: undefined }, async () => {
    assert.equal(isTelegramLinkRequired(), false);
  });

  await withEnv({ NODE_ENV: "test", LANGCLAW_REQUIRE_TELEGRAM: "true" }, async () => {
    assert.equal(isTelegramLinkRequired(), true);
  });
});
