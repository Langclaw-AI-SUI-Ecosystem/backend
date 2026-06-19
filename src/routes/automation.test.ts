import assert from "node:assert/strict";
import test from "node:test";

import {
  handleAutomationTelegramWebhook,
  handleAutomationWebhook,
} from "./automation";
import { withEnv } from "../test/helpers";

test("automation webhook rejects oversized payloads before execution", async () => {
  const body = JSON.stringify({ payload: "x".repeat(65 * 1024) });
  const response = await handleAutomationWebhook(
    new Request("http://localhost/api/automation/webhooks/oversized-test", {
      body,
      headers: {
        "Content-Length": String(Buffer.byteLength(body)),
        "X-Forwarded-For": "192.0.2.10",
      },
      method: "POST",
    }),
    "oversized-test"
  );

  assert.equal(response.status, 413);
  assert.match(
    ((await response.json()) as { error: string }).error,
    /too large/i
  );
});

test("automation webhook rate limits repeated slug attempts", async () => {
  let lastResponse = new Response(null, { status: 500 });

  for (let index = 0; index < 31; index += 1) {
    lastResponse = await handleAutomationWebhook(
      new Request("http://localhost/api/automation/webhooks/rate-test", {
        headers: {
          "X-Forwarded-For": "192.0.2.11",
        },
        method: "POST",
      }),
      "rate-test"
    );
  }

  assert.equal(lastResponse.status, 429);
  assert.equal(lastResponse.headers.has("Retry-After"), true);
});

test("automation webhook rejects invalid slugs before rate bucket allocation", async () => {
  const response = await handleAutomationWebhook(
    new Request("http://localhost/api/automation/webhooks/../../bad", {
      method: "POST",
    }),
    "../../bad"
  );

  assert.equal(response.status, 400);
});

test("Telegram webhook requires the configured secret token", async () => {
  await withEnv(
    { LANGCLAW_TELEGRAM_WEBHOOK_SECRET_TOKEN: "telegram-secret" },
    async () => {
      const missing = await handleAutomationTelegramWebhook(
        new Request("http://localhost/api/automation/telegram/webhook", {
          body: JSON.stringify({ message: { text: "9A3A093A29" } }),
          method: "POST",
        })
      );

      assert.equal(missing.status, 401);

      const accepted = await handleAutomationTelegramWebhook(
        new Request("http://localhost/api/automation/telegram/webhook", {
          body: JSON.stringify({ message: { text: "9A3A093A29" } }),
          headers: {
            "X-Telegram-Bot-Api-Secret-Token": "telegram-secret",
          },
          method: "POST",
        })
      );

      assert.notEqual(accepted.status, 401);
    }
  );
});
