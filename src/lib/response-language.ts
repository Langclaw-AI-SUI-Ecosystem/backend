export type ResponseLanguageConfidence = "high" | "medium" | "low";

export type ResponseLanguageHint = {
  confidence: ResponseLanguageConfidence;
  instruction: string;
  label: string;
};

type LanguageProfile = {
  label: string;
  markers: RegExp[];
};

const scriptProfiles: Array<{ label: string; pattern: RegExp }> = [
  { label: "Japanese", pattern: /[\p{Script=Hiragana}\p{Script=Katakana}]/u },
  { label: "Korean", pattern: /\p{Script=Hangul}/u },
  { label: "the user's Arabic-script language", pattern: /\p{Script=Arabic}/u },
  {
    label: "the user's Devanagari-script language",
    pattern: /\p{Script=Devanagari}/u,
  },
  { label: "Thai", pattern: /\p{Script=Thai}/u },
  { label: "the user's Cyrillic-script language", pattern: /\p{Script=Cyrillic}/u },
  { label: "Greek", pattern: /\p{Script=Greek}/u },
  { label: "Hebrew", pattern: /\p{Script=Hebrew}/u },
  { label: "the user's Han-script language", pattern: /\p{Script=Han}/u },
];

const languageProfiles: LanguageProfile[] = [
  {
    label: "Indonesian",
    markers: [
      /\b(aku|saya|gue|gw|kamu|lu|lo|tolong|bisa|gak|ga|nggak|tidak|kenapa|bagaimana|seharusnya|dong|nih|sih|kok|udah|belum|makasih|terima kasih|halo|hai)\b/iu,
    ],
  },
  {
    label: "English",
    markers: [
      /\b(find|what|why|how|please|thanks|hello|hi|show|explain|fix|make|return|should|could|would)\b/iu,
    ],
  },
  {
    label: "Spanish",
    markers: [
      /\b(hola|gracias|por qué|porque|puedes|ayuda|buscar|encuentra|muéstrame|qué|cómo|dónde)\b/iu,
    ],
  },
  {
    label: "French",
    markers: [
      /\b(bonjour|merci|pourquoi|comment|peux-tu|pouvez-vous|chercher|trouve|montre|où|quand)\b/iu,
    ],
  },
  {
    label: "German",
    markers: [
      /\b(hallo|danke|warum|wie|kannst|bitte|suche|finden|zeige|wo|wann|nicht)\b/iu,
    ],
  },
  {
    label: "Portuguese",
    markers: [
      /\b(olá|oi|obrigado|obrigada|por que|porque|você|pode|procure|encontre|mostre|não|como)\b/iu,
    ],
  },
  {
    label: "Italian",
    markers: [
      /\b(ciao|grazie|perché|come|puoi|cerca|trova|mostra|dove|quando|non)\b/iu,
    ],
  },
  {
    label: "Dutch",
    markers: [
      /\b(hallo|bedankt|waarom|hoe|kun je|kunt u|zoek|vind|toon|waar|wanneer|niet)\b/iu,
    ],
  },
  {
    label: "Turkish",
    markers: [
      /\b(merhaba|teşekkür|neden|nasıl|lütfen|bul|ara|göster|nerede|ne zaman|değil)\b/iu,
    ],
  },
  {
    label: "Vietnamese",
    markers: [
      /\b(xin chào|cảm ơn|tại sao|như thế nào|không|hãy|tìm|cho tôi|ở đâu|khi nào)\b/iu,
    ],
  },
];

export function detectResponseLanguage(text: string): ResponseLanguageHint {
  const trimmed = text.trim();

  for (const profile of scriptProfiles) {
    if (profile.pattern.test(trimmed)) {
      return buildHint(profile.label, "high");
    }
  }

  const scores = languageProfiles
    .map((profile) => ({
      label: profile.label,
      score: profile.markers.reduce(
        (total, marker) => total + countMatches(trimmed, marker),
        0
      ),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  const indonesianScore =
    scores.find((item) => item.label === "Indonesian")?.score ?? 0;

  if (indonesianScore > 0) {
    return buildHint(
      "Indonesian",
      indonesianScore >= 2 ? "high" : "medium"
    );
  }

  const top = scores[0];

  if (top) {
    return buildHint(top.label, top.score >= 2 ? "high" : "medium");
  }

  return buildHint("the user's language", "low");
}

function buildHint(
  label: string,
  confidence: ResponseLanguageConfidence
): ResponseLanguageHint {
  const languageTarget =
    label === "the user's language"
      ? "the same language used by the latest user message"
      : label;

  return {
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
