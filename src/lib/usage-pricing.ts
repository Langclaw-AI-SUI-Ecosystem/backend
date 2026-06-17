import type {
  ModelUsageReceipt,
  ZeroGComputeStatus,
  ZeroGTokenUsage,
} from "./langclaw/types";

export type ProviderUsageTrace = {
  billing?: {
    totalCostNeuron?: string;
  };
  provider?: string;
  requestId?: string;
  teeVerified?: boolean | null;
};

type UsageMeterItemKey =
  | "cached_input"
  | "deep_thinking"
  | "output"
  | "text_output"
  | "uncached_input";

export type UsageMeterItem = {
  color: string;
  key: UsageMeterItemKey;
  label: string;
  tokens: number;
};

export type UsageMeter = {
  badge: {
    modelLabel: string;
    totalConsumeLabel: string;
    totalConsumeNeuron: string;
  };
  consumeDetails: {
    cachedInputTokens: number;
    items: UsageMeterItem[];
    title: "Token Cost";
    totalTokens: number;
    unit: "token";
  };
  model: string;
  modelLabel: string;
  outputDetails: {
    items: UsageMeterItem[];
    title: "Output Details";
    totalTokens: number;
    unit: "token";
  };
  tokenCost: number;
  totalConsumeLabel: string;
  totalConsumeNeuron: string;
  unit: "token";
};

export type UsageCostSelection = {
  chargedRawNeuron: string;
  costSource: ModelUsageReceipt["costSource"];
  status: ModelUsageReceipt["status"];
};

export function calculateTokenCostNeuron({
  completionPriceNeuron,
  completionTokens,
  promptPriceNeuron,
  promptTokens,
}: {
  completionPriceNeuron: string;
  completionTokens: number;
  promptPriceNeuron: string;
  promptTokens: number;
}) {
  return (
    BigInt(promptPriceNeuron) * BigInt(Math.max(0, promptTokens)) +
    BigInt(completionPriceNeuron) * BigInt(Math.max(0, completionTokens))
  ).toString();
}

export function selectUsageCost({
  completionPriceNeuron,
  computeStatus,
  providerTrace,
  promptPriceNeuron,
  reservedNeuron,
  routerTrace,
  tokenUsage,
}: {
  completionPriceNeuron: string;
  computeStatus?: ZeroGComputeStatus;
  providerTrace?: ProviderUsageTrace;
  promptPriceNeuron: string;
  reservedNeuron: string;
  routerTrace?: ProviderUsageTrace;
  tokenUsage?: ZeroGTokenUsage;
}): UsageCostSelection {
  const trace = providerTrace ?? routerTrace;
  const traceTotalCost = readDecimalString(trace?.billing?.totalCostNeuron);
  const promptTokens = tokenUsage?.promptTokens ?? tokenUsage?.inputTokens ?? 0;
  const completionTokens =
    tokenUsage?.completionTokens ?? tokenUsage?.outputTokens ?? 0;
  const hasTraceCost = computeStatus === "used" && traceTotalCost !== "0";
  const hasActualUsage =
    computeStatus === "used" && (promptTokens > 0 || completionTokens > 0);

  if (hasTraceCost) {
    return {
      chargedRawNeuron: traceTotalCost,
      costSource: "router-trace",
      status: "charged",
    };
  }

  if (hasActualUsage) {
    return {
      chargedRawNeuron: calculateTokenCostNeuron({
        completionPriceNeuron,
        completionTokens,
        promptPriceNeuron,
        promptTokens,
      }),
      costSource: "token-estimate",
      status: "charged",
    };
  }

  if (computeStatus === "used") {
    return {
      chargedRawNeuron: reservedNeuron,
      costSource: "reserved-estimate",
      status: "estimated",
    };
  }

  return {
    chargedRawNeuron: "0",
    costSource: "reserved-estimate",
    status: "refunded",
  };
}

export function readUsageMarkupBps(value = process.env.LANGCLAW_USAGE_MARKUP_BPS) {
  const parsed = Number.parseInt(value ?? "3000", 10);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return 3000;
  }

  return Math.min(parsed, 100_000);
}

export function calculateMarkupNeuron(rawCostNeuron: string, markupBps: number) {
  const raw = BigInt(readDecimalString(rawCostNeuron));

  if (raw === 0n || markupBps <= 0) {
    return "0";
  }

  return ((raw * BigInt(markupBps)) / 10_000n).toString();
}

export function applyMarkupNeuron(rawCostNeuron: string, markupBps: number) {
  const raw = BigInt(readDecimalString(rawCostNeuron));
  const markup = BigInt(calculateMarkupNeuron(rawCostNeuron, markupBps));

  return (raw + markup).toString();
}

export function buildUsageMeter({
  model,
  tokenUsage,
  totalConsumeNeuron,
}: {
  model: string;
  tokenUsage?: ZeroGTokenUsage;
  totalConsumeNeuron?: string;
}): UsageMeter {
  const inputTokens = readTokenCount(
    tokenUsage?.inputTokens ?? tokenUsage?.promptTokens
  );
  const outputTokens = readTokenCount(
    tokenUsage?.outputTokens ?? tokenUsage?.completionTokens
  );
  const cachedInputTokens = Math.min(
    readTokenCount(tokenUsage?.cachedInputTokens),
    inputTokens
  );
  const reasoningTokens = Math.min(
    readTokenCount(tokenUsage?.reasoningTokens),
    outputTokens
  );
  const uncachedInputTokens = Math.max(inputTokens - cachedInputTokens, 0);
  const textOutputTokens = Math.max(outputTokens - reasoningTokens, 0);
  const tokenCost = uncachedInputTokens + outputTokens;
  const consumeNeuron = readDecimalString(totalConsumeNeuron);
  const modelLabel = formatUsageModelLabel(model);

  const consumeItems: UsageMeterItem[] = [
    {
      color: "#d9dadd",
      key: "uncached_input",
      label: "Uncached Input",
      tokens: uncachedInputTokens,
    },
  ];

  consumeItems.push({
    color: "#2cc6a5",
    key: "output",
    label: "Output",
    tokens: outputTokens,
  });

  return {
    badge: {
      modelLabel,
      totalConsumeLabel: consumeNeuron,
      totalConsumeNeuron: consumeNeuron,
    },
    consumeDetails: {
      cachedInputTokens,
      items: consumeItems,
      title: "Token Cost",
      totalTokens: tokenCost,
      unit: "token",
    },
    model,
    modelLabel,
    outputDetails: {
      items: [
        {
          color: "#e63ba7",
          key: "deep_thinking",
          label: "Deep Thinking",
          tokens: reasoningTokens,
        },
        {
          color: "#2cc6a5",
          key: "text_output",
          label: "Text Output",
          tokens: textOutputTokens,
        },
      ],
      title: "Output Details",
      totalTokens: outputTokens,
      unit: "token",
    },
    tokenCost,
    totalConsumeLabel: consumeNeuron,
    totalConsumeNeuron: consumeNeuron,
    unit: "token",
  };
}

export function formatUsageModelLabel(model: string) {
  const trimmed = model.trim();
  const base = trimmed.split("/").filter(Boolean).pop() || trimmed;
  const gptMatch = base.match(/^gpt[-_\s]*(.+)$/i);

  if (gptMatch?.[1]) {
    return `GPT-${gptMatch[1].replace(/[-_]+/g, " ")}`;
  }

  return base
    .replace(/[-_]+/g, " ")
    .trim();
}

export function mapUiTokenUsage(tokenUsage?: ZeroGTokenUsage) {
  if (!tokenUsage) {
    return {};
  }

  return {
    inputTokens: tokenUsage.inputTokens ?? tokenUsage.promptTokens,
    outputTokens: tokenUsage.outputTokens ?? tokenUsage.completionTokens,
    reasoningTokens: tokenUsage.reasoningTokens,
    cachedInputTokens: tokenUsage.cachedInputTokens,
    maxTokens: tokenUsage.maxTokens,
    promptTokens: tokenUsage.promptTokens,
    completionTokens: tokenUsage.completionTokens,
    totalTokens: tokenUsage.totalTokens,
  };
}

function readDecimalString(value: unknown) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(Math.trunc(value)) : "0";
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "string" && /^\d+$/.test(value)) {
    return value;
  }

  return "0";
}

function readTokenCount(value: unknown) {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
  }

  if (typeof value === "bigint") {
    return value > 0n ? Number(value) : 0;
  }

  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number.parseInt(value, 10);
  }

  return 0;
}
