import { timingSafeEqual } from "node:crypto";

import type { WalletAuthInput } from "../lib/server/wallet-auth";
import {
  automationErrorResponse,
  createAutomationTask,
  createTelegramLinkCode,
  deleteAutomationTask,
  pollTelegramLink,
  processTelegramWebhookUpdate,
  readAutomationDashboard,
  readInAppAutomationNotifications,
  readAutomationRuns,
  readAutomationSettings,
  markAllInAppAutomationNotificationsRead,
  markInAppAutomationNotificationRead,
  requestNotificationEmailLink,
  runAutomationEvent,
  runAutomationTask,
  runDueAutomationTasks,
  runAutomationWebhook,
  setAllAutomationStatus,
  unlinkNotificationEmail,
  unlinkTelegramLink,
  updateAutomationSettings,
  updateAutomationTask,
  verifyNotificationEmailLink,
} from "../lib/automation/service";
import type {
  AutomationSettingsInput,
  AutomationTaskInput,
  AutomationTriggeredBy,
} from "../lib/automation/types";

type AutomationBody = {
  action?: unknown;
  code?: unknown;
  email?: unknown;
  eventName?: unknown;
  limit?: unknown;
  notificationId?: unknown;
  payload?: unknown;
  settings?: AutomationSettingsInput;
  task?: AutomationTaskInput;
  taskId?: unknown;
  triggeredBy?: unknown;
  wallet?: WalletAuthInput;
};

const AUTOMATION_WEBHOOK_BODY_LIMIT_BYTES = 64 * 1024;
const WEBHOOK_CLIENT_RATE_LIMIT = 120;
const WEBHOOK_SLUG_RATE_LIMIT = 30;
const WEBHOOK_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const WEBHOOK_RATE_LIMIT_MAX_BUCKETS = 5_000;
const webhookRateLimits = new Map<
  string,
  {
    count: number;
    resetAt: number;
  }
>();

export async function handleAutomationTasks(request: Request) {
  const body = await readAutomationBody(request);

  if ("response" in body) {
    return body.response;
  }

  const auth = { request, wallet: body.wallet ?? {} };

  try {
    if (!body.action || body.action === "list") {
      return Response.json(await readAutomationDashboard(auth));
    }

    if (body.action === "create") {
      return Response.json({
        configured: true,
        task: await createAutomationTask(auth, body.task ?? {}),
      });
    }

    if (body.action === "update") {
      return Response.json({
        configured: true,
        task: await updateAutomationTask(
          auth,
          body.taskId,
          body.task ?? {}
        ),
      });
    }

    if (body.action === "pause") {
      return Response.json({
        configured: true,
        task: await updateAutomationTask(auth, body.taskId, {
          status: "paused",
        }),
      });
    }

    if (body.action === "resume") {
      return Response.json({
        configured: true,
        task: await updateAutomationTask(auth, body.taskId, {
          status: "active",
        }),
      });
    }

    if (body.action === "delete") {
      return Response.json({
        configured: true,
        ...(await deleteAutomationTask(auth, body.taskId)),
      });
    }

    if (body.action === "pause-all") {
      return Response.json({
        configured: true,
        tasks: await setAllAutomationStatus(auth, "paused"),
      });
    }

    if (body.action === "resume-all") {
      return Response.json({
        configured: true,
        tasks: await setAllAutomationStatus(auth, "active"),
      });
    }

    return Response.json({ error: "Unsupported action." }, { status: 400 });
  } catch (error) {
    return automationErrorResponse(error);
  }
}

export async function handleAutomationRuns(request: Request) {
  const body = await readAutomationBody(request);

  if ("response" in body) {
    return body.response;
  }

  const auth = { request, wallet: body.wallet ?? {} };

  try {
    if (!body.action || body.action === "list") {
      return Response.json({
        configured: true,
        runs: await readAutomationRuns(auth, body.taskId),
      });
    }

    if (body.action === "run") {
      return Response.json({
        configured: true,
        run: await runAutomationTask(
          auth,
          body.taskId,
          readTriggeredBy(body.triggeredBy)
        ),
      });
    }

    if (body.action === "tick") {
      return Response.json({
        configured: true,
        runs: await runDueAutomationTasks(auth, body.limit),
      });
    }

    if (body.action === "event") {
      return Response.json({
        configured: true,
        runs: await runAutomationEvent(
          auth,
          body.eventName,
          body.payload,
          body.limit
        ),
      });
    }

    return Response.json({ error: "Unsupported action." }, { status: 400 });
  } catch (error) {
    return automationErrorResponse(error);
  }
}

export async function handleAutomationSettings(request: Request) {
  const body = await readAutomationBody(request);

  if ("response" in body) {
    return body.response;
  }

  const auth = { request, wallet: body.wallet ?? {} };

  try {
    if (!body.action || body.action === "get") {
      return Response.json({
        configured: true,
        settings: await readAutomationSettings(auth),
      });
    }

    if (body.action === "update") {
      return Response.json({
        configured: true,
        settings: await updateAutomationSettings(
          auth,
          body.settings ?? {}
        ),
      });
    }

    return Response.json({ error: "Unsupported action." }, { status: 400 });
  } catch (error) {
    return automationErrorResponse(error);
  }
}

export async function handleAutomationNotifications(request: Request) {
  const body = await readAutomationBody(request);

  if ("response" in body) {
    return body.response;
  }

  const auth = { request, wallet: body.wallet ?? {} };

  try {
    if (body.action === "request-email-link") {
      return Response.json({
        configured: true,
        link: await requestNotificationEmailLink(auth, body.email),
      });
    }

    if (body.action === "verify-email-link") {
      return Response.json({
        configured: true,
        settings: await verifyNotificationEmailLink(
          auth,
          body.code
        ),
      });
    }

    if (body.action === "unlink-email") {
      return Response.json({
        configured: true,
        settings: await unlinkNotificationEmail(auth),
      });
    }

    if (body.action === "create-telegram-link") {
      return Response.json({
        configured: true,
        link: await createTelegramLinkCode(auth),
      });
    }

    if (body.action === "poll-telegram-link") {
      return Response.json({
        configured: true,
        ...(await pollTelegramLink(auth)),
      });
    }

    if (body.action === "unlink-telegram") {
      return Response.json({
        configured: true,
        settings: await unlinkTelegramLink(auth),
      });
    }

    if (body.action === "list-in-app") {
      return Response.json({
        configured: true,
        notifications: await readInAppAutomationNotifications(auth, body.limit),
      });
    }

    if (body.action === "mark-in-app-read") {
      return Response.json({
        configured: true,
        notification: await markInAppAutomationNotificationRead(
          auth,
          body.notificationId
        ),
      });
    }

    if (body.action === "mark-all-in-app-read") {
      return Response.json({
        configured: true,
        ...(await markAllInAppAutomationNotificationsRead(auth)),
      });
    }

    return Response.json({ error: "Unsupported action." }, { status: 400 });
  } catch (error) {
    return automationErrorResponse(error);
  }
}

export async function handleAutomationWebhook(request: Request, slug: string) {
  const rateLimitResponse = checkAutomationWebhookRateLimit(request, slug);

  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  const payload = await readOptionalJsonBody(request);

  if ("response" in payload) {
    return payload.response;
  }

  try {
    return Response.json({
      configured: true,
      run: await runAutomationWebhook(slug, payload.value),
    });
  } catch (error) {
    return automationErrorResponse(error);
  }
}

export async function handleAutomationTelegramWebhook(request: Request) {
  const secretResponse = requireTelegramWebhookSecret(request);

  if (secretResponse) {
    return secretResponse;
  }

  let update: unknown;

  try {
    update = await request.json();
  } catch {
    return Response.json(
      { error: "Request body must be valid JSON." },
      { status: 400 }
    );
  }

  try {
    return Response.json({
      configured: true,
      ...(await processTelegramWebhookUpdate(update)),
    });
  } catch (error) {
    return automationErrorResponse(error);
  }
}

async function readAutomationBody(
  request: Request
): Promise<AutomationBody | { response: Response }> {
  try {
    return (await request.json()) as AutomationBody;
  } catch {
    return {
      response: Response.json(
        { error: "Request body must be valid JSON." },
        { status: 400 }
      ),
    };
  }
}

async function readOptionalJsonBody(
  request: Request
): Promise<{ value: unknown } | { response: Response }> {
  const contentLength = Number(request.headers.get("content-length") || "0");

  if (
    Number.isFinite(contentLength) &&
    contentLength > AUTOMATION_WEBHOOK_BODY_LIMIT_BYTES
  ) {
    return {
      response: Response.json(
        { error: "Automation webhook payload is too large." },
        { status: 413 }
      ),
    };
  }

  const text = await request.text();

  if (
    new TextEncoder().encode(text).byteLength >
    AUTOMATION_WEBHOOK_BODY_LIMIT_BYTES
  ) {
    return {
      response: Response.json(
        { error: "Automation webhook payload is too large." },
        { status: 413 }
      ),
    };
  }

  if (!text.trim()) {
    return { value: undefined };
  }

  try {
    return { value: JSON.parse(text) };
  } catch {
    return {
      response: Response.json(
        { error: "Request body must be valid JSON." },
        { status: 400 }
      ),
    };
  }
}

function checkAutomationWebhookRateLimit(request: Request, slug: string) {
  const normalizedSlug = normalizeWebhookSlugForRateLimit(slug);

  if (!normalizedSlug) {
    return Response.json({ error: "A valid webhook slug is required." }, { status: 400 });
  }

  const clientId = readWebhookClientId(request);
  const clientLimit = incrementWebhookRateLimit(
    `client:${clientId}`,
    WEBHOOK_CLIENT_RATE_LIMIT
  );

  if (clientLimit) {
    return clientLimit;
  }

  return incrementWebhookRateLimit(
    `client-slug:${clientId}:${normalizedSlug}`,
    WEBHOOK_SLUG_RATE_LIMIT
  );
}

function incrementWebhookRateLimit(key: string, limit: number) {
  const now = Date.now();
  pruneExpiredWebhookRateLimits(now);
  const current = webhookRateLimits.get(key);

  if (!current) {
    evictWebhookRateLimitBuckets();
  }

  const bucket =
    current && current.resetAt > now
      ? current
      : { count: 0, resetAt: now + WEBHOOK_RATE_LIMIT_WINDOW_MS };

  bucket.count += 1;
  webhookRateLimits.set(key, bucket);

  if (bucket.count <= limit) {
    return null;
  }

  const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));

  return Response.json(
    { error: "Too many automation webhook requests." },
    {
      headers: {
        "Retry-After": String(retryAfter),
      },
      status: 429,
    }
  );
}

function readWebhookClientId(request: Request) {
  if (!trustedProxyHeadersEnabled()) {
    return "direct";
  }

  return cleanClientIp(
    request.headers.get("cf-connecting-ip")?.trim() ||
      request.headers.get("x-real-ip")?.trim() ||
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
  );
}

function readTriggeredBy(value: unknown): AutomationTriggeredBy {
  if (
    value === "schedule" ||
    value === "event" ||
    value === "webhook" ||
    value === "manual" ||
    value === "system"
  ) {
    return value;
  }

  return "manual";
}

function requireTelegramWebhookSecret(request: Request) {
  const configured =
    process.env.LANGCLAW_TELEGRAM_WEBHOOK_SECRET_TOKEN?.trim() ||
    process.env.LANGCLAW_TELEGRAM_WEBHOOK_SECRET?.trim();

  if (!configured) {
    if (
      process.env.NODE_ENV === "production" &&
      process.env.LANGCLAW_TELEGRAM_BOT_TOKEN?.trim()
    ) {
      return Response.json(
        { error: "LANGCLAW_TELEGRAM_WEBHOOK_SECRET_TOKEN is required." },
        { status: 503 }
      );
    }

    return null;
  }

  const supplied = request.headers.get("x-telegram-bot-api-secret-token")?.trim();

  if (!supplied || !safeEqual(supplied, configured)) {
    return Response.json({ error: "Invalid Telegram webhook secret." }, { status: 401 });
  }

  return null;
}

function normalizeWebhookSlugForRateLimit(slug: string) {
  const normalized = slug.trim().toLowerCase();

  return /^[a-z0-9][a-z0-9-]{0,95}$/.test(normalized) ? normalized : null;
}

function pruneExpiredWebhookRateLimits(now: number) {
  for (const [key, bucket] of webhookRateLimits) {
    if (bucket.resetAt <= now) {
      webhookRateLimits.delete(key);
    }
  }
}

function evictWebhookRateLimitBuckets() {
  const maxBuckets = readWebhookRateLimitMaxBuckets();

  while (webhookRateLimits.size >= maxBuckets) {
    const oldest = webhookRateLimits.keys().next().value;

    if (!oldest) {
      return;
    }

    webhookRateLimits.delete(oldest);
  }
}

function readWebhookRateLimitMaxBuckets() {
  const parsed = Number(process.env.LANGCLAW_WEBHOOK_RATE_LIMIT_MAX_BUCKETS);

  return Number.isSafeInteger(parsed) && parsed >= 1
    ? parsed
    : WEBHOOK_RATE_LIMIT_MAX_BUCKETS;
}

function trustedProxyHeadersEnabled() {
  return process.env.LANGCLAW_TRUST_PROXY_HEADERS === "true";
}

function cleanClientIp(value: string | undefined) {
  return value && value.length <= 128 ? value : "unknown";
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}
