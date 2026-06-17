import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { StepExecution } from "./types";

const execFileAsync = promisify(execFile);

type ExecError = Error & {
  stdout?: string;
  stderr?: string;
};

type OpenClawAgentPayload = {
  text?: unknown;
};

export type OpenClawAgentResponse = {
  payloads?: OpenClawAgentPayload[];
  meta?: {
    agentMeta?: {
      provider?: unknown;
      model?: unknown;
    };
    executionTrace?: {
      winnerProvider?: unknown;
      winnerModel?: unknown;
    };
    finalAssistantVisibleText?: unknown;
    finalAssistantRawText?: unknown;
    transport?: unknown;
    fallbackFrom?: unknown;
  };
};

export type OpenClawStepMeta = {
  execution: StepExecution;
  model?: string;
  sessionId?: string;
  transport?: string;
  fallbackFrom?: string;
  error?: string;
};

type RunOpenClawAgentJsonInput = {
  prompt: string;
  sessionId: string;
  cliPath?: string;
  model?: string;
  thinking?: string;
  timeoutSeconds?: number;
};

export type OpenClawAgentJsonResult = {
  payload?: Record<string, unknown>;
  text: string;
  meta: OpenClawStepMeta;
};

export async function runOpenClawAgentJson({
  prompt,
  sessionId,
  cliPath = process.env.OPENCLAW_CLI_PATH || "openclaw",
  model = process.env.OPENCLAW_MODEL?.trim(),
  thinking = process.env.OPENCLAW_AGENT_THINKING || "low",
  timeoutSeconds = readPositiveInt(process.env.OPENCLAW_STEP_TIMEOUT_SECONDS, 60),
}: RunOpenClawAgentJsonInput): Promise<OpenClawAgentJsonResult> {
  const args = [
    "agent",
    "--json",
    "--session-id",
    sessionId,
    "--thinking",
    thinking,
    "--timeout",
    String(timeoutSeconds),
    "--message",
    prompt,
  ];

  if (model) {
    args.splice(2, 0, "--model", model);
  }

  try {
    const result = await execFileAsync(cliPath, args, {
      timeout: timeoutSeconds * 1000 + 15000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const agentJson = parseOpenClawAgentResponse(result.stdout, result.stderr);
    const text = extractAnswerText(agentJson);
    const parsed = parseLooseJson(text);
    const payload = isRecord(parsed) ? parsed : undefined;

    if (!payload) {
      throw new Error("OpenClaw agent did not return a valid JSON object.");
    }

    return {
      payload,
      text,
      meta: {
        execution: "openclaw-agent",
        model: extractModel(agentJson) || model || undefined,
        sessionId,
        transport: readString(agentJson.meta?.transport),
        fallbackFrom: readString(agentJson.meta?.fallbackFrom),
      },
    };
  } catch (error) {
    const execError = error as ExecError;
    const detail = sanitizeError(
      [
        compactExecMessage(execError.message),
        compactProcessOutput(execError.stdout),
        compactProcessOutput(execError.stderr),
      ]
        .filter(Boolean)
        .join(" ")
    );

    return {
      text: "",
      meta: {
        execution: "deterministic-fallback",
        model: model || undefined,
        sessionId,
        error: detail || "OpenClaw agent step failed.",
      },
    };
  }
}

function compactExecMessage(message: string) {
  if (!message.startsWith("Command failed:")) {
    return message;
  }

  return message.replace(/ --message [\s\S]+$/, " --message [omitted]");
}

export function parseOpenClawAgentResponse(stdout: string, stderr: string) {
  const parsed =
    parseLooseJson(stdout) ??
    parseLooseJson(stderr) ??
    parseLooseJson(`${stdout}\n${stderr}`);

  if (!isRecord(parsed)) {
    throw new Error("OpenClaw agent did not return parseable JSON output.");
  }

  return parsed as OpenClawAgentResponse;
}

export function extractAnswerText(agentJson: OpenClawAgentResponse) {
  const payloadText = agentJson.payloads
    ?.map((payload) => readString(payload.text))
    .find(Boolean);

  return (
    payloadText ||
    readString(agentJson.meta?.finalAssistantVisibleText) ||
    readString(agentJson.meta?.finalAssistantRawText) ||
    ""
  );
}

export function parseLooseJson(value: string): unknown {
  const cleaned = stripMarkdownFence(value.trim());

  if (!cleaned) {
    return undefined;
  }

  try {
    return JSON.parse(cleaned);
  } catch {
    // OpenClaw may print gateway status lines before the final JSON payload.
  }

  const starts: number[] = [];
  const matcher = /(^|\n)\s*\{/g;
  let match = matcher.exec(cleaned);

  while (match) {
    starts.push(match.index + match[0].lastIndexOf("{"));
    match = matcher.exec(cleaned);
  }

  for (let index = starts.length - 1; index >= 0; index -= 1) {
    const candidate = cleaned.slice(starts[index]).trim();

    try {
      return JSON.parse(candidate);
    } catch {
      // Keep trying earlier JSON object starts.
    }
  }

  return undefined;
}

export function extractModel(agentJson: OpenClawAgentResponse) {
  const provider =
    readString(agentJson.meta?.agentMeta?.provider) ||
    readString(agentJson.meta?.executionTrace?.winnerProvider);
  const model =
    readString(agentJson.meta?.agentMeta?.model) ||
    readString(agentJson.meta?.executionTrace?.winnerModel);

  if (!provider && !model) {
    return undefined;
  }

  return provider && model ? `${provider}/${model}` : provider || model;
}

export function readPositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? "", 10);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function readString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function compactProcessOutput(value: string | undefined) {
  return value ? value.replace(/\s+/g, " ").trim().slice(0, 700) : "";
}

export function sanitizeError(value: string) {
  return value
    .replace(/ghp_[A-Za-z0-9_]+/g, "[redacted]")
    .replace(/tvly-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, "sk-[redacted]")
    .replace(/app-sk-[A-Za-z0-9_-]{20,}/g, "app-sk-[redacted]")
    .replace(/0x[a-fA-F0-9]{64}/g, "0x[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9%._-]+/gi, "Bearer [redacted]")
    .replace(/AAAAAAAA[A-Za-z0-9%._-]{20,}/g, "[redacted]")
    .replace(/BSA[A-Za-z0-9_-]{20,}/g, "[redacted]")
    .slice(0, 800);
}

function stripMarkdownFence(value: string) {
  return value
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}
