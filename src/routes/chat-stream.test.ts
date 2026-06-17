import assert from "node:assert/strict";
import test from "node:test";

import {
  buildChatWorkflowOptions,
  handleChatStream,
  resolveEffectiveToolMode,
} from "./chat-stream";
import {
  createWalletChallenge,
  normalizeSuiAddress,
  verifyWalletSession,
} from "../lib/server/wallet-auth";
import {
  jsonResponse,
  mockFetch,
  readNdjson,
  sseResponse,
  withEnv,
} from "../test/helpers";

// Fixed Sui address echoed by the Supabase wallet-user mock; it does not need to
// match the signing keypair for these tests (no flow compares the two).
const normalizedTestAddress = normalizeSuiAddress(`0x${"11".repeat(32)}`);

const authEnv = {
  SUPABASE_SERVICE_ROLE_KEY: "service-role",
  SUPABASE_URL: "https://supabase.test",
};

// @mysten/sui is ESM-only; load it dynamically so this CommonJS-compiled test
// typechecks (no static require of an ESM module).
type Signer = {
  toSuiAddress(): string;
  signPersonalMessage(bytes: Uint8Array): Promise<{ signature: string }>;
};

let cachedKeypair: Signer | null = null;

async function getKeypair(): Promise<Signer> {
  if (!cachedKeypair) {
    const { Ed25519Keypair } = await import("@mysten/sui/keypairs/ed25519");
    cachedKeypair = new Ed25519Keypair() as unknown as Signer;
  }

  return cachedKeypair;
}

async function buildTestWallet() {
  const keypair = await getKeypair();
  const suiAddress = keypair.toSuiAddress();
  const challenge = createWalletChallenge({
    address: suiAddress,
    request: new Request("http://localhost/api/wallet/challenge"),
  });
  const { signature } = await keypair.signPersonalMessage(
    new TextEncoder().encode(challenge.message)
  );
  const verified = await verifyWalletSession(
    {
      address: suiAddress,
      message: challenge.message,
      signature,
    },
    { requiredPurpose: "session" }
  );

  assert.ok(verified?.sessionToken);

  return {
    address: verified.address,
    sessionExpiresAt: verified.sessionExpiresAt,
    sessionToken: verified.sessionToken,
  };
}

function isSupabaseRequest(url: string) {
  return new URL(url).hostname === "supabase.test";
}

function supabaseWalletResponse() {
  return jsonResponse({
    id: "00000000-0000-4000-8000-000000000001",
    wallet_address: normalizedTestAddress,
  });
}

function supabaseTelegramSettingsResponse(
  linked = true,
  developerModeEnabled = false
) {
  return jsonResponse({
    auto_pause_repeated_failures: true,
    daily_limit_neuron: "25000000000000000000",
    developer_mode_enabled: developerModeEnabled,
    failure_notification: "email",
    limit_behavior: "pause",
    low_balance_threshold_neuron: "10000000000000000000",
    monthly_cap_neuron: "500000000000000000000",
    notification_channels: ["email", "telegram"],
    notification_email: null,
    notification_email_linked_at: null,
    notification_email_pending: null,
    notification_email_verified: false,
    retry_policy: "3-attempts",
    telegram_chat_id: linked ? "5705926766" : null,
    telegram_linked_at: linked ? "2026-05-24T12:00:00.000Z" : null,
    telegram_username: linked ? "test_user" : null,
    telegram_verified: linked,
    threshold_action: "notify",
    write_run_logs_to_memory: false,
  });
}

function supabaseAccountResponse(
  url: string,
  telegramLinked = true,
  developerModeEnabled = false
) {
  const parsed = new URL(url);

  if (parsed.pathname.includes("/langclaw_automation_settings")) {
    return supabaseTelegramSettingsResponse(
      telegramLinked,
      developerModeEnabled
    );
  }

  return supabaseWalletResponse();
}

test("direct chat rejects attachments until multimodal contract exists", async () => {
  const response = await handleChatStream(
    new Request("http://localhost/api/chat/stream", {
      body: JSON.stringify({
        attachments: [{ name: "evidence.png" }],
        message: "analyze this",
      }),
      method: "POST",
    })
  );

  assert.equal(response.status, 400);
  assert.match(
    (await response.json() as { error: string }).error,
    /Multimodal attachments are not supported/
  );
});

test("direct chat rejects AI SDK FileUIPart payloads", async () => {
  const response = await handleChatStream(
    new Request("http://localhost/api/chat/stream", {
      body: JSON.stringify({
        message: {
          data: "base64",
          mimeType: "image/png",
          type: "file",
        },
      }),
      method: "POST",
    })
  );

  assert.equal(response.status, 400);
});

test("direct chat requires wallet auth", async () => {
  const response = await handleChatStream(
    new Request("http://localhost/api/chat/stream", {
      body: JSON.stringify({
        message: "halo",
      }),
      method: "POST",
    })
  );

  assert.equal(response.status, 401);
  assert.match((await response.json() as { error: string }).error, /required/);
});

test("smart-money accumulation prompts auto-route from chat to research", () => {
  assert.equal(
    resolveEffectiveToolMode("Find smart-money accumulation on Arbitrum", "chat"),
    "research"
  );
  assert.equal(
    resolveEffectiveToolMode("Analyze smart money wallet flow on Ethereum", "chat"),
    "research"
  );
  assert.equal(resolveEffectiveToolMode("what is smart money?", "chat"), "chat");
  assert.equal(
    resolveEffectiveToolMode("Find smart-money accumulation on Arbitrum", "research"),
    "research"
  );
});

test("legacy on-chain mode now aliases to research and still requires wallet auth", async () => {
  const response = await handleChatStream(
    new Request("http://localhost/api/chat/stream", {
      body: JSON.stringify({
        message: "Find trending tokens on Base",
        toolMode: "onchain",
      }),
      method: "POST",
    })
  );
  const payload = (await response.json()) as { error: string };

  assert.equal(response.status, 401);
  assert.match(payload.error, /required/);
});

test("direct chat requires linked Telegram after wallet auth", async () => {
  const restore = mockFetch((url) =>
    isSupabaseRequest(url)
      ? supabaseAccountResponse(url, false)
      : jsonResponse({ ok: true })
  );

  try {
    await withEnv(
      { ...authEnv, LANGCLAW_REQUIRE_TELEGRAM: "true" },
      async () => {
        const response = await handleChatStream(
          new Request("http://localhost/api/chat/stream", {
            body: JSON.stringify({
              message: "halo",
              wallet: await buildTestWallet(),
            }),
            method: "POST",
          })
        );
        const payload = (await response.json()) as {
          code?: string;
          error: string;
        };

        assert.equal(response.status, 403);
        assert.equal(payload.code, "telegram_link_required");
        assert.match(payload.error, /Telegram connection is required/);
      }
    );
  } finally {
    restore();
  }
});

test("developer mode skips usage reservation for research prompts", async () => {
  let reserveCalled = false;
  let finalizeCalled = false;

  const restore = mockFetch((url) => {
    const parsed = new URL(url);

    if (isSupabaseRequest(url)) {
      if (parsed.pathname.includes("/rpc/langclaw_usage_reserve_balance")) {
        reserveCalled = true;

        return jsonResponse([
          {
            balance_after_neuron: "999999999999988000",
            balance_before_neuron: "1000000000000000000",
          },
        ]);
      }

      if (parsed.pathname.includes("/rpc/langclaw_usage_finalize_reservation")) {
        finalizeCalled = true;

        return jsonResponse([
          {
            balance_after_neuron: "999999999999984400",
            charged_neuron: "1600",
            released_neuron: "0",
            status: "charged",
          },
        ]);
      }

      return supabaseAccountResponse(url, true, true);
    }

    if (parsed.hostname === "www.hackquest.io") {
      return new Response(
        '<html><body><a href="/hackathons/sui-overflow">Sui Overflow Hackathon</a></body></html>',
        {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
          },
          status: 200,
        }
      );
    }

    if (parsed.hostname === "api.dexscreener.com") {
      return jsonResponse({
        pairs: [
          {
            baseToken: { symbol: "MNT" },
            chainId: "mantle",
            dexId: "agni",
            liquidity: { usd: 125000 },
            priceUsd: "1.01",
          },
        ],
      });
    }

    return jsonResponse({ ok: true });
  });

  try {
    await withEnv(authEnv, async () => {
      const response = await handleChatStream(
        new Request("http://localhost/api/chat/stream", {
          body: JSON.stringify({
            message: "Detect liquidity anomalies on Mantle DEX pairs",
            toolMode: "research",
            wallet: await buildTestWallet(),
          }),
          method: "POST",
        })
      );
      const events = await readNdjson(response);
      const result = events.find((event) => event.type === "result");
      const payload = result?.payload as
        | {
            usage?: {
              chargedNeuron?: string;
              reservedNeuron?: string;
              status?: string;
            };
          }
        | undefined;

      assert.equal(response.status, 200);
      assert.equal(reserveCalled, false);
      assert.equal(finalizeCalled, false);
      assert.equal(payload?.usage?.reservedNeuron, "0");
      assert.equal(payload?.usage?.chargedNeuron, "0");
      assert.equal(payload?.usage?.status, "estimated");
    });
  } finally {
    restore();
  }
});

test("legacy on-chain mode aliases to research and returns a hybrid result payload", async () => {
  const restore = mockFetch((url) => {
    const parsed = new URL(url);

    if (isSupabaseRequest(url)) {
      if (parsed.pathname.includes("/rpc/langclaw_usage_reserve_balance")) {
        return jsonResponse([
          {
            balance_after_neuron: "999999999999988000",
            balance_before_neuron: "1000000000000000000",
          },
        ]);
      }

      if (parsed.pathname.includes("/rpc/langclaw_usage_finalize_reservation")) {
        return jsonResponse([
          {
            balance_after_neuron: "999999999999984400",
            charged_neuron: "1600",
            completion_tokens: 80,
            prompt_tokens: 120,
            released_neuron: "0",
            status: "charged",
          },
        ]);
      }

      return supabaseAccountResponse(url);
    }

    if (parsed.hostname === "www.hackquest.io") {
      return new Response(
        '<html><body><a href="/hackathons/sui-overflow">Sui Overflow Hackathon</a></body></html>',
        {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
          },
          status: 200,
        }
      );
    }

    if (parsed.hostname === "api.dexscreener.com") {
      return jsonResponse({
        pairs: [
          {
            baseToken: { symbol: "MNT" },
            chainId: "mantle",
            dexId: "agni",
            liquidity: { usd: 125000 },
            priceUsd: "1.01",
          },
        ],
      });
    }

    return jsonResponse({ ok: true });
  });

  try {
    await withEnv(authEnv, async () => {
      const response = await handleChatStream(
        new Request("http://localhost/api/chat/stream", {
          body: JSON.stringify({
            message: "Detect liquidity anomalies on Mantle DEX pairs",
            toolMode: "onchain",
            wallet: await buildTestWallet(),
          }),
          method: "POST",
        })
      );
      const events = await readNdjson(response);
      const result = events.find((event) => event.type === "result");
      const payload = result?.payload as
        | {
            signals?: {
              combined?: { status?: string };
              onchain?: { status?: string };
              social?: { status?: string };
            };
            finalAnswer?: { answerMarkdown?: string };
            onChain?: { tools?: Array<{ provider?: string }> };
            onChainSkippedReason?: string;
          }
        | undefined;

      assert.equal(response.status, 200);
      assert.ok(events.some((event) => event.type === "progress"));
      assert.ok(events.some((event) => event.type === "tool_call"));
      assert.ok(events.some((event) => event.type === "tool_result"));
      assert.ok(events.some((event) => event.type === "result"));
      assert.equal(events.some((event) => event.type === "tool_final"), false);
      assert.equal(typeof payload?.finalAnswer?.answerMarkdown, "string");
      assert.ok(payload?.onChain?.tools?.some((tool) => tool.provider === "dexscreener"));
      assert.equal(payload?.onChainSkippedReason, undefined);
      assert.equal(payload?.signals?.social?.status, "partial");
      assert.equal(payload?.signals?.onchain?.status, "success");
      assert.equal(payload?.signals?.combined?.status, "partial");
    });
  } finally {
    restore();
  }
});

test("direct chat honors supported body.model and returns metadata", async () => {
  const restore = mockFetch((url) => {
    if (isSupabaseRequest(url)) {
      return supabaseAccountResponse(url);
    }

    return jsonResponse({ ok: true });
  });

  try {
    await withEnv(
      {
        ...authEnv,
        OPENAI_API_KEY: "",
        OPENAI_CHAT_MODEL: "default-chat",
      },
      async () => {
        const response = await handleChatStream(
          new Request("http://localhost/api/chat/stream", {
            body: JSON.stringify({
              message: "halo",
              model: "custom-chat",
              wallet: await buildTestWallet(),
            }),
            method: "POST",
          })
        );
        const events = await readNdjson(response);
        const direct = events.find((event) => event.type === "direct");
        const reasoning = events
          .filter((event) => event.type === "direct_reasoning_delta")
          .map((event) => event.delta)
          .join("");
        const payload = direct?.payload as Record<string, unknown>;

        assert.equal(response.status, 200);
        assert.match(reasoning, /Route selected: chat/);
        assert.match(reasoning, /Model: custom-chat/);
        assert.equal(payload.requestedModel, "custom-chat");
        assert.equal(payload.usedModel, "custom-chat");
        assert.equal(payload.model, "custom-chat");
        assert.equal(payload.modelHonored, true);
      }
    );
  } finally {
    restore();
  }
});

test("direct chat streams safe reasoning progress while OpenAI answer streams", async () => {
  let openAiInstructions = "";
  const restore = mockFetch((url, init) => {
    const parsed = new URL(url);

    if (isSupabaseRequest(url)) {
      return supabaseAccountResponse(url);
    }

    if (parsed.hostname === "api.openai.test") {
      const body =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : {};
      openAiInstructions = String(body.instructions ?? "");
      const firstDelta =
        "Halo. Aku akan susun jawaban yang rapi dengan konteks yang sudah ada. ";
      const secondDelta =
        "Pertama, aku cek maksud request dan menjaga bahasa tetap natural. ".repeat(
          5
        );
      const thirdDelta =
        "\n\nBerikut versi finalnya dengan poin yang mudah discan.";

      return sseResponse([
        `data: ${JSON.stringify({
          type: "response.output_text.delta",
          delta: firstDelta,
        })}`,
        "",
        `data: ${JSON.stringify({
          type: "response.output_text.delta",
          delta: secondDelta,
        })}`,
        "",
        `data: ${JSON.stringify({
          type: "response.output_text.delta",
          delta: thirdDelta,
        })}`,
        "",
        `data: ${JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp-chat-test",
            model: "gpt-5-mini",
            usage: {
              input_tokens: 10,
              output_tokens: 40,
              total_tokens: 50,
            },
          },
        })}`,
        "",
      ]);
    }

    return jsonResponse({ ok: true });
  });

  try {
    await withEnv(
      {
        ...authEnv,
        OPENAI_API_KEY: "test-key",
        OPENAI_BASE_URL: "https://api.openai.test/v1",
        OPENAI_CHAT_MODEL: "gpt-5-mini",
      },
      async () => {
        const response = await handleChatStream(
          new Request("http://localhost/api/chat/stream", {
            body: JSON.stringify({
              message: "tolong rapikan response AI",
              wallet: await buildTestWallet(),
            }),
            method: "POST",
          })
        );
        const events = await readNdjson(response);
        const reasoningEvents = events.filter(
          (event) => event.type === "direct_reasoning_delta"
        );
        const reasoning = reasoningEvents
          .map((event) => event.delta)
          .join("");
        const firstReasoningIndex = events.findIndex(
          (event) => event.type === "direct_reasoning_delta"
        );
        const firstDeltaIndex = events.findIndex(
          (event) => event.type === "direct_delta"
        );
        const direct = events.find((event) => event.type === "direct");
        const payload = direct?.payload as Record<string, unknown>;

        assert.equal(response.status, 200);
        assert.ok(reasoningEvents.length >= 4);
        assert.ok(firstReasoningIndex > -1);
        assert.ok(firstDeltaIndex > -1);
        assert.ok(firstReasoningIndex < firstDeltaIndex);
        assert.match(reasoning, /Live stream: answer tokens received/);
        assert.match(reasoning, /Output drafted: about/);
        assert.match(openAiInstructions, /Detected response language: Indonesian/);
        assert.match(openAiInstructions, /Write all user-visible prose in Indonesian/);
        assert.equal(payload.source, "openai");
      }
    );
  } finally {
    restore();
  }
});

test("direct chat uses configured OpenAI default model when none is requested", async () => {
  const restore = mockFetch((url) =>
    isSupabaseRequest(url) ? supabaseAccountResponse(url) : jsonResponse({ data: [] })
  );

  try {
    await withEnv(
      {
        ...authEnv,
        OPENAI_API_KEY: "",
        OPENAI_CHAT_MODEL: "default-chat",
      },
      async () => {
        const response = await handleChatStream(
          new Request("http://localhost/api/chat/stream", {
            body: JSON.stringify({
              message: "halo",
              wallet: await buildTestWallet(),
            }),
            method: "POST",
          })
        );
        const events = await readNdjson(response);
        const direct = events.find((event) => event.type === "direct");
        const payload = direct?.payload as Record<string, unknown>;

        assert.equal(payload.usedModel, "default-chat");
        assert.equal(payload.model, "default-chat");
        assert.equal(payload.modelHonored, true);
      }
    );
  } finally {
    restore();
  }
});

test("agent mode passes requested model into workflow options", () => {
  const options = buildChatWorkflowOptions("agent-model", () => undefined);

  assert.equal(options.requestedModel, "agent-model");
  assert.equal(typeof options.onEvent, "function");
});

test("research mode streams on-chain enrichment events and nests the result payload", async () => {
  let reserveCalled = false;
  let finalizeCalled = false;
  let finalizedCharge: unknown;

  const restore = mockFetch((url, init) => {
    const parsed = new URL(url);

    if (isSupabaseRequest(url)) {
      if (parsed.pathname.includes("/rpc/langclaw_usage_reserve_balance")) {
        reserveCalled = true;

        return jsonResponse([
          {
            balance_after_neuron: "999999999999988000",
            balance_before_neuron: "1000000000000000000",
          },
        ]);
      }

      if (parsed.pathname.includes("/rpc/langclaw_usage_finalize_reservation")) {
        finalizeCalled = true;
        finalizedCharge =
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as Record<string, unknown>).p_charged_neuron
            : undefined;
        const finalizedPromptTokens =
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as Record<string, unknown>).p_prompt_tokens
            : undefined;
        const finalizedCompletionTokens =
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as Record<string, unknown>)
                .p_completion_tokens
            : undefined;

        return jsonResponse([
          {
            balance_after_neuron: "999999999999984400",
            charged_neuron: finalizedCharge,
            completion_tokens: finalizedCompletionTokens,
            prompt_tokens: finalizedPromptTokens,
            released_neuron: "0",
            status: "charged",
          },
        ]);
      }

      return supabaseAccountResponse(url);
    }

    if (parsed.hostname === "api.dexscreener.com") {
      return jsonResponse({
        pairs: [
          {
            baseToken: { symbol: "MNT" },
            chainId: "mantle",
            dexId: "agni",
            liquidity: { usd: 100000 },
            priceUsd: "1",
          },
        ],
      });
    }

    return jsonResponse({ ok: true });
  });

  try {
    await withEnv(authEnv, async () => {
      const response = await handleChatStream(
        new Request("http://localhost/api/chat/stream", {
          body: JSON.stringify({
            message: "Detect liquidity anomalies on Mantle DEX pairs",
            toolMode: "research",
            wallet: await buildTestWallet(),
          }),
          method: "POST",
        })
      );
      const events = await readNdjson(response);

      assert.equal(response.status, 200);
      assert.ok(events.some((event) => event.type === "tool_plan"));
      assert.ok(events.some((event) => event.type === "tool_call"));

      const toolResult = events.find((event) => event.type === "tool_result");
      const toolEvent = toolResult?.event as
        | { data?: unknown; sourceUrl?: string; status?: string }
        | undefined;

      assert.equal(toolEvent?.status, "success");
      assert.ok(toolEvent?.sourceUrl);
      assert.ok(toolEvent?.data);

      const result = events.find((event) => event.type === "result");
      const payload = result?.payload as
        | {
          onChain?: {
            tools?: Array<{ data?: unknown }>;
          };
            finalAnswer?: { answerMarkdown?: string };
            usage?: {
              chargedNeuron?: string;
              costSource?: string;
              inputTokens?: number;
              outputTokens?: number;
              status?: string;
              totalTokens?: number;
            };
          }
        | undefined;

      assert.ok(payload?.onChain?.tools?.some((tool) => tool.data));
      assert.equal(typeof payload?.finalAnswer?.answerMarkdown, "string");
      assert.equal(payload?.usage?.chargedNeuron, finalizedCharge);
      assert.equal(payload?.usage?.costSource, "reserved-estimate");
      assert.equal(payload?.usage?.status, "charged");
      assert.equal(reserveCalled, true);
      assert.equal(finalizeCalled, true);
      assert.notEqual(finalizedCharge, "15600");
    });
  } finally {
    restore();
  }
});
