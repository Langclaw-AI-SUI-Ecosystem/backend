import assert from "node:assert/strict";
import test from "node:test";

import { createWebhookSlug, readTelegramCodeFromText } from "./service";

test("automation webhook slugs use a 128-bit random suffix", () => {
  const first = createWebhookSlug("Daily Usage Digest");
  const second = createWebhookSlug("Daily Usage Digest");

  assert.match(first, /^daily-usage-digest-[a-f0-9]{32}$/);
  assert.match(second, /^daily-usage-digest-[a-f0-9]{32}$/);
  assert.notEqual(first, second);
});

test("Telegram link parser accepts link, start, and bare codes", () => {
  assert.equal(readTelegramCodeFromText("/link 9A3A093A29"), "9A3A093A29");
  assert.equal(readTelegramCodeFromText("/start 9A3A093A29"), "9A3A093A29");
  assert.equal(readTelegramCodeFromText("9a3a093a29"), "9A3A093A29");
});
