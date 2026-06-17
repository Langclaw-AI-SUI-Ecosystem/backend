import {
  getDefaultOpenAIModel,
  hasOpenAIApiKey,
  streamOpenAITextResponse,
  type OpenAITextMessage,
} from "./openai/responses";
import { detectResponseLanguage } from "./response-language";
import { buildUsageMeter, mapUiTokenUsage } from "./usage-pricing";

export type DirectChatContextMessage = {
  role: "assistant" | "user";
  content: string;
};

type DirectChatInput = {
  message: string;
  context: DirectChatContextMessage[];
  requestedModel?: unknown;
  signal: AbortSignal;
  onDelta?: (delta: string) => void;
};

export type OpenAIModelSelection = {
  fallbackFrom?: string;
  modelHonored: boolean;
  requestedModel?: string;
  usedModel: string;
};

export async function streamDirectChatWithOpenAI({
  context,
  message,
  onDelta,
  requestedModel,
  signal,
}: DirectChatInput) {
  const selection = resolveOpenAIModelSelection(requestedModel, "chat");
  const model = selection.usedModel;

  if (!hasOpenAIApiKey()) {
    const answer = buildLocalFallback(message, context);
    onDelta?.(answer);

    return {
      answer,
      error: "OPENAI_API_KEY is empty.",
      fallbackFrom: selection.fallbackFrom,
      model,
      modelHonored: selection.modelHonored,
      requestedModel: selection.requestedModel,
      source: "fallback" as const,
      usedModel: selection.usedModel,
    };
  }

  try {
    const result = await streamOpenAITextResponse({
      input: buildMessages(message, context),
      instructions: buildDirectChatInstructions(message),
      maxOutputTokens: readPositiveInt(process.env.OPENAI_CHAT_MAX_OUTPUT_TOKENS, 1800),
      model,
      onDelta,
      signal,
    });

    if (!result.text.trim()) {
      throw new Error("OpenAI returned an empty answer.");
    }

    return {
      answer: result.text.trim(),
      fallbackFrom: selection.fallbackFrom,
      model: result.model || model,
      modelHonored: selection.modelHonored,
      requestedModel: selection.requestedModel,
      source: "openai" as const,
      usage: buildDirectChatUsage({
        model: result.model || model,
        tokenUsage: result.usage,
      }),
      usedModel: result.model || selection.usedModel,
    };
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }

    const answer = buildLocalFallback(message, context);
    onDelta?.(answer);

    return {
      answer,
      error: error instanceof Error ? error.message : "OpenAI chat failed.",
      fallbackFrom: selection.fallbackFrom,
      model,
      modelHonored: selection.modelHonored,
      requestedModel: selection.requestedModel,
      source: "fallback" as const,
      usedModel: selection.usedModel,
    };
  }
}

export function resolveOpenAIModelSelection(
  requestedModel: unknown,
  kind: "agent" | "chat" = "chat"
): OpenAIModelSelection {
  const requested = typeof requestedModel === "string" ? requestedModel.trim() : "";
  const defaultModel = getDefaultOpenAIModel(kind);

  if (!requested) {
    return {
      modelHonored: true,
      usedModel: defaultModel,
    };
  }

  return {
    modelHonored: true,
    requestedModel: requested,
    usedModel: requested,
  };
}

function buildDirectChatUsage({
  model,
  tokenUsage,
}: {
  model: string;
  tokenUsage?: Parameters<typeof mapUiTokenUsage>[0];
}) {
  if (!tokenUsage) {
    return undefined;
  }

  const uiTokenUsage = mapUiTokenUsage(tokenUsage);

  return {
    ...uiTokenUsage,
    meter: buildUsageMeter({
      model,
      tokenUsage: uiTokenUsage,
    }),
    model,
  };
}

function buildMessages(
  message: string,
  context: DirectChatContextMessage[]
): OpenAITextMessage[] {
  const sessionContext = context.filter(
    (item, index) =>
      !(
        index === context.length - 1 &&
        item.role === "user" &&
        item.content === message
      )
  );

  return [
    ...sessionContext.slice(-10).map((item) => ({
      role: item.role,
      content: item.content,
    })),
    {
      role: "user",
      content: message,
    },
  ];
}

function buildDirectChatInstructions(message: string) {
  const language = detectResponseLanguage(message);

  return [
    "You are Langclaw, a concise and helpful chat assistant.",
    "Answer naturally in the user's language.",
    `Detected response language: ${language.label} (${language.confidence}). ${language.instruction}`,
    "If the user switches language in a later message, follow the latest user message.",
    "If the message is Indonesian or casual Indonesian spelling such as hay, hai, halo, or makasih, reply in Indonesian.",
    "Format every answer like a polished ChatGPT response: short paragraphs, clear section breaks, blank lines between sections, bullets or numbered lists for scannable details, and valid Markdown tables only when a table genuinely helps.",
    "Never return dense unbroken prose. Never compress words together.",
    "Keep every Markdown table row on its own line with a blank line before and after the table.",
    "Use the current chat session as context, especially prior research summaries, source cards, recommendations, and agent results.",
    "For follow-up questions like menurutmu, bagusnya aku buat apa, lanjut, itu, tadi, or sebelumnya, infer the topic from the previous messages and give a concrete answer.",
    "Do not ask for background that already exists in the session.",
    "Do not mention direct chat, routing, agent mode, OpenClaw, or internal workflows unless the user asks about them.",
  ].join(" ");
}

function buildLocalFallback(
  message: string,
  context: DirectChatContextMessage[]
) {
  const language = detectResponseLanguage(message);
  const isIndonesian = language.label === "Indonesian";
  const previousUser = [...context]
    .reverse()
    .find((item) => item.role === "user" && item.content !== message);

  if (/^(hai|halo|hello|hi|hay|hey|pagi|siang|malam)\b/i.test(message)) {
    return isIndonesian ? "Hai. Ada yang bisa aku bantu?" : "Hi. How can I help?";
  }

  if (/konteks|context|sebelumnya|tadi/i.test(message) && previousUser) {
    return isIndonesian
      ? `Konteks terakhir dari sesi ini adalah: "${previousUser.content}".`
      : `The last context from this session is: "${previousUser.content}".`;
  }

  return isIndonesian
    ? "Aku belum bisa menghubungi model chat sekarang. Coba lagi sebentar."
    : "I cannot reach the chat model right now. Try again shortly.";
}

function readPositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? "", 10);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
