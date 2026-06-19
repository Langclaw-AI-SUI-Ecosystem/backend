export type ResponseLanguageConfidence = "high" | "medium" | "low";

export type ResponseLanguageCode =
  | "ar"
  | "de"
  | "el"
  | "en"
  | "es"
  | "fr"
  | "he"
  | "hi"
  | "id"
  | "it"
  | "ja"
  | "ko"
  | "nl"
  | "pt"
  | "ru"
  | "th"
  | "tr"
  | "vi"
  | "zh";

export type ResponseLanguageHint = {
  code: ResponseLanguageCode;
  confidence: ResponseLanguageConfidence;
  instruction: string;
  label: string;
};

export type ResponseLanguageContextMessage = {
  role: "assistant" | "user";
  content: string;
};

type LanguageProfile = {
  code: ResponseLanguageCode;
  label: string;
  markers: RegExp[];
};

const scriptProfiles: Array<{
  code: ResponseLanguageCode;
  label: string;
  pattern: RegExp;
}> = [
  {
    code: "ja",
    label: "Japanese",
    pattern: /[\p{Script=Hiragana}\p{Script=Katakana}]/u,
  },
  { code: "ko", label: "Korean", pattern: /\p{Script=Hangul}/u },
  {
    code: "ar",
    label: "the user's Arabic-script language",
    pattern: /\p{Script=Arabic}/u,
  },
  {
    code: "hi",
    label: "the user's Devanagari-script language",
    pattern: /\p{Script=Devanagari}/u,
  },
  { code: "th", label: "Thai", pattern: /\p{Script=Thai}/u },
  {
    code: "ru",
    label: "the user's Cyrillic-script language",
    pattern: /\p{Script=Cyrillic}/u,
  },
  { code: "el", label: "Greek", pattern: /\p{Script=Greek}/u },
  { code: "he", label: "Hebrew", pattern: /\p{Script=Hebrew}/u },
  {
    code: "zh",
    label: "the user's Han-script language",
    pattern: /\p{Script=Han}/u,
  },
];

const languageProfiles: LanguageProfile[] = [
  {
    code: "id",
    label: "Indonesian",
    markers: [
      /\b(aku|saya|gue|gw|kamu|lu|lo|tolong|bisa|gak|ga|nggak|tidak|kenapa|bagaimana|seharusnya|dong|nih|sih|kok|udah|belum|makasih|terima kasih|halo|hai|lanjut|lanjutkan|yang|kedua|pertama|ini|itu)\b/iu,
    ],
  },
  {
    code: "en",
    label: "English",
    markers: [
      /\b(find|what|why|how|please|thanks|hello|hi|show|explain|fix|make|return|should|could|would|continue|second|first|this|that)\b/iu,
    ],
  },
  {
    code: "es",
    label: "Spanish",
    markers: [
      /\b(hola|gracias|por qué|porque|puedes|ayuda|buscar|encuentra|muéstrame|qué|cómo|dónde|continúa|segundo)\b/iu,
    ],
  },
  {
    code: "fr",
    label: "French",
    markers: [
      /\b(bonjour|merci|pourquoi|comment|peux-tu|pouvez-vous|chercher|trouve|montre|où|quand|continue)\b/iu,
    ],
  },
  {
    code: "de",
    label: "German",
    markers: [
      /\b(hallo|danke|warum|wie|kannst|bitte|suche|finden|zeige|wo|wann|nicht|weiter)\b/iu,
    ],
  },
  {
    code: "pt",
    label: "Portuguese",
    markers: [
      /\b(olá|oi|obrigado|obrigada|por que|porque|você|pode|procure|encontre|mostre|não|como|continue)\b/iu,
    ],
  },
  {
    code: "it",
    label: "Italian",
    markers: [
      /\b(ciao|grazie|perché|come|puoi|cerca|trova|mostra|dove|quando|non|continua)\b/iu,
    ],
  },
  {
    code: "nl",
    label: "Dutch",
    markers: [
      /\b(hallo|bedankt|waarom|hoe|kun je|kunt u|zoek|vind|toon|waar|wanneer|niet|verder)\b/iu,
    ],
  },
  {
    code: "tr",
    label: "Turkish",
    markers: [
      /\b(merhaba|teşekkür|neden|nasıl|lütfen|bul|ara|göster|nerede|ne zaman|değil|devam)\b/iu,
    ],
  },
  {
    code: "vi",
    label: "Vietnamese",
    markers: [
      /\b(xin chào|cảm ơn|tại sao|như thế nào|không|hãy|tìm|cho tôi|ở đâu|khi nào|tiếp tục)\b/iu,
    ],
  },
];

const explicitLanguageProfiles: LanguageProfile[] = [
  {
    code: "ar",
    label: "the user's Arabic-script language",
    markers: [/\b(?:باللغة العربية|بالعربية)\b/u],
  },
  {
    code: "de",
    label: "German",
    markers: [/\bauf deutsch\b/iu],
  },
  {
    code: "el",
    label: "Greek",
    markers: [/\bστα ελληνικά\b/iu],
  },
  {
    code: "en",
    label: "English",
    markers: [
      /\b(?:reply|respond|answer|write)\s+(?:to me\s+)?(?:in\s+)?english\b/iu,
      /\b(?:jawab|balas|tulis).{0,24}\bbahasa inggris\b/iu,
    ],
  },
  {
    code: "es",
    label: "Spanish",
    markers: [/\ben español\b/iu],
  },
  {
    code: "fr",
    label: "French",
    markers: [/\ben français\b/iu],
  },
  {
    code: "he",
    label: "Hebrew",
    markers: [/\bבעברית\b/u],
  },
  {
    code: "hi",
    label: "the user's Devanagari-script language",
    markers: [/\bहिंदी में\b/u],
  },
  {
    code: "id",
    label: "Indonesian",
    markers: [
      /\b(?:reply|respond|answer|write)\s+(?:to me\s+)?(?:in\s+)?indonesian\b/iu,
      /\b(?:jawab|balas|tulis).{0,24}\bbahasa indonesia\b/iu,
      /\bdalam bahasa indonesia\b/iu,
    ],
  },
  {
    code: "it",
    label: "Italian",
    markers: [/\bin italiano\b/iu],
  },
  {
    code: "ja",
    label: "Japanese",
    markers: [/日本語で/u],
  },
  {
    code: "ko",
    label: "Korean",
    markers: [/한국어로/u],
  },
  {
    code: "nl",
    label: "Dutch",
    markers: [/\bin het nederlands\b/iu],
  },
  {
    code: "pt",
    label: "Portuguese",
    markers: [/\bem português\b/iu],
  },
  {
    code: "ru",
    label: "the user's Cyrillic-script language",
    markers: [/\bна русском\b/iu],
  },
  {
    code: "th",
    label: "Thai",
    markers: [/ภาษาไทย/u],
  },
  {
    code: "tr",
    label: "Turkish",
    markers: [/\btürkçe\b/iu],
  },
  {
    code: "vi",
    label: "Vietnamese",
    markers: [/\bbằng tiếng việt\b/iu],
  },
  {
    code: "zh",
    label: "the user's Han-script language",
    markers: [/(?:用中文|以中文)/u],
  },
  ...languageProfiles
    .filter((profile) => !["en", "id"].includes(profile.code))
    .map((profile) => ({
      ...profile,
      markers: [
        new RegExp(
          `\\b(?:reply|respond|answer|write)\\s+(?:to me\\s+)?(?:in\\s+)?${profile.label.toLowerCase()}\\b`,
          "iu"
        ),
      ],
    })),
];

export function detectResponseLanguage(text: string): ResponseLanguageHint {
  const trimmed = text.trim();
  const explicit = scoreProfiles(trimmed, explicitLanguageProfiles)[0];

  if (explicit) {
    return buildHint(explicit.label, "high", explicit.code);
  }

  for (const profile of scriptProfiles) {
    if (profile.pattern.test(trimmed)) {
      return buildHint(profile.label, "high", profile.code);
    }
  }

  const scores = scoreProfiles(trimmed, languageProfiles);
  const indonesianScore =
    scores.find((item) => item.label === "Indonesian")?.score ?? 0;

  if (indonesianScore > 0) {
    return buildHint(
      "Indonesian",
      indonesianScore >= 2 ? "high" : "medium",
      "id"
    );
  }

  const top = scores[0];

  if (top) {
    return buildHint(
      top.label,
      top.score >= 2 ? "high" : "medium",
      top.code
    );
  }

  return buildHint("the user's language", "low", "en");
}

export function resolveResponseLanguage(
  text: string,
  context: ResponseLanguageContextMessage[] = []
): ResponseLanguageHint {
  const latest = detectResponseLanguage(text);

  if (latest.confidence !== "low") {
    return latest;
  }

  const previousUserMessages = [...context]
    .reverse()
    .filter(
      (item) =>
        item.role === "user" &&
        item.content.trim() &&
        item.content.trim() !== text.trim()
    );

  for (const item of previousUserMessages) {
    const inherited = detectResponseLanguage(item.content);

    if (inherited.confidence !== "low") {
      return buildHint(inherited.label, "medium", inherited.code);
    }
  }

  return latest;
}

function scoreProfiles(text: string, profiles: LanguageProfile[]) {
  return profiles
    .map((profile) => ({
      code: profile.code,
      label: profile.label,
      score: profile.markers.reduce(
        (total, marker) => total + countMatches(text, marker),
        0
      ),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
}

function buildHint(
  label: string,
  confidence: ResponseLanguageConfidence,
  code: ResponseLanguageCode
): ResponseLanguageHint {
  const languageTarget =
    label === "the user's language"
      ? "the same language used by the latest user message"
      : label;

  return {
    code,
    confidence,
    label,
    instruction: [
      `Write all user-visible prose in ${languageTarget}.`,
      "If the latest user message mixes languages, use the dominant user language.",
      "If Indonesian markers appear, prefer Indonesian.",
      "Keep proper nouns, token symbols, chain names, provider names, URLs, code, and quoted source text unchanged.",
    ].join(" "),
  };
}

function countMatches(text: string, pattern: RegExp) {
  const globalPattern = new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`
  );

  return Array.from(text.matchAll(globalPattern)).length;
}
