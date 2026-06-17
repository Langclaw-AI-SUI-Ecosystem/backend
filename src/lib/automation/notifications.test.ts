import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAlphaSignalNotificationMessage,
  buildAutomationNotificationMessage,
  resolveNotificationChannels,
  sendAlphaSignalNotification,
  sendAutomationEmail,
  sendAutomationRunNotification,
} from "./notifications";
import type { AlphaSignal, ResearchReport } from "../langclaw/types";
import type { OnChainToolFinalPayload } from "../onchain-tools/types";
import type { AutomationSettings } from "./types";

const settings: AutomationSettings = {
  autoPauseRepeatedFailures: true,
  dailyLimit0G: "25",
  developerModeEnabled: false,
  failureNotification: "email",
  limitBehavior: "pause",
  lowBalanceThreshold0G: "10",
  monthlyCap0G: "500",
  notificationChannels: ["email", "telegram"],
  notificationEmail: "ops@example.com",
  notificationEmailVerified: true,
  retryPolicy: "3-attempts",
  telegramChatId: "123",
  telegramVerified: true,
  thresholdAction: "notify",
  writeRunLogsToMemory: false,
};

test("automation notification message includes run context", () => {
  const message = buildAutomationNotificationMessage({
    completedAt: "2026-05-15T12:00:00.000Z",
    durationMs: 32000,
    error: "Daily automation MNT limit reached.",
    project: "Langclaw Website",
    runId: "run-1",
    status: "skipped",
    taskName: "Usage digest sync",
    triggeredBy: "schedule",
  });

  assert.equal(
    message.subject,
    "Langclaw Sui alert Skipped: Usage digest sync"
  );
  assert.match(message.text, /Project: Langclaw Website/);
  assert.match(message.text, /Reason: Daily automation MNT limit reached\./);
});

test("rich alpha signal notification includes target, warning, proof, and action", () => {
  const alphaSignal = buildTestAlphaSignal();
  const message = buildAlphaSignalNotificationMessage({
    alphaSignal,
    completedAt: "2026-05-24T12:00:00.000Z",
    onChain: buildTestOnChainPayload(),
    project: "Sui Alpha",
    proof: {
      chain: {
        chain: "mantle",
        chainName: "Mantle",
        briefHash: "0xbrief",
        decisionId: "194",
        explorerUrl: "https://explorer.mantle.xyz/tx/0xabc",
        status: "anchored",
        txHash: "0xabc",
      },
      storage: {
        evidenceUri: "langclaw://evidence/run/hash",
        status: "prepared",
      },
    },
    report: buildTestReport(),
    runId: "run-alpha-1",
    taskName: "Mantle smart-money scan",
  });

  assert.equal(message.subject, "Langclaw Alpha Alert: Smart Money on Mantle");
  assert.match(message.text, /Target: 0xbdb3\.\.\.47b6, MNT, CEX withdrawal/);
  assert.match(message.text, /Confidence: high, 82\/100/);
  assert.match(message.text, /Why now: Dune returned usable wallet-flow evidence\./);
  assert.match(message.text, /Warnings: 1, provider gap/);
  assert.match(message.text, /Proof: anchored, decision 194/);
  assert.match(message.text, /TX: https:\/\/explorer\.mantle\.xyz\/tx\/0xabc/);
  assert.match(message.text, /Action: Review candidate wallets before escalation\./);
  assert.match(message.text, /Run: run-alpha-1/);
});

test("alpha signal notification falls back to minimal message without report context", () => {
  const message = buildAlphaSignalNotificationMessage({
    alphaSignal: buildTestAlphaSignal(),
    completedAt: "2026-05-24T12:00:00.000Z",
    project: "Sui Alpha",
    proof: {
      chain: {
        briefHash: "0xbrief",
        status: "anchored",
      },
      storage: {
        evidenceUri: "langclaw://evidence/run/hash",
        status: "prepared",
      },
    },
    runId: "run-alpha-1",
    taskName: "Mantle smart-money scan",
  });

  assert.equal(message.subject, "Langclaw Alpha Alert: smart-money");
  assert.match(message.text, /Quality score: 82\/100/);
  assert.match(message.text, /Proof: anchored/);
  assert.match(message.text, /Run ID: run-alpha-1/);
});

test("alpha signal Telegram notification is disabled unless the flag is enabled", async () => {
  const originalFlag = process.env.LANGCLAW_ALPHA_ALERTS_ENABLED;
  delete process.env.LANGCLAW_ALPHA_ALERTS_ENABLED;

  try {
    const notification = await sendAlphaSignalNotification({
      alphaSignal: buildTestAlphaSignal(),
      project: "Sui Alpha",
      runId: "run-alpha-1",
      settings,
      taskName: "Mantle smart-money scan",
    });

    assert.deepEqual(notification, {
      channel: "none",
      reason: "LANGCLAW_ALPHA_ALERTS_ENABLED is not true.",
      status: "disabled",
    });
  } finally {
    if (originalFlag === undefined) {
      delete process.env.LANGCLAW_ALPHA_ALERTS_ENABLED;
    } else {
      process.env.LANGCLAW_ALPHA_ALERTS_ENABLED = originalFlag;
    }
  }
});

test("alpha signal Telegram notification posts when enabled", async () => {
  const originalFetch = globalThis.fetch;
  const originalFlag = process.env.LANGCLAW_ALPHA_ALERTS_ENABLED;
  const originalToken = process.env.LANGCLAW_TELEGRAM_BOT_TOKEN;
  let requestBody: unknown;

  globalThis.fetch = (async (_url, init) => {
    requestBody = JSON.parse(String(init?.body));

    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  process.env.LANGCLAW_ALPHA_ALERTS_ENABLED = "true";
  process.env.LANGCLAW_TELEGRAM_BOT_TOKEN = "test-token";

  try {
    const notification = await sendAlphaSignalNotification({
      alphaSignal: buildTestAlphaSignal(),
      project: "Sui Alpha",
      runId: "run-alpha-1",
      settings,
      taskName: "Mantle smart-money scan",
    });

    const body = requestBody as {
      chat_id: string;
      disable_web_page_preview: boolean;
      text: string;
    };

    assert.equal(notification.status, "sent");
    assert.equal(body.chat_id, "123");
    assert.equal(body.disable_web_page_preview, true);
    assert.match(
      body.text,
      /Langclaw Alpha Alert: smart-money/
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalFlag === undefined) {
      delete process.env.LANGCLAW_ALPHA_ALERTS_ENABLED;
    } else {
      process.env.LANGCLAW_ALPHA_ALERTS_ENABLED = originalFlag;
    }
    if (originalToken === undefined) {
      delete process.env.LANGCLAW_TELEGRAM_BOT_TOKEN;
    } else {
      process.env.LANGCLAW_TELEGRAM_BOT_TOKEN = originalToken;
    }
  }
});

test("notification channels exclude in-app and honor disabled notifications", () => {
  assert.deepEqual(resolveNotificationChannels(settings), ["email", "telegram"]);
  assert.deepEqual(
    resolveNotificationChannels({
      ...settings,
      failureNotification: "none",
    }),
    []
  );
  assert.deepEqual(
    resolveNotificationChannels({
      ...settings,
      notificationChannels: ["in-app", "telegram"],
    }),
    ["telegram"]
  );
});

function buildTestAlphaSignal(): AlphaSignal {
  return {
    alertEligible: true,
    generatedAt: "2026-05-24T12:00:00.000Z",
    quality: {
      alertEligible: true,
      evidenceCount: 4,
      falsePositiveChecks: [
        {
          id: "sui_product_chain",
          label: "Sui product chain",
          reason: "The decision is scoped to Sui.",
          status: "pass",
        },
        {
          id: "provider_gap_guard",
          label: "Provider gap guard",
          reason: "No blocking provider gap was detected.",
          status: "warn",
        },
      ],
      label: "high",
      reasons: ["Quality score 82/100 is high."],
      score: 82,
      sourceCoverage: {
        directWalletFlow: true,
        onchain: true,
        proof: true,
        providerCount: 2,
        social: true,
      },
    },
    schema: "langclaw.alpha-signal.v1",
    signalType: "smart-money",
  };
}

function buildTestReport(): ResearchReport {
  return {
    asOfUtc: "2026-05-24T12:00:00.000Z",
    bottomLine: "Direct wallet-flow evidence supports a Mantle alpha watch.",
    caveats: [],
    confidence: "high",
    entities: [
      {
        category: "candidate-smart-money",
        id: "wallet-1",
        label: "0xbdb3...47b6",
        metrics: {
          signal: "CEX withdrawal",
          token: "MNT",
        },
        rank: 1,
        severity: "high",
        sourceIds: [],
        summary: "Candidate smart-money wallet-flow.",
        toolIds: ["smart_money.surf_smart_money_research"],
      },
    ],
    executiveSummary: "Dune returned row-level Mantle wallet-flow evidence.",
    kind: "smart-money",
    recommendations: ["Review candidate wallets before escalation."],
    sections: [],
    tables: [
      {
        columns: ["Wallet", "Token", "Signal"],
        id: "smart-money-table",
        rows: [
          {
            Signal: "CEX withdrawal",
            Token: "MNT",
            Wallet: "0xbdb3...47b6",
          },
        ],
        title: "Candidate Smart-Money Wallets",
      },
    ],
    title: "Mantle Smart-Money Accumulation Watch",
  };
}

function buildTestOnChainPayload(): OnChainToolFinalPayload {
  return {
    answer: "Dune returned row-level Mantle wallet-flow evidence.",
    bullets: [],
    caveat: "Analysis only.",
    generatedAt: "2026-05-24T12:00:00.000Z",
    plan: {
      analysisSource: "prompt",
      chain: "mantle",
      chainId: 5000,
      chainName: "Mantle",
      commands: [],
      domainCount: 14,
      intent: "smart-money",
      nativeSymbol: "MNT",
      productChain: "sui-testnet",
      productChainId: 1,
      productChainName: "Sui Testnet",
      registryCommandCount: 84,
    },
    recommendation: "Review candidate wallets before escalation.",
    title: "Mantle smart-money report",
    tools: [
      {
        attemptedProviders: ["surf", "dune"],
        commandId: "smart_money.surf_smart_money_research",
        domain: "smart_money",
        latencyMs: 100,
        provider: "dune",
        status: "success",
        summary: "Dune returned row-level Mantle wallet-flow evidence.",
        title: "Surf smart-money research",
      },
    ],
  };
}

test("sendAutomationEmail posts the requested payload to Resend", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.RESEND_API_KEY;
  const originalFrom = process.env.LANGCLAW_AUTOMATION_EMAIL_FROM;
  let requestBody: unknown;

  globalThis.fetch = (async (_url, init) => {
    requestBody = JSON.parse(String(init?.body));

    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  process.env.RESEND_API_KEY = "test-api-key";
  process.env.LANGCLAW_AUTOMATION_EMAIL_FROM = "alerts@example.com";

  try {
    await sendAutomationEmail({
      subject: "Verify your Langclaw automation email",
      text: "123456",
      to: "user@example.com",
    });

    assert.deepEqual(requestBody, {
      from: "alerts@example.com",
      subject: "Verify your Langclaw automation email",
      text: "123456",
      to: "user@example.com",
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.RESEND_API_KEY;
    } else {
      process.env.RESEND_API_KEY = originalApiKey;
    }
    if (originalFrom === undefined) {
      delete process.env.LANGCLAW_AUTOMATION_EMAIL_FROM;
    } else {
      process.env.LANGCLAW_AUTOMATION_EMAIL_FROM = originalFrom;
    }
  }
});

test("sendAutomationEmail requires an explicit verified sender for verification mail", async () => {
  const originalApiKey = process.env.RESEND_API_KEY;
  const originalFrom = process.env.LANGCLAW_AUTOMATION_EMAIL_FROM;
  const originalResendEmailFrom = process.env.RESEND_EMAIL_FROM;
  const originalResendFromEmail = process.env.RESEND_FROM_EMAIL;

  process.env.RESEND_API_KEY = "test-api-key";
  delete process.env.LANGCLAW_AUTOMATION_EMAIL_FROM;
  delete process.env.RESEND_EMAIL_FROM;
  delete process.env.RESEND_FROM_EMAIL;

  try {
    await assert.rejects(
      sendAutomationEmail({
        requireConfigured: true,
        subject: "Verify your Langclaw automation email",
        text: "123456",
        to: "user@example.com",
      }),
      /LANGCLAW_AUTOMATION_EMAIL_FROM must be set to a verified Resend sender/
    );
  } finally {
    if (originalApiKey === undefined) {
      delete process.env.RESEND_API_KEY;
    } else {
      process.env.RESEND_API_KEY = originalApiKey;
    }
    if (originalFrom === undefined) {
      delete process.env.LANGCLAW_AUTOMATION_EMAIL_FROM;
    } else {
      process.env.LANGCLAW_AUTOMATION_EMAIL_FROM = originalFrom;
    }
    if (originalResendEmailFrom === undefined) {
      delete process.env.RESEND_EMAIL_FROM;
    } else {
      process.env.RESEND_EMAIL_FROM = originalResendEmailFrom;
    }
    if (originalResendFromEmail === undefined) {
      delete process.env.RESEND_FROM_EMAIL;
    } else {
      process.env.RESEND_FROM_EMAIL = originalResendFromEmail;
    }
  }
});

test("sendAutomationEmail includes Resend 403 details and config hint", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.RESEND_API_KEY;
  const originalFrom = process.env.LANGCLAW_AUTOMATION_EMAIL_FROM;

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        message: "The sender address is not verified.",
      }),
      {
        headers: {
          "Content-Type": "application/json",
        },
        status: 403,
      }
    )) as typeof fetch;

  process.env.RESEND_API_KEY = "test-api-key";
  process.env.LANGCLAW_AUTOMATION_EMAIL_FROM = "alerts@example.com";

  try {
    await assert.rejects(
      sendAutomationEmail({
        subject: "Verify your Langclaw automation email",
        text: "123456",
        to: "user@example.com",
      }),
      /Email notification failed with 403: The sender address is not verified.*verified Resend domain/
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.RESEND_API_KEY;
    } else {
      process.env.RESEND_API_KEY = originalApiKey;
    }
    if (originalFrom === undefined) {
      delete process.env.LANGCLAW_AUTOMATION_EMAIL_FROM;
    } else {
      process.env.LANGCLAW_AUTOMATION_EMAIL_FROM = originalFrom;
    }
  }
});

test("automation email notifications require a verified linked email", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.RESEND_API_KEY;
  const originalFallbackTo = process.env.LANGCLAW_AUTOMATION_EMAIL_TO;
  let requestCount = 0;

  globalThis.fetch = (async () => {
    requestCount += 1;

    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  process.env.RESEND_API_KEY = "test-api-key";
  process.env.LANGCLAW_AUTOMATION_EMAIL_TO = "fallback@example.com";

  try {
    await sendAutomationRunNotification({
      completedAt: "2026-05-15T12:00:00.000Z",
      durationMs: 1000,
      error: "Daily automation MNT limit reached.",
      project: "Langclaw Website",
      runId: "run-1",
      settings: {
        ...settings,
        notificationEmail: undefined,
        notificationEmailVerified: false,
        notificationChannels: ["email"],
      },
      status: "skipped",
      taskName: "Usage digest sync",
      triggeredBy: "schedule",
    });

    assert.equal(requestCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.RESEND_API_KEY;
    } else {
      process.env.RESEND_API_KEY = originalApiKey;
    }
    if (originalFallbackTo === undefined) {
      delete process.env.LANGCLAW_AUTOMATION_EMAIL_TO;
    } else {
      process.env.LANGCLAW_AUTOMATION_EMAIL_TO = originalFallbackTo;
    }
  }
});
