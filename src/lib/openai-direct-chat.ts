import {
  getDefaultOpenAIModel,
  hasOpenAIApiKey,
  streamOpenAITextResponse,
  type OpenAITextMessage,
} from "./openai/responses";
import {
  resolveResponseLanguage,
  type ResponseLanguageCode,
} from "./response-language";
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
      instructions: buildDirectChatInstructions(message, context),
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

function buildDirectChatInstructions(
  message: string,
  context: DirectChatContextMessage[]
) {
  const language = resolveResponseLanguage(message, context);

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

export function buildLocalFallback(
  message: string,
  context: DirectChatContextMessage[]
) {
  const language = resolveResponseLanguage(message, context);
  const copy = directFallbackCopy[language.code];
  const previousUser = [...context]
    .reverse()
    .find((item) => item.role === "user" && item.content !== message);

  if (isGreeting(message)) {
    return copy.greeting;
  }

  if (/konteks|context|sebelumnya|tadi/i.test(message) && previousUser) {
    return copy.context(previousUser.content);
  }

  return copy.unavailable;
}

type DirectFallbackCopy = {
  context: (previous: string) => string;
  greeting: string;
  unavailable: string;
};

const directFallbackCopy: Record<ResponseLanguageCode, DirectFallbackCopy> = {
  ar: {
    context: (previous) => `آخر سياق في هذه الجلسة هو: "${previous}".`,
    greeting: "مرحبًا. كيف يمكنني مساعدتك؟",
    unavailable: "لا يمكنني الاتصال بنموذج الدردشة الآن. حاول مرة أخرى بعد قليل.",
  },
  de: {
    context: (previous) => `Der letzte Kontext dieser Sitzung ist: „${previous}“.`,
    greeting: "Hallo. Wie kann ich helfen?",
    unavailable: "Ich kann das Chatmodell gerade nicht erreichen. Bitte versuche es gleich noch einmal.",
  },
  el: {
    context: (previous) => `Το τελευταίο πλαίσιο αυτής της συνεδρίας είναι: «${previous}».`,
    greeting: "Γεια. Πώς μπορώ να βοηθήσω;",
    unavailable: "Δεν μπορώ να συνδεθώ με το μοντέλο συνομιλίας τώρα. Δοκίμασε ξανά σε λίγο.",
  },
  en: {
    context: (previous) => `The last context from this session is: "${previous}".`,
    greeting: "Hi. How can I help?",
    unavailable: "I cannot reach the chat model right now. Try again shortly.",
  },
  es: {
    context: (previous) => `El último contexto de esta sesión es: "${previous}".`,
    greeting: "Hola. ¿Cómo puedo ayudarte?",
    unavailable: "No puedo conectarme al modelo de chat ahora. Inténtalo de nuevo en unos momentos.",
  },
  fr: {
    context: (previous) => `Le dernier contexte de cette session est : « ${previous} ».`,
    greeting: "Bonjour. Comment puis-je vous aider ?",
    unavailable: "Je ne peux pas joindre le modèle de chat pour le moment. Réessayez dans un instant.",
  },
  he: {
    context: (previous) => `ההקשר האחרון בשיחה הזו הוא: "${previous}".`,
    greeting: "שלום. איך אפשר לעזור?",
    unavailable: "אין לי אפשרות להתחבר כרגע למודל הצ'אט. נסה שוב בעוד רגע.",
  },
  hi: {
    context: (previous) => `इस सत्र का पिछला संदर्भ है: "${previous}"।`,
    greeting: "नमस्ते। मैं कैसे मदद कर सकता हूँ?",
    unavailable: "मैं अभी चैट मॉडल से संपर्क नहीं कर पा रहा हूँ। थोड़ी देर बाद फिर कोशिश करें।",
  },
  id: {
    context: (previous) => `Konteks terakhir dari sesi ini adalah: "${previous}".`,
    greeting: "Hai. Ada yang bisa aku bantu?",
    unavailable: "Aku belum bisa menghubungi model chat sekarang. Coba lagi sebentar.",
  },
  it: {
    context: (previous) => `L'ultimo contesto di questa sessione è: "${previous}".`,
    greeting: "Ciao. Come posso aiutarti?",
    unavailable: "Non riesco a contattare il modello di chat in questo momento. Riprova tra poco.",
  },
  ja: {
    context: (previous) => `このセッションの直前の文脈は「${previous}」です。`,
    greeting: "こんにちは。どのようにお手伝いできますか？",
    unavailable: "現在チャットモデルに接続できません。しばらくしてからもう一度お試しください。",
  },
  ko: {
    context: (previous) => `이 세션의 이전 맥락은 "${previous}"입니다.`,
    greeting: "안녕하세요. 무엇을 도와드릴까요?",
    unavailable: "현재 채팅 모델에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.",
  },
  nl: {
    context: (previous) => `De laatste context uit deze sessie is: "${previous}".`,
    greeting: "Hallo. Hoe kan ik helpen?",
    unavailable: "Ik kan het chatmodel momenteel niet bereiken. Probeer het zo opnieuw.",
  },
  pt: {
    context: (previous) => `O último contexto desta sessão é: "${previous}".`,
    greeting: "Olá. Como posso ajudar?",
    unavailable: "Não consigo acessar o modelo de chat agora. Tente novamente em instantes.",
  },
  ru: {
    context: (previous) => `Последний контекст этой сессии: «${previous}».`,
    greeting: "Здравствуйте. Чем я могу помочь?",
    unavailable: "Сейчас не удается подключиться к модели чата. Повторите попытку чуть позже.",
  },
  th: {
    context: (previous) => `บริบทล่าสุดของเซสชันนี้คือ: "${previous}"`,
    greeting: "สวัสดี มีอะไรให้ช่วยไหม?",
    unavailable: "ขณะนี้ไม่สามารถเชื่อมต่อโมเดลแชตได้ โปรดลองอีกครั้งในอีกสักครู่",
  },
  tr: {
    context: (previous) => `Bu oturumdaki son bağlam: "${previous}".`,
    greeting: "Merhaba. Nasıl yardımcı olabilirim?",
    unavailable: "Şu anda sohbet modeline erişemiyorum. Kısa süre sonra tekrar deneyin.",
  },
  vi: {
    context: (previous) => `Ngữ cảnh gần nhất của phiên này là: "${previous}".`,
    greeting: "Xin chào. Tôi có thể giúp gì?",
    unavailable: "Hiện tôi không thể kết nối với mô hình trò chuyện. Hãy thử lại sau ít phút.",
  },
  zh: {
    context: (previous) => `本次会话的上一段上下文是：“${previous}”。`,
    greeting: "你好。有什么可以帮你？",
    unavailable: "目前无法连接聊天模型，请稍后再试。",
  },
};

function isGreeting(message: string) {
  return /^(hai|halo|hello|hi|hay|hey|pagi|siang|malam|hola|bonjour|salut|hallo|guten tag|olá|ola|oi|ciao|merhaba|xin chào|مرحبا|أهلا|שלום|नमस्ते|こんにちは|안녕하세요|สวัสดี|你好|您好|γεια|привет|здравствуйте)\b/iu.test(
    message.trim()
  );
}

function readPositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? "", 10);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
