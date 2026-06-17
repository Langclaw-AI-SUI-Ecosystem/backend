import type {
  AlphaSignal,
  AlphaSignalNotification,
  ResearchReport,
  ResearchReportEntity,
  ResearchReportTable,
  ZeroGProof,
} from "../langclaw/types";
import { isAlphaAlertsEnabled } from "../langclaw/alpha-quality";
import type {
  OnChainToolFinalPayload,
  OnChainToolResult,
} from "../onchain-tools/types";
import type {
  AutomationNotificationChannel,
  AutomationRunStatus,
  AutomationSettings,
  AutomationTriggeredBy,
} from "./types";

type NotificationInput = {
  completedAt?: string;
  durationMs?: number;
  error?: string;
  project: string;
  runId: string;
  status: AutomationRunStatus;
  taskName: string;
  triggeredBy: AutomationTriggeredBy;
};

type SendNotificationInput = NotificationInput & {
  settings: AutomationSettings;
};

type AlphaSignalNotificationInput = {
  alphaSignal: AlphaSignal;
  completedAt?: string;
  onChain?: OnChainToolFinalPayload;
  project: string;
  proof?: ZeroGProof;
  report?: ResearchReport;
  runId: string;
  settings: AutomationSettings;
  taskName: string;
};

type NotificationMessage = {
  subject: string;
  text: string;
};

type SendEmailInput = {
  requireConfigured?: boolean;
  subject: string;
  text: string;
  to?: string;
};

const telegramApiBase = "https://api.telegram.org";
const resendApiUrl = "https://api.resend.com/emails";
const maxProviderErrorLength = 500;

export async function sendAutomationRunNotification({
  settings,
  ...input
}: SendNotificationInput) {
  if (!shouldNotifyRun(input.status, settings)) {
    return;
  }

  const message = buildAutomationNotificationMessage(input);
  const channels = resolveNotificationChannels(settings);
  const results = await Promise.allSettled(
    channels.map((channel) => sendChannelNotification(channel, settings, message))
  );
  const failures = results.filter((result) => result.status === "rejected");

  if (failures.length === results.length && results.length > 0) {
    throw new Error("All automation notification channels failed.");
  }
}

export async function sendAlphaSignalNotification({
  alphaSignal,
  completedAt,
  onChain,
  project,
  proof,
  report,
  runId,
  settings,
  taskName,
}: AlphaSignalNotificationInput): Promise<AlphaSignalNotification> {
  if (!isAlphaAlertsEnabled()) {
    return {
      channel: "none",
      reason: "LANGCLAW_ALPHA_ALERTS_ENABLED is not true.",
      status: "disabled",
    };
  }

  if (!alphaSignal.alertEligible) {
    return {
      channel: "none",
      reason: alphaSignal.quality.reasons[0] || "Alpha signal is not alert eligible.",
      status: "skipped",
    };
  }

  const target = readTelegramTarget(settings);

  if (!target.token || !target.chatId) {
    return {
      channel: "telegram",
      reason: "Telegram bot token or chat id is not configured.",
      status: "skipped",
    };
  }

  try {
    await postTelegramMessage(
      target,
      buildAlphaSignalNotificationMessage({
        alphaSignal,
        completedAt,
        onChain,
        project,
        proof,
        report,
        runId,
        taskName,
      })
    );

    return {
      channel: "telegram",
      sentAt: new Date().toISOString(),
      status: "sent",
    };
  } catch (error) {
    return {
      channel: "telegram",
      error: error instanceof Error ? error.message : "Telegram alpha alert failed.",
      status: "failed",
    };
  }
}

export function buildAutomationNotificationMessage({
  completedAt,
  durationMs,
  error,
  project,
  runId,
  status,
  taskName,
  triggeredBy,
}: NotificationInput): NotificationMessage {
  const readableStatus = formatStatus(status);
  const duration = durationMs === undefined ? "unknown" : formatDuration(durationMs);
  const lines = [
    `Task: ${taskName}`,
    `Project: ${project}`,
    `Status: ${readableStatus}`,
    `Triggered by: ${triggeredBy}`,
    `Run ID: ${runId}`,
    `Finished at: ${completedAt || new Date().toISOString()}`,
    `Duration: ${duration}`,
  ];

  if (error) {
    lines.push(`Reason: ${error}`);
  }

  return {
    subject: `Langclaw Sui alert ${readableStatus}: ${taskName}`,
    text: lines.join("\n"),
  };
}

export function buildAlphaSignalNotificationMessage({
  alphaSignal,
  completedAt,
  onChain,
  project,
  proof,
  report,
  runId,
  taskName,
}: Omit<AlphaSignalNotificationInput, "settings">): NotificationMessage {
  if (!report && !onChain) {
    return buildMinimalAlphaSignalNotificationMessage({
      alphaSignal,
      completedAt,
      project,
      proof,
      runId,
      taskName,
    });
  }

  const summary = buildAlphaAlertSummary({
    alphaSignal,
    onChain,
    proof,
    report,
  });
  const lines = [
    `Signal: ${summary.signal}`,
    `Target: ${summary.target}`,
    `Confidence: ${alphaSignal.quality.label}, ${alphaSignal.quality.score}/100`,
    `Why now: ${summary.whyNow}`,
    `Evidence: ${alphaSignal.quality.evidenceCount} items, ${alphaSignal.quality.sourceCoverage.providerCount} providers, ${summary.coverage}`,
    `Warnings: ${summary.warnings}`,
    `Proof: ${summary.proof}`,
    ...(summary.tx ? [`TX: ${summary.tx}`] : []),
    `Action: ${summary.action}`,
    `Run: ${runId}`,
  ];

  return {
    subject: `Langclaw Alpha Alert: ${summary.title}`,
    text: lines.join("\n"),
  };
}

function buildMinimalAlphaSignalNotificationMessage({
  alphaSignal,
  completedAt,
  project,
  proof,
  runId,
  taskName,
}: Omit<AlphaSignalNotificationInput, "settings" | "onChain" | "report">): NotificationMessage {
  const passedChecks = alphaSignal.quality.falsePositiveChecks.filter(
    (check) => check.status === "pass"
  ).length;
  const warnedChecks = alphaSignal.quality.falsePositiveChecks.filter(
    (check) => check.status === "warn"
  ).length;
  const failedChecks = alphaSignal.quality.falsePositiveChecks.filter(
    (check) => check.status === "fail"
  ).length;
  const proofStatus = proof?.chain.status ?? "unknown";
  const lines = [
    `Task: ${taskName}`,
    `Project: ${project}`,
    `Signal: ${alphaSignal.signalType}`,
    `Confidence: ${alphaSignal.quality.label}`,
    `Quality score: ${alphaSignal.quality.score}/100`,
    `Evidence: ${alphaSignal.quality.evidenceCount} item(s)`,
    `False positive checks: ${passedChecks} pass, ${warnedChecks} warn, ${failedChecks} fail`,
    `Proof: ${proofStatus}`,
    `Run ID: ${runId}`,
    `Finished at: ${completedAt || new Date().toISOString()}`,
  ];

  if (alphaSignal.quality.reasons.length) {
    lines.push(`Reason: ${alphaSignal.quality.reasons[0]}`);
  }

  return {
    subject: `Langclaw Alpha Alert: ${alphaSignal.signalType}`,
    text: lines.join("\n"),
  };
}

function buildAlphaAlertSummary({
  alphaSignal,
  onChain,
  proof,
  report,
}: {
  alphaSignal: AlphaSignal;
  onChain?: OnChainToolFinalPayload;
  proof?: ZeroGProof;
  report?: ResearchReport;
}) {
  const chain = readProofChainName(proof);

  return {
    action:
      compactLine(report?.recommendations[0], 160) ||
      "Review candidate wallets before escalation.",
    coverage: summarizeCoverage(alphaSignal),
    proof: summarizeProof(proof),
    signal: summarizeSignal(alphaSignal),
    target: summarizeTarget(report),
    title: `${humanizeSignalType(alphaSignal.signalType)} on ${chain}`,
    tx: readProofTx(proof),
    warnings: summarizeWarnings(alphaSignal),
    whyNow: summarizeWhyNow(onChain, report),
  };
}

function summarizeSignal(alphaSignal: AlphaSignal) {
  if (
    alphaSignal.signalType === "smart-money" &&
    alphaSignal.quality.sourceCoverage.directWalletFlow
  ) {
    return "Wallet-flow accumulation";
  }

  return humanizeSignalType(alphaSignal.signalType);
}

function summarizeTarget(report?: ResearchReport) {
  const entity = report?.entities[0];

  if (entity) {
    return summarizeEntityTarget(entity);
  }

  const row = report?.tables
    .find((table) => table.id === "smart-money-table")
    ?.rows[0];

  if (row) {
    return summarizeTableTarget(row);
  }

  return "Alpha candidate";
}

function summarizeEntityTarget(entity: ResearchReportEntity) {
  const parts = [
    entity.label,
    readMetric(entity.metrics, ["token", "tokenSymbol", "symbol"]),
    readMetric(entity.metrics, ["signal", "status", "category"]),
  ]
    .filter(Boolean)
    .map(String);

  return compactLine(unique(parts).join(", "), 140) || entity.label;
}

function summarizeTableTarget(row: Record<string, string | number | null>) {
  const parts = [
    readRowValue(row, ["Wallet", "wallet"]),
    readRowValue(row, ["Token", "token"]),
    readRowValue(row, ["Signal", "signal"]),
  ]
    .filter(Boolean)
    .map(String);

  return compactLine(unique(parts).join(", "), 140) || "Alpha candidate";
}

function summarizeWhyNow(
  onChain?: OnChainToolFinalPayload,
  report?: ResearchReport
) {
  const tool = onChain?.tools.find(isUsableSmartMoneyTool) ??
    onChain?.tools.find((candidate) => candidate.status === "success");

  if (tool) {
    return compactLine(
      `${providerLabel(tool.provider)} returned usable ${tool.domain === "smart_money" ? "wallet-flow" : "on-chain"} evidence.`,
      160
    );
  }

  return (
    compactLine(report?.bottomLine || report?.executiveSummary, 160) ||
    "The alpha quality gate passed with current evidence."
  );
}

function summarizeCoverage(alphaSignal: AlphaSignal) {
  const coverage = alphaSignal.quality.sourceCoverage;
  const parts = [
    coverage.directWalletFlow ? "direct wallet-flow" : undefined,
    coverage.onchain ? "on-chain" : undefined,
    coverage.social ? "social context" : undefined,
    coverage.proof ? "proof-ready" : undefined,
  ].filter(Boolean);

  return parts.join(", ") || "limited coverage";
}

function summarizeWarnings(alphaSignal: AlphaSignal) {
  const warnings = alphaSignal.quality.falsePositiveChecks.filter(
    (check) => check.status === "warn"
  );

  if (!warnings.length) {
    return "0";
  }

  return `${warnings.length}, ${joinReadableList(
    warnings.map((warning) => warningLabel(warning.id, warning.label))
  )}`;
}

function summarizeProof(proof?: ZeroGProof) {
  const status = proof?.chain.status ?? "unknown";
  const decision = proof?.chain.decisionId ? `, decision ${proof.chain.decisionId}` : "";

  return `${status}${decision}`;
}

function readProofTx(proof?: ZeroGProof) {
  return proof?.chain.explorerUrl || proof?.chain.txHash;
}

function readProofChainName(proof?: ZeroGProof) {
  if (proof?.chain.chainName) {
    return proof.chain.chainName;
  }

  if (proof?.chain.chain) {
    return titleCase(proof.chain.chain);
  }

  return "Sui";
}

function isUsableSmartMoneyTool(tool: OnChainToolResult) {
  return tool.status === "success" && tool.domain === "smart_money";
}

function readMetric(
  metrics: ResearchReportEntity["metrics"],
  keys: string[]
) {
  for (const key of keys) {
    const value = metrics[key];

    if (value !== null && value !== undefined && String(value).trim()) {
      return value;
    }
  }

  return undefined;
}

function readRowValue(
  row: ResearchReportTable["rows"][number],
  keys: string[]
) {
  for (const key of keys) {
    const value = row[key];

    if (value !== null && value !== undefined && String(value).trim()) {
      return value;
    }
  }

  return undefined;
}

function warningLabel(id: string, label: string) {
  if (id === "provider_gap_guard") {
    return "provider gap";
  }

  if (id === "external_low_confidence_guard") {
    return "supplemental external context";
  }

  return label.toLowerCase();
}

function humanizeSignalType(value: string) {
  return titleCase(value.replace(/[-_]+/g, " "));
}

function providerLabel(value: string) {
  return value === "dune" ? "Dune" : value === "surf" ? "Surf" : titleCase(value);
}

function titleCase(value: string) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function compactLine(value: string | undefined, maxLength: number) {
  const normalized = value?.replace(/\s+/g, " ").trim();

  if (!normalized) {
    return undefined;
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function joinReadableList(values: string[]) {
  if (values.length <= 1) {
    return values[0] ?? "";
  }

  if (values.length === 2) {
    return `${values[0]} and ${values[1]}`;
  }

  return `${values.slice(0, -1).join(", ")}, and ${values[values.length - 1]}`;
}

function unique(values: string[]) {
  return Array.from(new Set(values));
}

export function resolveNotificationChannels(
  settings: AutomationSettings
): AutomationNotificationChannel[] {
  if (settings.failureNotification === "none") {
    return [];
  }

  const channels = new Set(settings.notificationChannels);

  if (!channels.size) {
    channels.add(settings.failureNotification);
  }

  channels.delete("in-app");

  return Array.from(channels);
}

function shouldNotifyRun(
  status: AutomationRunStatus,
  settings: AutomationSettings
) {
  if (settings.failureNotification === "none") {
    return false;
  }

  return status === "failed" || status === "skipped";
}

async function sendChannelNotification(
  channel: AutomationNotificationChannel,
  settings: AutomationSettings,
  message: NotificationMessage
) {
  if (channel === "telegram") {
    await sendTelegramNotification(settings, message);
    return;
  }

  if (channel === "email") {
    await sendEmailNotification(settings, message);
  }
}

async function sendTelegramNotification(
  settings: AutomationSettings,
  message: NotificationMessage
) {
  const target = readTelegramTarget(settings);

  if (!target.token || !target.chatId) {
    return;
  }

  await postTelegramMessage(target, message);
}

function readTelegramTarget(settings: AutomationSettings) {
  return {
    chatId:
      settings.telegramVerified && settings.telegramChatId?.trim()
        ? settings.telegramChatId.trim()
        : process.env.LANGCLAW_AUTOMATION_TELEGRAM_CHAT_ID?.trim(),
    token: process.env.LANGCLAW_TELEGRAM_BOT_TOKEN?.trim(),
  };
}

async function postTelegramMessage(
  target: { chatId?: string; token?: string },
  message: NotificationMessage
) {
  const response = await fetch(
    `${telegramApiBase}/bot${target.token}/sendMessage`,
    {
      body: JSON.stringify({
        chat_id: target.chatId,
        disable_web_page_preview: true,
        text: `${message.subject}\n\n${message.text}`,
      }),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    }
  );

  if (!response.ok) {
    throw new Error(`Telegram notification failed with ${response.status}.`);
  }
}

async function sendEmailNotification(
  settings: AutomationSettings,
  message: NotificationMessage
) {
  const to =
    settings.notificationEmailVerified && settings.notificationEmail?.trim()
      ? settings.notificationEmail.trim()
      : undefined;

  await sendAutomationEmail({
    subject: message.subject,
    text: message.text,
    to,
  });
}

export async function sendAutomationEmail({
  requireConfigured = false,
  subject,
  text,
  to,
}: SendEmailInput) {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = readAutomationEmailSender();

  if (!apiKey || !from || !to) {
    if (requireConfigured) {
      throw new Error(buildEmailConfigError(Boolean(apiKey), Boolean(from), Boolean(to)));
    }

    return;
  }

  const response = await fetch(resendApiUrl, {
    body: JSON.stringify({
      from,
      subject,
      text,
      to,
    }),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(await buildEmailProviderError(response));
  }
}

function readAutomationEmailSender() {
  return (
    process.env.LANGCLAW_AUTOMATION_EMAIL_FROM?.trim() ||
    process.env.RESEND_EMAIL_FROM?.trim() ||
    process.env.RESEND_FROM_EMAIL?.trim()
  );
}

function buildEmailConfigError(
  hasApiKey: boolean,
  hasFrom: boolean,
  hasTo: boolean
) {
  if (!hasApiKey) {
    return "RESEND_API_KEY is not configured.";
  }

  if (!hasFrom) {
    return "LANGCLAW_AUTOMATION_EMAIL_FROM must be set to a verified Resend sender.";
  }

  if (!hasTo) {
    return "A verified notification email is required.";
  }

  return "Resend email sender is not configured.";
}

async function buildEmailProviderError(response: Response) {
  const detail = await readProviderErrorDetail(response);
  const hint =
    response.status === 401 || response.status === 403
      ? " Check RESEND_API_KEY and make sure LANGCLAW_AUTOMATION_EMAIL_FROM uses a verified Resend domain or sender."
      : "";

  return `Email notification failed with ${response.status}${
    detail ? `: ${detail}` : ""
  }.${hint}`;
}

async function readProviderErrorDetail(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";
  const raw = await response.text().catch(() => "");
  const trimmed = raw.trim();

  if (!trimmed) {
    return "";
  }

  if (contentType.includes("application/json")) {
    try {
      const payload = JSON.parse(trimmed) as Record<string, unknown>;
      const message = payload.message ?? payload.error ?? payload.name;

      if (typeof message === "string" && message.trim()) {
        return message.trim().slice(0, maxProviderErrorLength);
      }
    } catch {
      return trimmed.slice(0, maxProviderErrorLength);
    }
  }

  return trimmed.slice(0, maxProviderErrorLength);
}

function formatStatus(status: AutomationRunStatus) {
  return status
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatDuration(durationMs: number) {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }

  if (durationMs < 60000) {
    return `${Math.round(durationMs / 1000)}s`;
  }

  return `${Math.round(durationMs / 60000)}m`;
}
