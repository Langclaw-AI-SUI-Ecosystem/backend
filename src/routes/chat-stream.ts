import type { DirectChatPayload } from "../lib/chat-sessions";
import { readProductChainId, resolveProductChain } from "../lib/chain-config";
import {
  accountAuthErrorResponse,
  requireAccountAuth,
  requireTelegramLinkedAccount,
} from "../lib/server/account-auth";
import type { WalletAuthInput } from "../lib/server/wallet-auth";
import { runPrivateMemoryWorkflow } from "../lib/memory-workflow";
import type { WorkflowProgressEvent } from "../lib/langclaw/types";
import {
  automationErrorResponse,
  readAutomationSettings,
} from "../lib/automation/service";
import type {
  OnChainPlanSummary,
  OnChainToolCallEvent,
  OnChainToolResult,
} from "../lib/onchain-tools/types";
import {
  buildDeveloperModeUsageReceipt,
  refundResearchUsage,
  reserveResearchUsage,
  settleResearchUsage,
  usageErrorResponse,
  type UsageReservation,
} from "../lib/usage";
import { streamDirectChatWithOpenAI } from "../lib/openai-direct-chat";

type ChatMessageInput = {
  role?: unknown;
  content?: unknown;
};

type ChatRequestBody = {
  attachments?: unknown;
  files?: unknown;
  message?: unknown;
  messages?: unknown;
  researchTrend?: unknown;
  sessionId?: unknown;
  toolMode?: unknown;
  useAgent?: unknown;
  wallet?: WalletAuthInput;
  chain?: unknown;
  model?: unknown;
};

type ContextMessage = {
  role: "assistant" | "user";
  content: string;
};

export async function handleChatStream(request: Request) {
  let body: ChatRequestBody;

  try {
    body = (await request.json()) as ChatRequestBody;
  } catch {
    return Response.json(
      { error: "Request body must be valid JSON." },
      { status: 400 }
    );
  }

  if (hasUnsupportedAttachments(body)) {
    return Response.json(
      {
        error:
          "Multimodal attachments are not supported by the backend yet.",
      },
      { status: 400 }
    );
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  const context = readContextMessages(body.messages);
  const requestedToolMode = readToolMode(body.toolMode, body.researchTrend);
  const toolMode = resolveEffectiveToolMode(message, requestedToolMode);
  const selectedChain = resolveProductChain(readProductChainId(body.chain));
  const useAgent = toolMode === "research" || body.useAgent === true;
  const shouldBillUsage = useAgent;

  if (!message) {
    return Response.json({ error: "Message is required." }, { status: 400 });
  }

  const account = await requireAccountAuth({
    request,
    wallet: body.wallet ?? {},
  }).catch((error) => ({ error }));

  if ("error" in account) {
    return accountAuthErrorResponse(account.error);
  }

  const telegram = await requireTelegramLinkedAccount(account).catch((error) => ({
    error,
  }));

  if ("error" in telegram) {
    return accountAuthErrorResponse(telegram.error);
  }

  let reservation: UsageReservation | undefined;
  let developerModeEnabled = false;

  if (shouldBillUsage) {
    const automationSettings = await readAutomationSettings({ account }).catch(
      (error) => ({ error })
    );

    if ("error" in automationSettings) {
      return automationErrorResponse(automationSettings.error);
    }

    developerModeEnabled = automationSettings.developerModeEnabled;
  }

  if (shouldBillUsage && !developerModeEnabled) {
    try {
      reservation = await reserveResearchUsage({ account }, {}, selectedChain.id);
    } catch (error) {
      return usageErrorResponse(error);
    }
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      let usageSettled = false;

      const stopIfAborted = () => {
        if (closed || request.signal.aborted) {
          closed = true;
          throw new Error("Request aborted.");
        }
      };

      const write = (payload: unknown) => {
        if (closed || request.signal.aborted) {
          return;
        }

        controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
      };

      request.signal.addEventListener(
        "abort",
        () => {
          closed = true;
        },
        { once: true }
      );

      try {
        stopIfAborted();

        if (!useAgent) {
          let streamedAnswer = "";
          const writeReasoningProgress = createDirectReasoningProgressWriter(
            write
          );

          write({
            type: "direct_reasoning_delta",
            delta: buildDirectReasoningSummary({
              contextCount: context.length,
              requestedModel: body.model,
              toolMode,
            }),
          });
          const direct = await streamDirectChatWithOpenAI({
            context,
            message,
            requestedModel: body.model,
            signal: request.signal,
            onDelta: (delta) => {
              stopIfAborted();
              streamedAnswer += delta;
              writeReasoningProgress(delta);
              write({ type: "direct_delta", delta });
            },
          });

          stopIfAborted();
          write({
            type: "direct_reasoning_delta",
            delta:
              direct.source === "openai"
                ? `Answer streamed with ${direct.usedModel ?? direct.model ?? "OpenAI"}.\n`
                : `Fallback answer used because the model request was unavailable. ${direct.error || ""}\n`,
          });
          write({
            type: "direct",
            payload: {
              answer: direct.answer || streamedAnswer,
              error: direct.error,
              fallbackFrom: direct.fallbackFrom,
              model: direct.model,
              modelHonored: direct.modelHonored,
              requestedModel: direct.requestedModel,
              source: direct.source,
              usage: direct.usage,
              usedModel: direct.usedModel,
            } satisfies DirectChatPayload,
          });
          return;
        }

        const topic = buildAgentTopic(message, context);

        write({ type: "mode", mode: "agent" });
        // Chat research runs through the private-memory workflow so the chat
        // surface gains the same verifiable Walrus memory (recall + Seal-encrypt
        // + store + Sui anchor + walrusMemory proof) as /api/discover. Tool/
        // progress streaming is preserved via the forwarded callbacks, and the
        // chat conversation context is merged with recalled prior memories.
        const payload = await runPrivateMemoryWorkflow({
          topic,
          ownerAddress: account.walletUser.walletAddress,
          chain: selectedChain.id,
          requestedModel: body.model,
          context,
          onEvent: (event: WorkflowProgressEvent) => {
            stopIfAborted();
            write({ type: "progress", event });
          },
          onToolCall: (event: OnChainToolCallEvent) => {
            stopIfAborted();
            write({ type: "tool_call", event });
          },
          onToolPlan: (plan: OnChainPlanSummary) => {
            stopIfAborted();
            write({ type: "tool_plan", plan });
          },
          onToolResult: (event: OnChainToolResult) => {
            stopIfAborted();
            write({ type: "tool_result", event });
          },
          signal: request.signal,
        });
        const proof = payload.proof ?? payload.zeroG;
        const providerTrace = proof?.compute
          ? {
              billing: proof.compute.billing,
              provider: proof.compute.provider,
              requestId: proof.compute.requestId,
              teeVerified: proof.compute.teeVerified,
            }
          : undefined;

        payload.usage = reservation
          ? await settleResearchUsage({
              computeStatus: proof?.compute?.status,
              reservation,
              providerTrace,
              tokenUsage: proof?.compute?.usage,
              topic,
            })
          : buildDeveloperModeUsageReceipt({
              account,
              chainInput: selectedChain.id,
              model:
                proof?.compute?.usedModel ??
                proof?.compute?.model ??
                (typeof body.model === "string" ? body.model : undefined),
              providerTrace,
              tokenUsage: proof?.compute?.usage,
            });
        usageSettled = true;

        stopIfAborted();
        write({ type: "result", payload });
      } catch (error) {
        if (reservation && !usageSettled) {
          await refundResearchUsage(
            reservation,
            error instanceof Error ? error.message : "Chat failed."
          ).catch(() => undefined);
        }

        if (!request.signal.aborted) {
          write({
            type: "error",
            error: error instanceof Error ? error.message : "Chat failed.",
          });
        }
      } finally {
        closed = true;
        if (!request.signal.aborted) {
          controller.close();
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "X-Accel-Buffering": "no",
    },
  });
}

function readContextMessages(value: unknown): ContextMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item: ChatMessageInput) => {
      const role = item?.role;
      const content =
        typeof item?.content === "string" ? item.content.trim() : "";

      if ((role !== "assistant" && role !== "user") || !content) {
        return null;
      }

      return { role, content };
    })
    .filter((item): item is ContextMessage => Boolean(item))
    .slice(-12);
}

export function buildChatWorkflowOptions(
  requestedModel: unknown,
  onEvent: (event: WorkflowProgressEvent) => void | Promise<void>,
  chain?: string,
  extras?: {
    context?: ContextMessage[];
    onToolCall?: (event: OnChainToolCallEvent) => void | Promise<void>;
    onToolPlan?: (plan: OnChainPlanSummary) => void | Promise<void>;
    onToolResult?: (event: OnChainToolResult) => void | Promise<void>;
    signal?: AbortSignal;
  }
) {
  return {
    chain,
    context: extras?.context,
    onToolCall: extras?.onToolCall,
    onToolPlan: extras?.onToolPlan,
    onToolResult: extras?.onToolResult,
    requestedModel,
    onEvent,
    signal: extras?.signal,
  };
}

function hasUnsupportedAttachments(body: ChatRequestBody) {
  if (hasItems(body.attachments) || hasItems(body.files)) {
    return true;
  }

  const values = [
    body.message,
    ...(Array.isArray(body.messages) ? body.messages : []),
  ];

  return values.some((value) => containsFilePart(value));
}

function hasItems(value: unknown) {
  return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null;
}

function containsFilePart(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }

  if (Array.isArray(value)) {
    return value.some(containsFilePart);
  }

  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type.toLowerCase() : "";

  if (
    type === "file" ||
    type === "image" ||
    type === "image_url" ||
    type === "fileuipart"
  ) {
    return true;
  }

  return Object.values(record).some(containsFilePart);
}

function buildAgentTopic(message: string, context: ContextMessage[]) {
  if (!isContextualFollowUp(message)) {
    return message;
  }

  const previousUser = [...context]
    .reverse()
    .find((item) => item.role === "user" && item.content !== message);

  if (!previousUser) {
    return message;
  }

  return `${previousUser.content}. Follow-up request: ${message}`;
}

function isContextualFollowUp(message: string) {
  return /\b(itu|tadi|sebelumnya|lanjut|lanjutkan|same|that|previous|di atas|tersebut)\b/i.test(
    message
  );
}

function readToolMode(toolMode: unknown, researchTrend: unknown) {
  if (toolMode === "chat") {
    return "chat";
  }

  if (toolMode === "onchain") {
    return "research";
  }

  if (toolMode === "research" || researchTrend === true) {
    return "research";
  }

  return "chat";
}

export function resolveEffectiveToolMode(message: string, requestedToolMode: string) {
  if (requestedToolMode === "chat" && isSmartMoneyResearchPrompt(message)) {
    return "research";
  }

  return requestedToolMode;
}

function isSmartMoneyResearchPrompt(message: string) {
  const normalized = message.trim();

  return (
    /\b(find|analy[sz]e|rank|track|detect|show|monitor|watch)\b/i.test(normalized) &&
    /\bsmart[-\s]?money\b/i.test(normalized) &&
    /\b(accumulat\w*|flow|wallet|whale|dex|holder|buy|sell|netflow|net\s*flow)\b/i.test(normalized)
  );
}

function buildDirectReasoningSummary({
  contextCount,
  requestedModel,
  toolMode,
}: {
  contextCount: number;
  requestedModel: unknown;
  toolMode: string;
}) {
  const model =
    typeof requestedModel === "string" && requestedModel.trim()
      ? requestedModel.trim()
      : "default OpenAI chat model";

  return [
    `Route selected: ${toolMode}.`,
    `Context: using ${contextCount} recent message${contextCount === 1 ? "" : "s"}.`,
    `Model: ${model}.`,
    "Plan: answer directly, preserve the user's language, and format with clear Markdown when helpful.",
    "",
  ].join("\n");
}

function createDirectReasoningProgressWriter(write: (payload: unknown) => void) {
  let started = false;
  let characterCount = 0;
  let nextProgressAt = 280;
  let progressIndex = 0;
  const progressNotes = [
    "Structuring the response into readable sections.",
    "Checking wording against the current chat context.",
    "Preserving clean Markdown spacing while the answer streams.",
  ];

  return (delta: string) => {
    if (!delta) {
      return;
    }

    characterCount += delta.length;

    if (!started) {
      started = true;
      write({
        type: "direct_reasoning_delta",
        delta: "Live stream: answer tokens received; drafting the response now.\n",
      });
    }

    while (characterCount >= nextProgressAt) {
      const estimatedOutputTokens = Math.max(1, Math.ceil(characterCount / 4));
      const note =
        progressNotes[Math.min(progressIndex, progressNotes.length - 1)];

      write({
        type: "direct_reasoning_delta",
        delta: `Live stream: ${note} Output drafted: about ${estimatedOutputTokens} tokens.\n`,
      });

      progressIndex += 1;
      nextProgressAt += 280;
    }
  };
}
