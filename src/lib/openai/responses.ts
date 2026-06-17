export type OpenAITextMessage = {
  role: "assistant" | "developer" | "system" | "user";
  content: string;
};

export type OpenAITokenUsage = {
  cachedInputTokens?: number;
  completionTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  promptTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
};

export type OpenAITextResult = {
  id?: string;
  incomplete?: boolean;
  model: string;
  text: string;
  usage?: OpenAITokenUsage;
};

export type OpenAITextFormat =
  | {
      type: "json_object";
    }
  | {
      type: "json_schema";
      name: string;
      strict?: boolean;
      schema: Record<string, unknown>;
    };

type OpenAIRequestInput = {
  input: OpenAITextMessage[] | string;
  instructions?: string;
  maxOutputTokens?: number;
  model?: string;
  signal?: AbortSignal;
  temperature?: number;
  textFormat?: OpenAITextFormat;
};

type OpenAIStreamInput = OpenAIRequestInput & {
  onDelta?: (delta: string) => void;
};

const defaultOpenAIBaseUrl = "https://api.openai.com/v1";
const defaultChatModel = "gpt-5.2";
const defaultAgentModel = "gpt-5.2";

export function getOpenAIBaseUrl() {
  return trimTrailingSlash(
    process.env.OPENAI_BASE_URL?.trim() || defaultOpenAIBaseUrl
  );
}

export function getDefaultOpenAIModel(kind: "agent" | "chat" = "chat") {
  if (kind === "agent") {
    return process.env.OPENAI_AGENT_MODEL?.trim() || defaultAgentModel;
  }

  return process.env.OPENAI_CHAT_MODEL?.trim() || defaultChatModel;
}

export function hasOpenAIApiKey() {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

export async function createOpenAITextResponse({
  input,
  instructions,
  maxOutputTokens,
  model = getDefaultOpenAIModel("chat"),
  signal,
  temperature,
  textFormat,
}: OpenAIRequestInput): Promise<OpenAITextResult> {
  const payload = await openAIJson<Record<string, unknown>>("/responses", {
    body: {
      input,
      instructions,
      max_output_tokens: maxOutputTokens,
      model,
      temperature,
      text: textFormat ? { format: textFormat } : undefined,
    },
    signal,
  });
  const status = readString(payload.status);

  if (status === "failed") {
    throw new Error(readOpenAIResponseError(payload) || "OpenAI response failed.");
  }

  const text = extractOpenAIText(payload);
  const incomplete = status === "incomplete";

  if (incomplete && !text.trim()) {
    throw new Error(
      "OpenAI synthesis response was incomplete with no output text. Increase OPENAI_AGENT_MAX_OUTPUT_TOKENS or shorten the research payload."
    );
  }

  return {
    id: readString(payload.id),
    incomplete,
    model: readString(payload.model) || model,
    text,
    usage: readOpenAIUsage(payload.usage),
  };
}

export async function streamOpenAITextResponse({
  input,
  instructions,
  maxOutputTokens,
  model = getDefaultOpenAIModel("chat"),
  onDelta,
  signal,
  temperature,
}: OpenAIStreamInput): Promise<OpenAITextResult> {
  const response = await openAIFetch("/responses", {
    body: {
      input,
      instructions,
      max_output_tokens: maxOutputTokens,
      model,
      stream: true,
      temperature,
    },
    signal,
  });

  if (!response.body) {
    throw new Error("OpenAI streaming response was empty.");
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";
  let text = "";
  let id: string | undefined;
  let usedModel = model;
  let usage: OpenAITokenUsage | undefined;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split(/\n\n/);
    buffer = events.pop() ?? "";

    for (const event of events) {
      const parsed = parseSseData(event);

      if (!parsed) {
        continue;
      }

      if (parsed.type === "response.output_text.delta") {
        const delta = readRawString(parsed.delta);

        if (delta) {
          text += delta;
          onDelta?.(delta);
        }
      } else if (parsed.type === "response.output_text.done") {
        const doneText = readRawString(parsed.text);

        if (doneText && !text) {
          text = doneText;
        }
      } else if (
        parsed.type === "response.completed" ||
        parsed.type === "response.done"
      ) {
        const completed = readRecord(parsed.response);
        id = readString(completed?.id) || id;
        usedModel = readString(completed?.model) || usedModel;
        usage = readOpenAIUsage(completed?.usage) || usage;

        if (!text && completed) {
          text = extractOpenAIText(completed);
        }
      } else if (parsed.type === "response.failed" || parsed.type === "error") {
        throw new Error(readOpenAIError(parsed) || "OpenAI response failed.");
      }
    }
  }

  if (buffer.trim()) {
    const parsed = parseSseData(buffer);

    if (parsed?.type === "response.output_text.delta") {
      const delta = readRawString(parsed.delta);

      if (delta) {
        text += delta;
        onDelta?.(delta);
      }
    }
  }

  return {
    id,
    model: usedModel,
    text,
    usage,
  };
}

export function extractOpenAIText(payload: Record<string, unknown>) {
  const outputText = readString(payload.output_text);

  if (outputText) {
    return outputText;
  }

  const output = Array.isArray(payload.output) ? payload.output : [];
  const parts: string[] = [];

  for (const item of output) {
    const record = readRecord(item);
    const content = Array.isArray(record?.content) ? record.content : [];

    for (const contentItem of content) {
      const contentRecord = readRecord(contentItem);
      const text = readString(contentRecord?.text);

      if (text) {
        parts.push(text);
      }
    }
  }

  return parts.join("\n").trim();
}

export function readOpenAIUsage(value: unknown): OpenAITokenUsage | undefined {
  const usage = readRecord(value);

  if (!usage) {
    return undefined;
  }

  const inputDetails = readRecord(usage.input_tokens_details);
  const outputDetails = readRecord(usage.output_tokens_details);
  const result: OpenAITokenUsage = {
    cachedInputTokens: readNumber(inputDetails?.cached_tokens),
    completionTokens: readNumber(usage.output_tokens),
    inputTokens: readNumber(usage.input_tokens),
    outputTokens: readNumber(usage.output_tokens),
    promptTokens: readNumber(usage.input_tokens),
    reasoningTokens: readNumber(outputDetails?.reasoning_tokens),
    totalTokens: readNumber(usage.total_tokens),
  };

  return Object.values(result).some((item) => item !== undefined)
    ? result
    : undefined;
}

async function openAIJson<T>(
  path: string,
  options: { body: Record<string, unknown>; signal?: AbortSignal }
) {
  const response = await openAIFetch(path, options);

  return (await response.json()) as T;
}

async function openAIFetch(
  path: string,
  options: { body: Record<string, unknown>; signal?: AbortSignal }
) {
  const apiKey = process.env.OPENAI_API_KEY?.trim();

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is empty.");
  }

  const timeoutSeconds = readPositiveInt(
    process.env.OPENAI_TIMEOUT_SECONDS,
    90
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  const onAbort = () => controller.abort();

  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const response = await fetch(`${getOpenAIBaseUrl()}${path}`, {
      body: JSON.stringify(removeUndefined(options.body)),
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(await readOpenAIHttpError(response));
    }

    return response;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

function parseSseData(event: string) {
  const data = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n")
    .trim();

  if (!data || data === "[DONE]") {
    return null;
  }

  try {
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function readOpenAIHttpError(response: Response) {
  const payload = (await response.json().catch(() => null)) as {
    error?: { message?: unknown };
  } | null;

  return (
    readString(payload?.error?.message) ||
    `OpenAI request failed with status ${response.status}.`
  );
}

function readOpenAIError(value: Record<string, unknown>) {
  const error = readRecord(value.error);

  return readString(error?.message) || readString(value.message);
}

function readOpenAIResponseError(payload: Record<string, unknown>) {
  const error = readRecord(payload.error);

  return readOpenAIError(error ?? payload);
}

function readRecord(value: unknown) {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function readRawString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : undefined;
}

function readPositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? "", 10);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function removeUndefined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  );
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}
