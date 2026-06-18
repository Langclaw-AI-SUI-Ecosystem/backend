import { createHash, randomBytes, randomInt } from "node:crypto";

import {
  AccountAuthError,
  requireAccountAuth,
  requireSupabaseAdmin,
  type AccountAuthInput,
  type AuthenticatedAccount,
} from "../server/account-auth";
import type { Database, Json } from "../supabase/database.types";
import { writeAutomationRunMemory } from "../memory";
import {
  readAlphaSignalFromPayload,
  withAlphaSignalNotification,
} from "../langclaw/alpha-quality";
import { runPrivateMemoryWorkflow } from "../memory-workflow";
import type { ResearchReport, ZeroGProof } from "../langclaw/types";
import type { OnChainToolFinalPayload } from "../onchain-tools/types";
import {
  buildDeveloperModeUsageReceipt,
  refundResearchUsage,
  reserveResearchUsage,
  settleResearchUsage,
  type UsageReservation,
} from "../usage";
import { buildTriggerLabel, computeNextRunAt, getZonedParts } from "./schedule";
import {
  buildAlphaSignalNotificationMessage,
  buildAutomationNotificationMessage,
  sendAutomationEmail,
  sendAlphaSignalNotification,
  sendAutomationRunNotification,
} from "./notifications";
import type {
  AutomationDashboard,
  AutomationFrequency,
  AutomationInAppNotification,
  AutomationRun,
  AutomationRunStatus,
  AutomationSettings,
  AutomationSettingsInput,
  AutomationStats,
  AutomationTask,
  AutomationTaskInput,
  AutomationTaskStatus,
  AutomationTriggeredBy,
  AutomationTriggerType,
} from "./types";

type AutomationSettingsRow =
  Database["public"]["Tables"]["langclaw_automation_settings"]["Row"];
type AutomationTaskRow =
  Database["public"]["Tables"]["langclaw_automation_tasks"]["Row"];
type AutomationRunRow =
  Database["public"]["Tables"]["langclaw_automation_runs"]["Row"];
type AutomationNotificationRow =
  Database["public"]["Tables"]["langclaw_automation_notifications"]["Row"];
type AutomationContext = AuthenticatedAccount;

type GuardrailDecision =
  | {
      allowed: true;
      note?: string;
    }
  | {
      allowed: false;
      pauseTask: boolean;
      reason: string;
    };

type TelegramLinkCandidate = {
  chatId: string;
  code: string;
  username?: string;
};

const defaultTimezone = "Asia/Jakarta";
const neuronPer0G = 1_000_000_000_000_000_000n;
const defaultTelegramBotUsername = "langclawaibot";

export class AutomationHttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function automationErrorResponse(error: unknown) {
  if (error instanceof AutomationHttpError) {
    return Response.json({ error: error.message }, { status: error.status });
  }

  return Response.json(
    {
      error:
        error instanceof Error ? error.message : "Automation request failed.",
    },
    { status: 500 }
  );
}

export async function readAutomationDashboard(
  authInput: AccountAuthInput
): Promise<AutomationDashboard> {
  const context = await requireAutomationContext(authInput);
  const [settings, tasks, recentRuns, stats, notifications] = await Promise.all([
    readAutomationSettingsForContext(context),
    readAutomationTasksForContext(context),
    readAutomationRunsForContext(context),
    readAutomationStats(context),
    readInAppAutomationNotificationsForContext(context),
  ]);

  return {
    configured: true,
    notifications,
    recentRuns,
    settings,
    stats,
    tasks,
  };
}

export async function createAutomationTask(
  authInput: AccountAuthInput,
  input: AutomationTaskInput
) {
  const context = await requireAutomationContext(authInput);
  const settings = await readAutomationSettingsForContext(context);
  requireTelegramLinkedSettings(settings);
  const task = normalizeTaskInput(input, {
    requireName: true,
    settings,
  });
  const now = new Date();
  const status = task.status ?? "draft";
  const nextRunAt =
    status === "active" && task.triggerType === "schedule"
      ? computeNextRunAt({
          frequency: task.scheduleFrequency ?? "daily",
          from: now,
          scheduleMonthDay: task.scheduleMonthDay,
          scheduleTime: task.scheduleTime,
          scheduleWeekday: task.scheduleWeekday,
          timezone: task.timezone,
        })
      : null;
  const webhookSlug =
    task.triggerType === "webhook" ? createWebhookSlug(task.name!) : null;

  const { data, error } = await context.supabase
    .from("langclaw_automation_tasks")
    .insert({
      event_name: task.eventName,
      failure_threshold: task.failureThreshold,
      max_retries: task.maxRetries,
      metadata: {},
      model: task.model,
      name: task.name!,
      next_run_at: nextRunAt,
      project: task.project,
      prompt: task.prompt,
      schedule_frequency: task.scheduleFrequency,
      schedule_month_day: task.scheduleMonthDay,
      schedule_time: task.scheduleTime,
      schedule_weekday: task.scheduleWeekday,
      status,
      timezone: task.timezone,
      trigger_type: task.triggerType,
      wallet_user_id: context.walletUser.id,
      webhook_slug: webhookSlug,
    })
    .select("*")
    .single();

  if (error || !data) {
    throw new AutomationHttpError(
      500,
      error?.message || "Unable to create automation task."
    );
  }

  return rowToTask(data as AutomationTaskRow);
}

export async function updateAutomationTask(
  authInput: AccountAuthInput,
  taskId: unknown,
  input: AutomationTaskInput
) {
  const context = await requireAutomationContext(authInput);
  const existing = await readAutomationTaskRow(context, readTaskId(taskId));
  const settings = await readAutomationSettingsForContext(context);
  const patch = normalizeTaskInput(input, {
    existing,
    requireName: false,
    settings,
  });
  const status = patch.status ?? existing.status;

  if (status === "active") {
    requireTelegramLinkedSettings(settings);
  }

  const triggerType = patch.triggerType ?? existing.trigger_type;
  const scheduleFrequency =
    patch.scheduleFrequency ?? existing.schedule_frequency ?? "daily";
  const scheduleTime = patch.scheduleTime ?? existing.schedule_time;
  const scheduleWeekday =
    patch.scheduleWeekday ?? existing.schedule_weekday ?? undefined;
  const scheduleMonthDay =
    patch.scheduleMonthDay ?? existing.schedule_month_day ?? undefined;
  const timezone = patch.timezone ?? existing.timezone;
  const shouldRecomputeNextRun =
    status === "active" &&
    triggerType === "schedule" &&
    ("status" in patch ||
      "triggerType" in patch ||
      "scheduleFrequency" in patch ||
      "scheduleTime" in patch ||
      "scheduleWeekday" in patch ||
      "scheduleMonthDay" in patch ||
      "timezone" in patch);

  const nextRunAt = shouldRecomputeNextRun
    ? computeNextRunAt({
        frequency: scheduleFrequency,
        scheduleMonthDay,
        scheduleTime,
        scheduleWeekday,
        timezone,
      })
    : status === "paused" || status === "draft"
      ? null
      : existing.next_run_at;
  const webhookSlug =
    triggerType === "webhook"
      ? existing.webhook_slug ?? createWebhookSlug(patch.name ?? existing.name)
      : null;

  const { data, error } = await context.supabase
    .from("langclaw_automation_tasks")
    .update({
      event_name: patch.eventName ?? existing.event_name,
      failure_threshold: patch.failureThreshold ?? existing.failure_threshold,
      max_retries: patch.maxRetries ?? existing.max_retries,
      model: patch.model ?? existing.model,
      name: patch.name ?? existing.name,
      next_run_at: nextRunAt,
      project: patch.project ?? existing.project,
      prompt: patch.prompt ?? existing.prompt,
      schedule_frequency:
        triggerType === "schedule" ? scheduleFrequency : null,
      schedule_month_day:
        triggerType === "schedule" ? scheduleMonthDay ?? null : null,
      schedule_time: scheduleTime,
      schedule_weekday:
        triggerType === "schedule" ? scheduleWeekday ?? null : null,
      status,
      timezone,
      trigger_type: triggerType,
      webhook_slug: webhookSlug,
    })
    .eq("id", existing.id)
    .eq("wallet_user_id", context.walletUser.id)
    .select("*")
    .single();

  if (error || !data) {
    throw new AutomationHttpError(
      500,
      error?.message || "Unable to update automation task."
    );
  }

  return rowToTask(data as AutomationTaskRow);
}

export async function deleteAutomationTask(
  authInput: AccountAuthInput,
  taskId: unknown
) {
  const context = await requireAutomationContext(authInput);
  const id = readTaskId(taskId);
  const { error } = await context.supabase
    .from("langclaw_automation_tasks")
    .update({ status: "archived", next_run_at: null })
    .eq("id", id)
    .eq("wallet_user_id", context.walletUser.id);

  if (error) {
    throw new AutomationHttpError(500, error.message);
  }

  return { deleted: true };
}

export async function setAllAutomationStatus(
  authInput: AccountAuthInput,
  status: Extract<AutomationTaskStatus, "active" | "paused">
) {
  const context = await requireAutomationContext(authInput);

  if (status === "active") {
    requireTelegramLinkedSettings(await readAutomationSettingsForContext(context));
  }

  const tasks = await readAutomationTaskRows(context);
  const updates = await Promise.all(
    tasks
      .filter((task) => task.status !== "archived")
      .map((task) =>
        updateTaskStatus(context, task, status).catch((error) => {
          throw new AutomationHttpError(
            500,
            error instanceof Error ? error.message : "Unable to update task."
          );
        })
      )
  );

  return updates.map((row) => rowToTask(row));
}

export async function readAutomationSettings(authInput: AccountAuthInput) {
  const context = await requireAutomationContext(authInput);

  return readAutomationSettingsForContext(context);
}

export async function updateAutomationSettings(
  authInput: AccountAuthInput,
  input: AutomationSettingsInput
) {
  const context = await requireAutomationContext(authInput);
  const settings = normalizeSettingsInput(input);
  const { data, error } = await context.supabase
    .from("langclaw_automation_settings")
    .upsert(
      {
        auto_pause_repeated_failures: settings.autoPauseRepeatedFailures,
        daily_limit_neuron: parse0GToNeuron(settings.dailyLimit0G),
        developer_mode_enabled: settings.developerModeEnabled,
        failure_notification: settings.failureNotification,
        limit_behavior: settings.limitBehavior,
        low_balance_threshold_neuron: parse0GToNeuron(
          settings.lowBalanceThreshold0G
        ),
        monthly_cap_neuron: parse0GToNeuron(settings.monthlyCap0G),
        notification_channels: settings.notificationChannels,
        retry_policy: settings.retryPolicy,
        threshold_action: settings.thresholdAction,
        wallet_user_id: context.walletUser.id,
        write_run_logs_to_memory: settings.writeRunLogsToMemory,
      },
      { onConflict: "wallet_user_id" }
    )
    .select("*")
    .single();

  if (error || !data) {
    throw new AutomationHttpError(
      500,
      error?.message || "Unable to update automation settings."
    );
  }

  return rowToSettings(data as AutomationSettingsRow);
}

export async function readAutomationRuns(
  authInput: AccountAuthInput,
  taskId?: unknown
) {
  const context = await requireAutomationContext(authInput);

  return readAutomationRunsForContext(
    context,
    typeof taskId === "string" && taskId ? taskId : undefined
  );
}

export async function readInAppAutomationNotifications(
  authInput: AccountAuthInput,
  limitInput?: unknown
) {
  const context = await requireAutomationContext(authInput);

  return readInAppAutomationNotificationsForContext(
    context,
    readLimit(limitInput, 20, 50)
  );
}

export async function markInAppAutomationNotificationRead(
  authInput: AccountAuthInput,
  notificationId: unknown
) {
  const context = await requireAutomationContext(authInput);
  const id = readNotificationId(notificationId);
  const readAt = new Date().toISOString();
  const { data, error } = await context.supabase
    .from("langclaw_automation_notifications")
    .update({
      read_at: readAt,
      status: "read",
    })
    .eq("id", id)
    .eq("wallet_user_id", context.walletUser.id)
    .select("*")
    .maybeSingle();

  if (error) {
    throw new AutomationHttpError(500, error.message);
  }

  if (!data) {
    throw new AutomationHttpError(
      404,
      "Automation notification was not found."
    );
  }

  return rowToInAppNotification(data as AutomationNotificationRow);
}

export async function markAllInAppAutomationNotificationsRead(
  authInput: AccountAuthInput
) {
  const context = await requireAutomationContext(authInput);
  const readAt = new Date().toISOString();
  const { error } = await context.supabase
    .from("langclaw_automation_notifications")
    .update({
      read_at: readAt,
      status: "read",
    })
    .eq("wallet_user_id", context.walletUser.id)
    .eq("status", "unread");

  if (error) {
    throw new AutomationHttpError(500, error.message);
  }

  return { read: true };
}

export async function requestNotificationEmailLink(
  authInput: AccountAuthInput,
  emailInput: unknown
) {
  const context = await requireAutomationContext(authInput);
  const email = readEmail(emailInput);
  const code = String(randomInt(100000, 1000000));
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  await sendAutomationEmail({
    requireConfigured: true,
    subject: "Verify your Langclaw automation email",
    text: [
      "Use this code to link your email to Langclaw automation alerts.",
      "",
      code,
      "",
      "This code expires in 15 minutes.",
    ].join("\n"),
    to: email,
  });

  const { error } = await context.supabase
    .from("langclaw_automation_settings")
    .upsert(
      {
        notification_email_code_hash: hashLinkCode(code),
        notification_email_expires_at: expiresAt,
        notification_email_pending: email,
        wallet_user_id: context.walletUser.id,
      },
      { onConflict: "wallet_user_id" }
    );

  if (error) {
    throw new AutomationHttpError(500, error.message);
  }

  return {
    email: maskEmail(email),
    expiresAt,
    sent: true,
  };
}

export async function verifyNotificationEmailLink(
  authInput: AccountAuthInput,
  codeInput: unknown
) {
  const context = await requireAutomationContext(authInput);
  const code = readLinkCode(codeInput);
  const settings = await readAutomationSettingsRow(context);
  const email = settings.notification_email_pending;

  if (
    !email ||
    !settings.notification_email_code_hash ||
    !settings.notification_email_expires_at
  ) {
    throw new AutomationHttpError(400, "No email link request is pending.");
  }

  if (new Date(settings.notification_email_expires_at).getTime() < Date.now()) {
    throw new AutomationHttpError(400, "Email link code has expired.");
  }

  if (settings.notification_email_code_hash !== hashLinkCode(code)) {
    throw new AutomationHttpError(400, "Email link code is invalid.");
  }

  const { data, error } = await context.supabase
    .from("langclaw_automation_settings")
    .update({
      notification_channels: unionChannels(settings.notification_channels, "email"),
      notification_email: email,
      notification_email_code_hash: null,
      notification_email_expires_at: null,
      notification_email_linked_at: new Date().toISOString(),
      notification_email_pending: null,
      notification_email_verified: true,
    })
    .eq("wallet_user_id", context.walletUser.id)
    .select("*")
    .single();

  if (error || !data) {
    throw new AutomationHttpError(
      500,
      error?.message || "Unable to verify automation email."
    );
  }

  return rowToSettings(data as AutomationSettingsRow);
}

export async function unlinkNotificationEmail(authInput: AccountAuthInput) {
  const context = await requireAutomationContext(authInput);
  const settings = await readAutomationSettingsRow(context);
  const { data, error } = await context.supabase
    .from("langclaw_automation_settings")
    .update({
      failure_notification:
        settings.failure_notification === "email"
          ? "in-app"
          : settings.failure_notification,
      notification_channels: removeChannel(settings.notification_channels, "email"),
      notification_email: null,
      notification_email_code_hash: null,
      notification_email_expires_at: null,
      notification_email_linked_at: null,
      notification_email_pending: null,
      notification_email_verified: false,
    })
    .eq("wallet_user_id", context.walletUser.id)
    .select("*")
    .single();

  if (error || !data) {
    throw new AutomationHttpError(
      500,
      error?.message || "Unable to unlink automation email."
    );
  }

  return rowToSettings(data as AutomationSettingsRow);
}

export async function createTelegramLinkCode(authInput: AccountAuthInput) {
  const context = await requireAutomationContext(authInput);
  const code = randomBytes(5).toString("hex").toUpperCase();
  const botUsername = readTelegramBotUsername();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const { error } = await context.supabase
    .from("langclaw_automation_settings")
    .upsert(
      {
        telegram_link_code_hash: hashLinkCode(code),
        telegram_link_expires_at: expiresAt,
        wallet_user_id: context.walletUser.id,
      },
      { onConflict: "wallet_user_id" }
    );

  if (error) {
    throw new AutomationHttpError(500, error.message);
  }

  return {
    botUsername,
    code,
    command: `/link ${code}`,
    deepLink: `https://t.me/${botUsername}?start=${encodeURIComponent(code)}`,
    expiresAt,
  };
}

export async function unlinkTelegramLink(authInput: AccountAuthInput) {
  const context = await requireAutomationContext(authInput);
  const settings = await readAutomationSettingsRow(context);
  const { data, error } = await context.supabase
    .from("langclaw_automation_settings")
    .update({
      notification_channels: removeChannel(
        settings.notification_channels,
        "telegram"
      ),
      telegram_chat_id: null,
      telegram_link_code_hash: null,
      telegram_link_expires_at: null,
      telegram_linked_at: null,
      telegram_username: null,
      telegram_verified: false,
    })
    .eq("wallet_user_id", context.walletUser.id)
    .select("*")
    .single();

  if (error || !data) {
    throw new AutomationHttpError(
      500,
      error?.message || "Unable to unlink Telegram chat."
    );
  }

  return rowToSettings(data as AutomationSettingsRow);
}

export async function pollTelegramLink(authInput: AccountAuthInput) {
  const context = await requireAutomationContext(authInput);
  const settings = await readAutomationSettingsRow(context);

  if (!settings.telegram_link_code_hash || !settings.telegram_link_expires_at) {
    throw new AutomationHttpError(400, "No Telegram link code is pending.");
  }

  if (new Date(settings.telegram_link_expires_at).getTime() < Date.now()) {
    throw new AutomationHttpError(400, "Telegram link code has expired.");
  }

  const update = await findTelegramUpdateByCodeHash(
    settings.telegram_link_code_hash
  );

  if (!update) {
    return {
      linked: false,
      status: "pending",
    };
  }

  return {
    linked: true,
    settings: await linkTelegramChat(context.supabase, settings, update),
    status: "linked",
  };
}

export async function processTelegramWebhookUpdate(update: unknown) {
  let supabase: AutomationContext["supabase"];

  try {
    supabase = requireSupabaseAdmin();
  } catch (error) {
    if (error instanceof AccountAuthError) {
      throw new AutomationHttpError(error.status, error.message);
    }

    throw error;
  }

  const candidate = readTelegramUpdateCandidate(update);

  if (!candidate) {
    return {
      linked: false,
      status: "ignored",
    };
  }

  const codeHash = hashLinkCode(candidate.code);
  const { data, error } = await supabase
    .from("langclaw_automation_settings")
    .select("*")
    .eq("telegram_link_code_hash", codeHash)
    .maybeSingle();

  if (error) {
    throw new AutomationHttpError(500, error.message);
  }

  if (!data) {
    return {
      linked: false,
      status: "not_found",
    };
  }

  const settings = data as AutomationSettingsRow;

  if (
    !settings.telegram_link_expires_at ||
    new Date(settings.telegram_link_expires_at).getTime() < Date.now()
  ) {
    return {
      linked: false,
      status: "expired",
    };
  }

  return {
    linked: true,
    settings: await linkTelegramChat(supabase, settings, candidate),
    status: "linked",
  };
}

export async function runAutomationTask(
  authInput: AccountAuthInput,
  taskId: unknown,
  triggeredBy: AutomationTriggeredBy = "manual"
) {
  const context = await requireAutomationContext(authInput);
  const task = await readAutomationTaskRow(context, readTaskId(taskId));

  if (task.status === "archived") {
    throw new AutomationHttpError(404, "Automation task was not found.");
  }

  return runTaskRow(context, task, triggeredBy);
}

export async function runAutomationEvent(
  authInput: AccountAuthInput,
  eventNameInput: unknown,
  payload?: unknown,
  limitInput?: unknown
) {
  const context = await requireAutomationContext(authInput);
  const eventName = readEventName(eventNameInput);
  const limit = readLimit(limitInput, 10);
  const { data, error } = await context.supabase
    .from("langclaw_automation_tasks")
    .select("*")
    .eq("wallet_user_id", context.walletUser.id)
    .eq("status", "active")
    .eq("trigger_type", "event")
    .eq("event_name", eventName)
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw new AutomationHttpError(500, error.message);
  }

  const runs = [];

  for (const task of (data ?? []) as AutomationTaskRow[]) {
    runs.push(await runTaskRow(context, task, "event", payload));
  }

  return runs;
}

export async function runAutomationWebhook(slugInput: unknown, payload?: unknown) {
  const slug = readWebhookSlug(slugInput);
  const supabase = requireAutomationSupabaseAdmin();
  const { data, error } = await supabase
    .from("langclaw_automation_tasks")
    .select("*")
    .eq("webhook_slug", slug)
    .maybeSingle();

  if (error) {
    throw new AutomationHttpError(500, error.message);
  }

  if (!data) {
    throw new AutomationHttpError(404, "Automation webhook was not found.");
  }

  const task = data as AutomationTaskRow;

  if (task.status !== "active" || task.trigger_type !== "webhook") {
    throw new AutomationHttpError(409, "Automation webhook is not active.");
  }

  const context = await createAutomationContextForWalletUser(
    supabase,
    task.wallet_user_id
  );

  return runTaskRow(context, task, "webhook", payload);
}

export async function runDueAutomationTasks(
  authInput: AccountAuthInput,
  limitInput?: unknown
) {
  const context = await requireAutomationContext(authInput);
  const limit = readLimit(limitInput, 3);
  const now = new Date().toISOString();
  const { data, error } = await context.supabase
    .from("langclaw_automation_tasks")
    .select("*")
    .eq("wallet_user_id", context.walletUser.id)
    .eq("status", "active")
    .not("next_run_at", "is", null)
    .lte("next_run_at", now)
    .order("next_run_at", { ascending: true })
    .limit(limit);

  if (error) {
    throw new AutomationHttpError(500, error.message);
  }

  const runs = [];

  for (const task of (data ?? []) as AutomationTaskRow[]) {
    runs.push(await runTaskRow(context, task, "schedule"));
  }

  return runs;
}

async function runTaskRow(
  context: AutomationContext,
  task: AutomationTaskRow,
  triggeredBy: AutomationTriggeredBy,
  triggerPayload?: unknown
) {
  const startedAt = new Date();
  const run = await createRun(context, task, startedAt, triggeredBy);

  try {
    const guardrail = await readGuardrailDecision(context, task);

    if (!guardrail.allowed) {
      if (guardrail.pauseTask) {
        await updateTaskStatus(context, task, "paused");
      }

      return finishRun(context, task, run, {
        error: guardrail.reason,
        result: {
          guardrail: guardrail.reason,
        },
        status: "skipped",
      });
    }

    return runTaskWithRetries(context, task, run, triggerPayload);
  } catch (error) {
    return finishRun(context, task, run, {
      error:
        error instanceof Error ? error.message : "Automation run failed.",
      status: "failed",
    });
  }
}

async function runTaskWithRetries(
  context: AutomationContext,
  task: AutomationTaskRow,
  run: AutomationRunRow,
  triggerPayload?: unknown
) {
  const maxAttempts = readMaxAttempts(task.max_retries);
  const prompt = buildTaskPrompt(task, triggerPayload);
  const attemptErrors: string[] = [];
  const settings = await readAutomationSettingsRow(context);
  const developerModeEnabled = settings.developer_mode_enabled;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let reservation: UsageReservation | undefined;

    try {
      if (!developerModeEnabled) {
        reservation = await reserveResearchUsage(
          { account: context },
          {
            model: task.model ?? undefined,
          }
        );
      }

      const payload = await runPrivateMemoryWorkflow({
        topic: prompt,
        ownerAddress: context.walletUser.walletAddress,
        requestedModel: task.model ?? undefined,
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
            topic: prompt,
          })
        : buildDeveloperModeUsageReceipt({
            account: context,
            model:
              proof?.compute?.usedModel ??
              proof?.compute?.model ??
              task.model ??
              undefined,
            providerTrace,
            tokenUsage: proof?.compute?.usage,
          });
      const alphaSignal = readAlphaSignalFromPayload(payload);

      if (alphaSignal) {
        const notification = await sendAlphaSignalNotification({
          alphaSignal,
          onChain: payload.onChain,
          project: task.project,
          proof: proof as ZeroGProof | undefined,
          report: payload.report,
          runId: run.id,
          settings: rowToSettings(settings),
          taskName: task.name,
        });

        payload.alphaSignal = withAlphaSignalNotification(
          alphaSignal,
          notification
        );
      }

      return finishRun(context, task, run, {
        result: withAutomationAttemptMetadata(
          payload as unknown as Json,
          attempt,
          maxAttempts
        ),
        status: "completed",
        usage: (payload.usage ?? null) as unknown as Json,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Automation run failed.";
      attemptErrors.push(message);

      if (reservation) {
        await refundResearchUsage(reservation, message).catch(() => undefined);
      }

      if (attempt === maxAttempts) {
        return finishRun(context, task, run, {
          error: message,
          result: {
            attempts: attemptErrors.map((attemptError, index) => ({
              attempt: index + 1,
              error: attemptError,
            })),
          },
          status: "failed",
        });
      }
    }
  }

  return finishRun(context, task, run, {
    error: "Automation run failed.",
    status: "failed",
  });
}

async function finishRun(
  context: AutomationContext,
  task: AutomationTaskRow,
  run: AutomationRunRow,
  {
    error,
    result,
    status,
    usage,
  }: {
    error?: string;
    result?: Json;
    status: AutomationRunStatus;
    usage?: Json;
  }
) {
  const settings = await readAutomationSettingsRow(context);
  const completedAt = new Date();
  const durationMs = Math.max(
    completedAt.getTime() - new Date(run.started_at || run.created_at).getTime(),
    0
  );
  const consecutiveFailures =
    status === "failed" ? task.consecutive_failures + 1 : 0;
  const shouldAutoPause =
    status === "failed" &&
    settings.auto_pause_repeated_failures &&
    consecutiveFailures >= task.failure_threshold &&
    task.status === "active";
  const nextRunAt =
    task.status === "active" &&
    !shouldAutoPause &&
    task.trigger_type === "schedule" &&
    task.schedule_frequency
      ? computeNextRunAt({
          frequency: task.schedule_frequency,
          from: completedAt,
          scheduleMonthDay: task.schedule_month_day ?? undefined,
          scheduleTime: task.schedule_time,
          scheduleWeekday: task.schedule_weekday ?? undefined,
          timezone: task.timezone,
        })
      : null;

  const { data, error: updateError } = await context.supabase
    .from("langclaw_automation_runs")
    .update({
      completed_at: completedAt.toISOString(),
      duration_ms: durationMs,
      error: error ?? null,
      result: result ?? null,
      status,
      usage: usage ?? null,
    })
    .eq("id", run.id)
    .eq("wallet_user_id", context.walletUser.id)
    .select("*")
    .single();

  if (updateError || !data) {
    throw new AutomationHttpError(
      500,
      updateError?.message || "Unable to finish automation run."
    );
  }

  await context.supabase
    .from("langclaw_automation_tasks")
    .update({
      consecutive_failures: consecutiveFailures,
      last_run_at: completedAt.toISOString(),
      last_run_status: status,
      next_run_at: nextRunAt,
      status: shouldAutoPause ? "paused" : task.status,
    })
    .eq("id", task.id)
    .eq("wallet_user_id", context.walletUser.id);

  const finishedRun = rowToRun(data as AutomationRunRow, task.name);

  if (settings.write_run_logs_to_memory) {
    await writeAutomationRunMemory(context, {
      completedAt: completedAt.toISOString(),
      error,
      project: task.project,
      runId: finishedRun.id,
      status,
      taskName: task.name,
    }).catch(() => undefined);
  }

  if (status === "failed" || status === "skipped") {
    const notification = {
      completedAt: finishedRun.completedAt,
      durationMs: finishedRun.durationMs,
      error,
      project: task.project,
      runId: finishedRun.id,
      settings: rowToSettings(settings),
      status,
      taskName: task.name,
      triggeredBy: finishedRun.triggeredBy,
    };

    await writeInAppAutomationNotification(context, task, finishedRun, notification)
      .catch(() => undefined);
    await sendAutomationRunNotification(notification).catch(() => undefined);
  }

  if (status === "completed") {
    const alphaSignal = readAlphaSignalFromPayload(result);

    if (
      alphaSignal?.alertEligible &&
      alphaSignal.notification?.status === "sent" &&
      rowToSettings(settings).notificationChannels.includes("in-app")
    ) {
      const message = buildAlphaSignalNotificationMessage({
        alphaSignal,
        completedAt: finishedRun.completedAt,
        onChain: readOnChainFromAutomationResult(result),
        project: task.project,
        proof: readProofFromAutomationResult(result),
        report: readReportFromAutomationResult(result),
        runId: finishedRun.id,
        taskName: task.name,
      });

      await writeInAppAlphaSignalNotification(
        context,
        task,
        finishedRun,
        message,
        alphaSignal
      ).catch(() => undefined);
    }
  }

  return finishedRun;
}

async function writeInAppAutomationNotification(
  context: AutomationContext,
  task: AutomationTaskRow,
  run: AutomationRun,
  notification: {
    completedAt?: string;
    durationMs?: number;
    error?: string;
    project: string;
    runId: string;
    settings: AutomationSettings;
    status: AutomationRunStatus;
    taskName: string;
    triggeredBy: AutomationTriggeredBy;
  }
) {
  if (!shouldWriteInAppNotification(notification.settings)) {
    return;
  }

  const message = buildAutomationNotificationMessage(notification);
  const { error } = await context.supabase
    .from("langclaw_automation_notifications")
    .insert({
      body: message.text,
      metadata: {
        error: notification.error ?? null,
        project: notification.project,
        status: notification.status,
        triggeredBy: notification.triggeredBy,
      },
      run_id: run.id,
      task_id: task.id,
      title: message.subject,
      wallet_user_id: context.walletUser.id,
    });

  if (error) {
    throw new AutomationHttpError(500, error.message);
  }
}

function shouldWriteInAppNotification(settings: AutomationSettings) {
  if (settings.failureNotification === "none") {
    return false;
  }

  return (
    settings.failureNotification === "in-app" ||
    settings.notificationChannels.includes("in-app")
  );
}

async function writeInAppAlphaSignalNotification(
  context: AutomationContext,
  task: AutomationTaskRow,
  run: AutomationRun,
  message: {
    subject: string;
    text: string;
  },
  alphaSignal: ReturnType<typeof readAlphaSignalFromPayload>
) {
  if (!alphaSignal) {
    return;
  }

  const { error } = await context.supabase
    .from("langclaw_automation_notifications")
    .insert({
      body: message.text,
      metadata: {
        falsePositiveChecks: alphaSignal.quality.falsePositiveChecks,
        label: alphaSignal.quality.label,
        score: alphaSignal.quality.score,
        signalType: alphaSignal.signalType,
        type: "alpha_signal",
      },
      run_id: run.id,
      task_id: task.id,
      title: message.subject,
      wallet_user_id: context.walletUser.id,
    });

  if (error) {
    throw new AutomationHttpError(500, error.message);
  }
}

function readProofFromAutomationResult(result?: Json): ZeroGProof | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return undefined;
  }

  const record = result as Record<string, unknown>;
  const proof = record.proof ?? record.zeroG;

  if (!proof || typeof proof !== "object") {
    return undefined;
  }

  return proof as ZeroGProof;
}

function readReportFromAutomationResult(result?: Json): ResearchReport | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return undefined;
  }

  const report = (result as Record<string, unknown>).report;

  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return undefined;
  }

  return report as ResearchReport;
}

function readOnChainFromAutomationResult(
  result?: Json
): OnChainToolFinalPayload | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return undefined;
  }

  const onChain = (result as Record<string, unknown>).onChain;

  if (!onChain || typeof onChain !== "object" || Array.isArray(onChain)) {
    return undefined;
  }

  return onChain as OnChainToolFinalPayload;
}

async function createRun(
  context: AutomationContext,
  task: AutomationTaskRow,
  startedAt: Date,
  triggeredBy: AutomationTriggeredBy
) {
  const { data, error } = await context.supabase
    .from("langclaw_automation_runs")
    .insert({
      attempt: task.consecutive_failures + 1,
      scheduled_for: task.next_run_at,
      started_at: startedAt.toISOString(),
      status: "running",
      task_id: task.id,
      triggered_by: triggeredBy,
      wallet_user_id: context.walletUser.id,
    })
    .select("*")
    .single();

  if (error || !data) {
    throw new AutomationHttpError(
      500,
      error?.message || "Unable to start automation run."
    );
  }

  return data as AutomationRunRow;
}

async function readGuardrailDecision(
  context: AutomationContext,
  task: AutomationTaskRow
): Promise<GuardrailDecision> {
  const settings = await readAutomationSettingsRow(context);
  const account = await readUsageAccount(context);
  const now = new Date();

  if (!settings.telegram_verified || !settings.telegram_chat_id?.trim()) {
    return {
      allowed: false,
      pauseTask: false,
      reason: "Telegram connection is required.",
    };
  }

  if (settings.developer_mode_enabled) {
    return {
      allowed: true,
      note: "Developer mode bypassed usage-credit guardrails.",
    };
  }

  const dailyTotal = await readUsageTotalSince(
    context,
    startOfLocalDay(now, task.timezone)
  );
  const monthlyTotal = await readUsageTotalSince(
    context,
    startOfLocalMonth(now, task.timezone)
  );

  if (
    settings.limit_behavior !== "allow" &&
    BigInt(dailyTotal) >= BigInt(readDecimalString(settings.daily_limit_neuron))
  ) {
    if (settings.limit_behavior === "alert") {
      return {
        allowed: true,
        note: "Daily automation MNT limit reached.",
      };
    }

    return {
      allowed: false,
      pauseTask: true,
      reason: "Daily automation MNT limit reached.",
    };
  }

  if (
    settings.limit_behavior !== "allow" &&
    BigInt(monthlyTotal) >= BigInt(readDecimalString(settings.monthly_cap_neuron))
  ) {
    if (settings.limit_behavior === "alert") {
      return {
        allowed: true,
        note: "Monthly automation MNT cap reached.",
      };
    }

    return {
      allowed: false,
      pauseTask: true,
      reason: "Monthly automation MNT cap reached.",
    };
  }

  if (
    account &&
    settings.threshold_action === "pause" &&
    BigInt(readDecimalString(account.available_neuron)) <
      BigInt(readDecimalString(settings.low_balance_threshold_neuron))
  ) {
    return {
      allowed: false,
      pauseTask: true,
      reason: "MNT balance is below the automation threshold.",
    };
  }

  return { allowed: true };
}

async function readAutomationSettingsForContext(context: AutomationContext) {
  return rowToSettings(await readAutomationSettingsRow(context));
}

function requireTelegramLinkedSettings(settings: AutomationSettings) {
  if (!settings.telegramVerified || !settings.telegramChatId?.trim()) {
    throw new AutomationHttpError(403, "Telegram connection is required.");
  }
}

async function readAutomationSettingsRow(context: AutomationContext) {
  const { data, error } = await context.supabase
    .from("langclaw_automation_settings")
    .upsert(
      {
        wallet_user_id: context.walletUser.id,
      },
      { onConflict: "wallet_user_id" }
    )
    .select("*")
    .single();

  if (error || !data) {
    throw new AutomationHttpError(
      500,
      error?.message || "Unable to read automation settings."
    );
  }

  return data as AutomationSettingsRow;
}

async function readAutomationTasksForContext(context: AutomationContext) {
  const rows = await readAutomationTaskRows(context);
  const runningTaskIds = await readRunningTaskIds(context);

  return rows.map((row) => rowToTask(row, runningTaskIds.has(row.id)));
}

async function readAutomationTaskRows(context: AutomationContext) {
  const { data, error } = await context.supabase
    .from("langclaw_automation_tasks")
    .select("*")
    .eq("wallet_user_id", context.walletUser.id)
    .neq("status", "archived")
    .order("updated_at", { ascending: false })
    .limit(100);

  if (error) {
    throw new AutomationHttpError(500, error.message);
  }

  return (data ?? []) as AutomationTaskRow[];
}

async function readAutomationTaskRow(context: AutomationContext, taskId: string) {
  const { data, error } = await context.supabase
    .from("langclaw_automation_tasks")
    .select("*")
    .eq("id", taskId)
    .eq("wallet_user_id", context.walletUser.id)
    .maybeSingle();

  if (error) {
    throw new AutomationHttpError(500, error.message);
  }

  if (!data) {
    throw new AutomationHttpError(404, "Automation task was not found.");
  }

  return data as AutomationTaskRow;
}

async function updateTaskStatus(
  context: AutomationContext,
  task: AutomationTaskRow,
  status: Extract<AutomationTaskStatus, "active" | "paused">
) {
  if (status === "active") {
    requireTelegramLinkedSettings(await readAutomationSettingsForContext(context));
  }

  const nextRunAt =
    status === "active" &&
    task.trigger_type === "schedule" &&
    task.schedule_frequency
      ? computeNextRunAt({
          frequency: task.schedule_frequency,
          scheduleMonthDay: task.schedule_month_day ?? undefined,
          scheduleTime: task.schedule_time,
          scheduleWeekday: task.schedule_weekday ?? undefined,
          timezone: task.timezone,
        })
      : null;
  const { data, error } = await context.supabase
    .from("langclaw_automation_tasks")
    .update({
      next_run_at: nextRunAt,
      status,
    })
    .eq("id", task.id)
    .eq("wallet_user_id", context.walletUser.id)
    .select("*")
    .single();

  if (error || !data) {
    throw new AutomationHttpError(
      500,
      error?.message || "Unable to update automation task status."
    );
  }

  return data as AutomationTaskRow;
}

async function readAutomationRunsForContext(
  context: AutomationContext,
  taskId?: string
) {
  let query = context.supabase
    .from("langclaw_automation_runs")
    .select(
      "*,langclaw_automation_tasks!inner(name)"
    )
    .eq("wallet_user_id", context.walletUser.id)
    .order("created_at", { ascending: false })
    .limit(30);

  if (taskId) {
    query = query.eq("task_id", taskId);
  }

  const { data, error } = await query;

  if (error) {
    throw new AutomationHttpError(500, error.message);
  }

  return ((data ?? []) as Array<AutomationRunRow & {
    langclaw_automation_tasks?: { name?: string } | null;
  }>).map((row) =>
    rowToRun(row, row.langclaw_automation_tasks?.name)
  );
}

async function readInAppAutomationNotificationsForContext(
  context: AutomationContext,
  limit = 20
): Promise<AutomationInAppNotification[]> {
  const { data, error } = await context.supabase
    .from("langclaw_automation_notifications")
    .select("*")
    .eq("wallet_user_id", context.walletUser.id)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw new AutomationHttpError(500, error.message);
  }

  return ((data ?? []) as AutomationNotificationRow[]).map(
    rowToInAppNotification
  );
}

async function readAutomationStats(context: AutomationContext): Promise<AutomationStats> {
  const [tasks, runningTaskIds, recentRuns] = await Promise.all([
    readAutomationTaskRows(context),
    readRunningTaskIds(context),
    readRecentRunRows(context, 250),
  ]);
  const now = Date.now();
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const runsLast30Days = recentRuns.filter(
    (run) => new Date(run.created_at).getTime() >= thirtyDaysAgo
  );
  const completedRuns = runsLast30Days.filter(
    (run) => run.status === "completed"
  ).length;
  const measuredRuns = runsLast30Days.filter(
    (run) => run.status === "completed" || run.status === "failed"
  ).length;
  const activeTasks = tasks.filter((task) => task.status === "active");
  const nextTask = activeTasks
    .filter((task) => task.next_run_at)
    .sort((left, right) =>
      String(left.next_run_at).localeCompare(String(right.next_run_at))
    )[0];

  return {
    activeTasks: activeTasks.length,
    completedThisWeek: recentRuns.filter(
      (run) =>
        run.status === "completed" &&
        new Date(run.created_at).getTime() >= weekAgo
    ).length,
    eventTasks: activeTasks.filter((task) => task.trigger_type !== "schedule")
      .length,
    nextRunAt: nextTask?.next_run_at ?? undefined,
    nextRunTaskName: nextTask?.name,
    pendingRuns: recentRuns.filter((run) => run.status === "queued").length,
    runningNow: runningTaskIds.size,
    scheduledTasks: activeTasks.filter((task) => task.trigger_type === "schedule")
      .length,
    successRate: measuredRuns ? Math.round((completedRuns / measuredRuns) * 1000) / 10 : 0,
  };
}

async function readRecentRunRows(context: AutomationContext, limit: number) {
  const { data, error } = await context.supabase
    .from("langclaw_automation_runs")
    .select("*")
    .eq("wallet_user_id", context.walletUser.id)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw new AutomationHttpError(500, error.message);
  }

  return (data ?? []) as AutomationRunRow[];
}

async function readRunningTaskIds(context: AutomationContext) {
  const { data, error } = await context.supabase
    .from("langclaw_automation_runs")
    .select("task_id")
    .eq("wallet_user_id", context.walletUser.id)
    .eq("status", "running");

  if (error) {
    throw new AutomationHttpError(500, error.message);
  }

  return new Set((data ?? []).map((row) => row.task_id));
}

async function readUsageTotalSince(context: AutomationContext, since: Date) {
  const { data, error } = await context.supabase
    .from("langclaw_usage_charges")
    .select("charged_neuron")
    .eq("wallet_user_id", context.walletUser.id)
    .gte("created_at", since.toISOString());

  if (error) {
    return "0";
  }

  return (data ?? [])
    .reduce((total, row) => total + BigInt(readDecimalString(row.charged_neuron)), 0n)
    .toString();
}

async function readUsageAccount(context: AutomationContext) {
  const { data } = await context.supabase
    .from("langclaw_usage_accounts")
    .select("available_neuron")
    .eq("wallet_user_id", context.walletUser.id)
    .maybeSingle();

  return data as { available_neuron: string } | null;
}

async function requireAutomationContext(
  authInput: AccountAuthInput
): Promise<AutomationContext> {
  try {
    return await requireAccountAuth(authInput);
  } catch (error) {
    if (error instanceof AccountAuthError) {
      throw new AutomationHttpError(error.status, error.message);
    }

    throw error;
  }
}

function requireAutomationSupabaseAdmin() {
  try {
    return requireSupabaseAdmin();
  } catch (error) {
    if (error instanceof AccountAuthError) {
      throw new AutomationHttpError(error.status, error.message);
    }

    throw error;
  }
}

async function createAutomationContextForWalletUser(
  supabase: AutomationContext["supabase"],
  walletUserId: string
): Promise<AutomationContext> {
  const { data, error } = await supabase
    .from("langclaw_wallet_users")
    .select("id,wallet_address")
    .eq("id", walletUserId)
    .maybeSingle();

  if (error) {
    throw new AutomationHttpError(500, error.message);
  }

  if (!data) {
    throw new AutomationHttpError(404, "Automation owner was not found.");
  }

  return {
    authMethod: "api_key",
    supabase,
    walletUser: {
      id: data.id,
      walletAddress: data.wallet_address,
    },
  };
}

function rowToTask(row: AutomationTaskRow, running = false): AutomationTask {
  return {
    consecutiveFailures: row.consecutive_failures,
    createdAt: row.created_at,
    displayStatus: running
      ? "Running"
      : row.status === "active"
        ? "Active"
        : row.status === "paused"
          ? "Paused"
          : "Draft",
    eventName: row.event_name ?? undefined,
    failureThreshold: row.failure_threshold,
    id: row.id,
    lastRunAt: row.last_run_at ?? undefined,
    lastRunStatus: row.last_run_status ?? undefined,
    maxRetries: row.max_retries,
    metadata: row.metadata,
    model: row.model ?? undefined,
    name: row.name,
    nextRunAt: row.next_run_at ?? undefined,
    project: row.project,
    prompt: row.prompt ?? undefined,
    scheduleFrequency: row.schedule_frequency ?? undefined,
    scheduleMonthDay: row.schedule_month_day ?? undefined,
    scheduleTime: row.schedule_time,
    scheduleWeekday: row.schedule_weekday ?? undefined,
    status: row.status,
    timezone: row.timezone,
    triggerLabel: buildTriggerLabel({
      eventName: row.event_name ?? undefined,
      scheduleFrequency: row.schedule_frequency ?? undefined,
      scheduleMonthDay: row.schedule_month_day ?? undefined,
      scheduleTime: row.schedule_time,
      scheduleWeekday: row.schedule_weekday ?? undefined,
      triggerType: row.trigger_type,
    }),
    triggerType: row.trigger_type,
    updatedAt: row.updated_at,
    webhookSlug: row.webhook_slug ?? undefined,
  };
}

function rowToRun(row: AutomationRunRow, taskName?: string): AutomationRun {
  return {
    attempt: row.attempt,
    completedAt: row.completed_at ?? undefined,
    createdAt: row.created_at,
    durationMs: row.duration_ms ?? undefined,
    error: row.error ?? undefined,
    id: row.id,
    result: row.result ?? undefined,
    scheduledFor: row.scheduled_for ?? undefined,
    startedAt: row.started_at ?? undefined,
    status: row.status,
    taskId: row.task_id,
    taskName,
    triggeredBy: row.triggered_by,
    usage: row.usage ?? undefined,
  };
}

function rowToInAppNotification(
  row: AutomationNotificationRow
): AutomationInAppNotification {
  return {
    body: row.body,
    createdAt: row.created_at,
    id: row.id,
    metadata: row.metadata,
    readAt: row.read_at ?? undefined,
    runId: row.run_id ?? undefined,
    status: row.status,
    taskId: row.task_id ?? undefined,
    title: row.title,
  };
}

function rowToSettings(row: AutomationSettingsRow): AutomationSettings {
  return {
    autoPauseRepeatedFailures: row.auto_pause_repeated_failures,
    dailyLimit0G: formatNeuronAs0G(BigInt(readDecimalString(row.daily_limit_neuron))),
    developerModeEnabled: row.developer_mode_enabled,
    failureNotification: row.failure_notification,
    limitBehavior: row.limit_behavior,
    lowBalanceThreshold0G: formatNeuronAs0G(
      BigInt(readDecimalString(row.low_balance_threshold_neuron))
    ),
    monthlyCap0G: formatNeuronAs0G(BigInt(readDecimalString(row.monthly_cap_neuron))),
    notificationChannels: row.notification_channels,
    notificationEmail: row.notification_email ?? undefined,
    notificationEmailLinkedAt: row.notification_email_linked_at ?? undefined,
    notificationEmailPending: row.notification_email_pending
      ? maskEmail(row.notification_email_pending)
      : undefined,
    notificationEmailVerified: row.notification_email_verified,
    retryPolicy: row.retry_policy,
    telegramChatId: row.telegram_chat_id ?? undefined,
    telegramLinkedAt: row.telegram_linked_at ?? undefined,
    telegramUsername: row.telegram_username ?? undefined,
    telegramVerified: row.telegram_verified,
    thresholdAction: row.threshold_action,
    writeRunLogsToMemory: row.write_run_logs_to_memory,
  };
}

function normalizeTaskInput(
  input: AutomationTaskInput,
  {
    existing,
    requireName,
    settings,
  }: {
    existing?: AutomationTaskRow;
    requireName: boolean;
    settings: AutomationSettings;
  }
) {
  const name = readOptionalString(input.name, 120);

  if (requireName && !name) {
    throw new AutomationHttpError(400, "Task name is required.");
  }

  const triggerType = readEnum<AutomationTriggerType>(
    input.triggerType,
    ["schedule", "event", "webhook"],
    existing?.trigger_type ?? "schedule"
  );
  const scheduleFrequency =
    triggerType === "schedule"
      ? readEnum<AutomationFrequency>(
          input.scheduleFrequency,
          ["daily", "weekly", "monthly"],
          existing?.schedule_frequency ?? "daily"
        )
      : undefined;
  const scheduleTime = readScheduleTime(
    input.scheduleTime,
    existing?.schedule_time ?? "09:00"
  );
  const timezone =
    readOptionalString(input.timezone, 80) || existing?.timezone || defaultTimezone;
  const nowParts = getZonedParts(new Date(), timezone);
  const eventName =
    triggerType === "event"
      ? readEventName(input.eventName ?? existing?.event_name)
      : readOptionalString(input.eventName, 160);

  return {
    eventName,
    failureThreshold: 5,
    maxRetries: settings.retryPolicy === "5-attempts"
      ? 5
      : settings.retryPolicy === "none"
        ? 0
        : 3,
    model: readOptionalString(input.model, 120),
    name,
    project:
      readOptionalString(input.project, 120) ||
      existing?.project ||
      "Langclaw Website",
    prompt: readOptionalString(input.prompt, 2000),
    scheduleFrequency,
    scheduleMonthDay:
      triggerType === "schedule"
        ? readInteger(input.scheduleMonthDay, existing?.schedule_month_day ?? nowParts.day, 1, 31)
        : undefined,
    scheduleTime,
    scheduleWeekday:
      triggerType === "schedule"
        ? readInteger(input.scheduleWeekday, existing?.schedule_weekday ?? nowParts.weekday, 0, 6)
        : undefined,
    status: readEnum<AutomationTaskStatus>(
      input.status,
      ["draft", "active", "paused"],
      existing?.status
    ),
    timezone,
    triggerType,
  };
}

function normalizeSettingsInput(input: AutomationSettingsInput): AutomationSettings {
  return {
    autoPauseRepeatedFailures:
      typeof input.autoPauseRepeatedFailures === "boolean"
        ? input.autoPauseRepeatedFailures
        : true,
    developerModeEnabled:
      typeof input.developerModeEnabled === "boolean"
        ? input.developerModeEnabled
        : false,
    dailyLimit0G: read0GAmount(input.dailyLimit0G, "25"),
    failureNotification: readEnum(
      input.failureNotification,
      ["email", "in-app", "none"],
      "email"
    ) ?? "email",
    limitBehavior: readEnum(input.limitBehavior, ["pause", "alert", "allow"], "pause") ?? "pause",
    lowBalanceThreshold0G: read0GAmount(input.lowBalanceThreshold0G, "10"),
    monthlyCap0G: read0GAmount(input.monthlyCap0G, "500"),
    notificationChannels: readNotificationChannels(input.notificationChannels),
    notificationEmail: readOptionalString(input.notificationEmail, 320),
    notificationEmailVerified: false,
    retryPolicy: readEnum(input.retryPolicy, ["none", "3-attempts", "5-attempts"], "3-attempts") ?? "3-attempts",
    telegramChatId: readOptionalString(input.telegramChatId, 120),
    telegramVerified: false,
    thresholdAction: readEnum(
      input.thresholdAction,
      ["notify", "pause", "continue"],
      "notify"
    ) ?? "notify",
    writeRunLogsToMemory:
      typeof input.writeRunLogsToMemory === "boolean"
        ? input.writeRunLogsToMemory
        : false,
  };
}

function readTaskId(value: unknown) {
  if (typeof value !== "string" || !value.trim()) {
    throw new AutomationHttpError(400, "taskId is required.");
  }

  return value.trim();
}

function readNotificationId(value: unknown) {
  if (typeof value !== "string" || !value.trim()) {
    throw new AutomationHttpError(400, "notificationId is required.");
  }

  return value.trim();
}

function readEventName(value: unknown) {
  const eventName = readOptionalString(value, 160);

  if (!eventName) {
    throw new AutomationHttpError(400, "eventName is required.");
  }

  return eventName;
}

function readWebhookSlug(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,80}$/i.test(value.trim())
  ) {
    throw new AutomationHttpError(400, "A valid webhook slug is required.");
  }

  return value.trim();
}

function readLimit(value: unknown, fallback: number, max = 10) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(Math.max(Math.trunc(value), 1), max);
}

function readOptionalString(value: unknown, maxLength: number) {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return undefined;
  }

  return trimmed.slice(0, maxLength);
}

function readScheduleTime(value: unknown, fallback: string) {
  if (typeof value !== "string" || !/^[0-2][0-9]:[0-5][0-9]$/.test(value)) {
    return fallback;
  }

  const [hour] = value.split(":").map(Number);

  return hour > 23 ? fallback : value;
}

function readInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number
) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(Math.max(Math.trunc(value), min), max);
}

function readEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback?: T
) {
  if (typeof value === "string" && allowed.includes(value as T)) {
    return value as T;
  }

  return fallback;
}

function readNotificationChannels(
  value: unknown
): Array<"email" | "telegram" | "in-app"> {
  if (!Array.isArray(value)) {
    return ["email"];
  }

  const channels = value.filter(
    (item): item is "email" | "telegram" | "in-app" =>
      item === "email" || item === "telegram" || item === "in-app"
  );

  return channels.length ? Array.from(new Set(channels)) : ["email"];
}

async function findTelegramUpdateByCodeHash(codeHash: string) {
  const token = process.env.LANGCLAW_TELEGRAM_BOT_TOKEN?.trim();

  if (!token) {
    throw new AutomationHttpError(503, "Telegram bot token is not configured.");
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);

  if (!response.ok) {
    throw new AutomationHttpError(
      502,
      `Telegram getUpdates failed with ${response.status}.`
    );
  }

  const payload = (await response.json().catch(() => null)) as
    | { ok?: boolean; result?: unknown[] }
    | null;

  if (!payload?.ok || !Array.isArray(payload.result)) {
    return null;
  }

  for (const update of payload.result) {
    const candidate = readTelegramUpdateCandidate(update);

    if (candidate && hashLinkCode(candidate.code) === codeHash) {
      return candidate;
    }
  }

  return null;
}

async function linkTelegramChat(
  supabase: AutomationContext["supabase"],
  settings: AutomationSettingsRow,
  candidate: TelegramLinkCandidate
) {
  const { data, error } = await supabase
    .from("langclaw_automation_settings")
    .update({
      notification_channels: unionChannels(
        settings.notification_channels,
        "telegram"
      ),
      telegram_chat_id: candidate.chatId,
      telegram_link_code_hash: null,
      telegram_link_expires_at: null,
      telegram_linked_at: new Date().toISOString(),
      telegram_username: candidate.username ?? null,
      telegram_verified: true,
    })
    .eq("wallet_user_id", settings.wallet_user_id)
    .select("*")
    .single();

  if (error || !data) {
    throw new AutomationHttpError(
      500,
      error?.message || "Unable to link Telegram chat."
    );
  }

  await sendTelegramVerificationSuccess(candidate.chatId).catch(() => undefined);

  return rowToSettings(data as AutomationSettingsRow);
}

async function sendTelegramVerificationSuccess(chatId: string) {
  const token = process.env.LANGCLAW_TELEGRAM_BOT_TOKEN?.trim();

  if (!token) {
    return;
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    body: JSON.stringify({
      chat_id: chatId,
      disable_web_page_preview: true,
      text: "Verification success. Langclaw automation alerts are now linked.",
    }),
    headers: {
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  if (!response.ok) {
    throw new AutomationHttpError(
      502,
      `Telegram verification reply failed with ${response.status}.`
    );
  }
}

function readTelegramUpdateCandidate(update: unknown): TelegramLinkCandidate | null {
  if (!update || typeof update !== "object") {
    return null;
  }

  const message = (update as { message?: unknown }).message;

  if (!message || typeof message !== "object") {
    return null;
  }

  const text = (message as { text?: unknown }).text;
  const chat = (message as { chat?: unknown }).chat;

  if (typeof text !== "string" || !chat || typeof chat !== "object") {
    return null;
  }

  const chatId = (chat as { id?: unknown }).id;
  const code = readTelegramCodeFromText(text);

  if ((typeof chatId !== "string" && typeof chatId !== "number") || !code) {
    return null;
  }

  const from = (message as { from?: unknown }).from;
  const username =
    from && typeof from === "object"
      ? (from as { username?: unknown }).username
      : undefined;

  return {
    chatId: String(chatId),
    code,
    username: typeof username === "string" ? username : undefined,
  };
}

export function readTelegramCodeFromText(text: string) {
  const commandMatch = text.match(
    /(?:^|\s)\/?(?:link|start)\s+([A-Za-z0-9]{6,32})\b/i
  );

  if (commandMatch) {
    return commandMatch[1].toUpperCase();
  }

  const trimmed = text.trim();

  if (/^[A-Za-z0-9]{6,32}$/.test(trimmed)) {
    return trimmed.toUpperCase();
  }

  return "";
}

function readTelegramBotUsername() {
  const configured = process.env.LANGCLAW_TELEGRAM_BOT_USERNAME?.trim() || "";
  const normalized = configured.replace(/^@+/, "");

  return /^[A-Za-z0-9_]{5,32}$/.test(normalized)
    ? normalized
    : defaultTelegramBotUsername;
}

function readEmail(value: unknown) {
  const email = readOptionalString(value, 320)?.toLowerCase();

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new AutomationHttpError(400, "A valid email is required.");
  }

  return email;
}

function readLinkCode(value: unknown) {
  if (typeof value !== "string" || !/^[A-Za-z0-9]{4,32}$/.test(value.trim())) {
    throw new AutomationHttpError(400, "A valid link code is required.");
  }

  return value.trim().toUpperCase();
}

function hashLinkCode(value: string) {
  return createHash("sha256")
    .update(value.trim().toUpperCase())
    .digest("hex");
}

function unionChannels(
  current: Array<"email" | "telegram" | "in-app">,
  channel: "email" | "telegram" | "in-app"
) {
  return Array.from(new Set([...current, channel]));
}

function removeChannel(
  current: Array<"email" | "telegram" | "in-app">,
  channel: "email" | "telegram" | "in-app"
) {
  return current.filter((item) => item !== channel);
}

function maskEmail(email: string) {
  const [name, domain] = email.split("@");
  const maskedName =
    name.length <= 2 ? `${name[0] ?? "*"}*` : `${name.slice(0, 2)}***`;

  return `${maskedName}@${domain}`;
}

function readMaxAttempts(maxRetries: number) {
  if (!Number.isFinite(maxRetries) || maxRetries <= 0) {
    return 1;
  }

  return Math.min(Math.trunc(maxRetries), 5);
}

function buildTaskPrompt(task: AutomationTaskRow, triggerPayload?: unknown) {
  const basePrompt = task.prompt || task.name;

  if (triggerPayload === undefined) {
    return basePrompt;
  }

  return [
    basePrompt,
    "",
    "Trigger payload:",
    stringifyTriggerPayload(triggerPayload),
  ].join("\n");
}

function stringifyTriggerPayload(payload: unknown) {
  try {
    return JSON.stringify(payload, null, 2).slice(0, 4000);
  } catch {
    return String(payload).slice(0, 4000);
  }
}

function withAutomationAttemptMetadata(
  result: Json,
  attempt: number,
  maxAttempts: number
): Json {
  const automation = { attempt, maxAttempts };

  if (result && typeof result === "object" && !Array.isArray(result)) {
    return {
      ...result,
      automation,
    };
  }

  return {
    automation,
    result,
  };
}

function read0GAmount(value: unknown, fallback: string) {
  if (typeof value !== "string" && typeof value !== "number") {
    return fallback;
  }

  const raw = String(value).trim();

  if (!/^\d+(\.\d{1,18})?$/.test(raw)) {
    return fallback;
  }

  return raw;
}

function parse0GToNeuron(value: string) {
  const [wholePart, fractionPart = ""] = value.split(".");
  const whole = BigInt(wholePart || "0") * neuronPer0G;
  const fraction = BigInt(fractionPart.padEnd(18, "0").slice(0, 18) || "0");

  return (whole + fraction).toString();
}

function formatNeuronAs0G(value: bigint) {
  const whole = value / neuronPer0G;
  const fraction = (value % neuronPer0G).toString().padStart(18, "0");
  const trimmed = fraction.replace(/0+$/, "");

  return trimmed ? `${whole}.${trimmed}` : whole.toString();
}

function readDecimalString(value: string | number | null | undefined) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(Math.trunc(value)) : "0";
  }

  if (typeof value !== "string") {
    return "0";
  }

  return /^\d+$/.test(value) ? value : "0";
}

export function createWebhookSlug(name: string) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

  return `${slug || "task"}-${randomBytes(16).toString("hex")}`;
}

function startOfLocalDay(date: Date, timezone: string) {
  const parts = getZonedParts(date, timezone);

  return localPartsToUtc({
    day: parts.day,
    hour: 0,
    minute: 0,
    month: parts.month,
    year: parts.year,
  }, timezone);
}

function startOfLocalMonth(date: Date, timezone: string) {
  const parts = getZonedParts(date, timezone);

  return localPartsToUtc({
    day: 1,
    hour: 0,
    minute: 0,
    month: parts.month,
    year: parts.year,
  }, timezone);
}

function localPartsToUtc(
  parts: {
    day: number;
    hour: number;
    minute: number;
    month: number;
    year: number;
  },
  timezone: string
) {
  const utcGuess = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute)
  );
  const zoned = getZonedParts(utcGuess, timezone);
  const offset =
    Date.UTC(
      zoned.year,
      zoned.month - 1,
      zoned.day,
      zoned.hour,
      zoned.minute,
      zoned.second
    ) - utcGuess.getTime();

  return new Date(utcGuess.getTime() - offset);
}
