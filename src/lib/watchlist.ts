import {
  AccountAuthError,
  requireAccountAuth,
  type AccountAuthInput,
  type AuthenticatedAccount,
} from "./server/account-auth";
import type { Database } from "./supabase/database.types";

export type AlphaWatchlistItem = {
  addedAt: string;
  agentId?: string;
  caveat: string;
  chain: string;
  decisionHash?: string;
  decisionId?: string;
  evidenceUri?: string;
  explorerUrl?: string;
  gapCount: number;
  id: string;
  intent: string;
  note?: string;
  priority: AlphaWatchlistPriority;
  proofTx?: string;
  recommendation: string;
  reviewedAt?: string;
  sessionId?: string;
  signalType: string;
  snoozedUntil?: string;
  sourcePrompt?: string;
  sourceCount: number;
  status: AlphaWatchlistStatus;
  subject: string;
  summary: string;
  title: string;
};

export type AlphaWatchlistInput = Partial<AlphaWatchlistItem>;
export type AlphaWatchlistPriority = "high" | "low" | "medium";
export type AlphaWatchlistStatus =
  | "reviewed"
  | "snoozed"
  | "stale"
  | "watching";
export type AlphaWatchlistMetadataInput = {
  note?: unknown;
  priority?: unknown;
  snoozedUntil?: unknown;
  status?: unknown;
};

type AlphaWatchlistRow =
  Database["public"]["Tables"]["langclaw_alpha_watchlist"]["Row"];
type AlphaWatchlistUpsert =
  Database["public"]["Tables"]["langclaw_alpha_watchlist"]["Insert"];
type AlphaWatchlistUpdate =
  Database["public"]["Tables"]["langclaw_alpha_watchlist"]["Update"];
type AlphaWatchlistContext = AuthenticatedAccount;

export class WatchlistHttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function watchlistErrorResponse(error: unknown) {
  if (error instanceof WatchlistHttpError || error instanceof AccountAuthError) {
    return Response.json(
      {
        configured: error.status !== 503,
        error: error.message,
      },
      { status: error.status }
    );
  }

  return Response.json(
    {
      configured: true,
      error:
        error instanceof Error ? error.message : "Watchlist request failed.",
    },
    { status: 500 }
  );
}

export async function listAlphaWatchlist(authInput: AccountAuthInput) {
  const context = await requireWatchlistContext(authInput);
  const { data, error } = await context.supabase
    .from("langclaw_alpha_watchlist")
    .select("*")
    .eq("wallet_user_id", context.walletUser.id)
    .order("added_at", { ascending: false })
    .limit(100);

  if (error) {
    throw new WatchlistHttpError(
      500,
      error.message || "Unable to load alpha watchlist."
    );
  }

  return (data ?? []).map((row) => rowToAlphaWatchlistItem(row));
}

export async function upsertAlphaWatchlistItem(
  authInput: AccountAuthInput,
  input: AlphaWatchlistInput
) {
  const context = await requireWatchlistContext(authInput);
  const item = normalizeAlphaWatchlistInput(input);
  await requireOwnedSession(context, item.sessionId);
  const row: AlphaWatchlistUpsert = {
    added_at: item.addedAt,
    agent_id: optionalText(item.agentId),
    caveat: item.caveat,
    chain: item.chain,
    decision_hash: optionalText(item.decisionHash),
    decision_id: optionalText(item.decisionId),
    evidence_uri: optionalText(item.evidenceUri),
    explorer_url: optionalText(item.explorerUrl),
    gap_count: item.gapCount,
    id: item.id,
    intent: item.intent,
    proof_tx: optionalText(item.proofTx),
    recommendation: item.recommendation,
    session_id: optionalText(item.sessionId, 240),
    signal_type: item.signalType,
    source_prompt: optionalText(item.sourcePrompt, 4_000),
    source_count: item.sourceCount,
    subject: item.subject,
    summary: item.summary,
    title: item.title,
    wallet_user_id: context.walletUser.id,
  };
  let { data, error } = await upsertAlphaWatchlistRow(context, row);

  if (isMissingSessionIdColumnError(error)) {
    const { session_id: _sessionId, ...legacyRow } = row;
    ({ data, error } = await upsertAlphaWatchlistRow(context, legacyRow));
  }

  if (error || !data) {
    throw new WatchlistHttpError(
      500,
      error?.message || "Unable to save alpha watchlist item."
    );
  }

  return rowToAlphaWatchlistItem(data);
}

export async function updateAlphaWatchlistMetadata(
  authInput: AccountAuthInput,
  itemId: unknown,
  input: AlphaWatchlistMetadataInput
) {
  const context = await requireWatchlistContext(authInput);
  const id = readRequiredText(itemId, "Watchlist item id", 240);
  const patch = normalizeAlphaWatchlistMetadataInput(input);

  if (!Object.keys(patch).length) {
    throw new WatchlistHttpError(400, "No watchlist changes were provided.");
  }

  const { data, error } = await context.supabase
    .from("langclaw_alpha_watchlist")
    .update(patch)
    .eq("wallet_user_id", context.walletUser.id)
    .eq("id", id)
    .select("*")
    .maybeSingle();

  if (error) {
    throw new WatchlistHttpError(
      500,
      error.message || "Unable to update alpha watchlist item."
    );
  }

  if (!data) {
    throw new WatchlistHttpError(404, "Watchlist item was not found.");
  }

  return rowToAlphaWatchlistItem(data);
}

function upsertAlphaWatchlistRow(
  context: AlphaWatchlistContext,
  row: AlphaWatchlistUpsert
) {
  return context.supabase
    .from("langclaw_alpha_watchlist")
    .upsert(row, { onConflict: "wallet_user_id,id" })
    .select("*")
    .single();
}

export async function deleteAlphaWatchlistItem(
  authInput: AccountAuthInput,
  itemId: unknown
) {
  const context = await requireWatchlistContext(authInput);
  const id = readRequiredText(itemId, "Watchlist item id", 240);
  const { error } = await context.supabase
    .from("langclaw_alpha_watchlist")
    .delete()
    .eq("wallet_user_id", context.walletUser.id)
    .eq("id", id);

  if (error) {
    throw new WatchlistHttpError(
      500,
      error.message || "Unable to delete alpha watchlist item."
    );
  }

  return { deleted: true, itemId: id };
}

export async function clearAlphaWatchlist(authInput: AccountAuthInput) {
  const context = await requireWatchlistContext(authInput);
  const { error } = await context.supabase
    .from("langclaw_alpha_watchlist")
    .delete()
    .eq("wallet_user_id", context.walletUser.id);

  if (error) {
    throw new WatchlistHttpError(
      500,
      error.message || "Unable to clear alpha watchlist."
    );
  }

  return { cleared: true };
}

async function requireWatchlistContext(authInput: AccountAuthInput) {
  return requireAccountAuth(authInput);
}

async function requireOwnedSession(
  context: AlphaWatchlistContext,
  sessionId?: string
) {
  if (!sessionId) {
    return;
  }

  const { data, error } = await context.supabase
    .from("langclaw_chat_sessions")
    .select("id")
    .eq("wallet_user_id", context.walletUser.id)
    .eq("id", sessionId)
    .maybeSingle();

  if (error) {
    throw new WatchlistHttpError(
      500,
      error.message || "Unable to validate the source chat session."
    );
  }

  if (!data) {
    throw new WatchlistHttpError(
      400,
      "Source chat session does not belong to this wallet."
    );
  }
}

function normalizeAlphaWatchlistInput(
  input: AlphaWatchlistInput
): AlphaWatchlistItem {
  return {
    addedAt: readIsoDate(input.addedAt),
    agentId: optionalText(input.agentId),
    caveat: readRequiredText(input.caveat, "Caveat", 4_000),
    chain: readRequiredText(input.chain || "sui", "Chain", 64),
    decisionHash: optionalText(input.decisionHash, 160),
    decisionId: optionalText(input.decisionId, 80),
    evidenceUri: optionalText(input.evidenceUri, 1_000),
    explorerUrl: optionalText(input.explorerUrl, 1_000),
    gapCount: readCount(input.gapCount),
    id: readRequiredText(input.id, "Watchlist item id", 240),
    intent: readRequiredText(input.intent, "Intent", 500),
    priority: "medium",
    proofTx: optionalText(input.proofTx, 160),
    recommendation: readRequiredText(input.recommendation, "Recommendation", 4_000),
    sessionId: optionalText(input.sessionId, 240),
    signalType: readRequiredText(input.signalType, "Signal type", 120),
    sourcePrompt: optionalText(input.sourcePrompt, 4_000),
    sourceCount: readCount(input.sourceCount),
    status: "watching",
    subject: readRequiredText(input.subject, "Subject", 1_000),
    summary: readRequiredText(input.summary, "Summary", 4_000),
    title: readRequiredText(input.title, "Title", 500),
  };
}

function rowToAlphaWatchlistItem(row: AlphaWatchlistRow): AlphaWatchlistItem {
  return {
    addedAt: row.added_at,
    agentId: row.agent_id ?? undefined,
    caveat: row.caveat,
    chain: row.chain,
    decisionHash: row.decision_hash ?? undefined,
    decisionId: row.decision_id ?? undefined,
    evidenceUri: row.evidence_uri ?? undefined,
    explorerUrl: row.explorer_url ?? undefined,
    gapCount: row.gap_count,
    id: row.id,
    intent: row.intent,
    note: row.note ?? undefined,
    priority: row.priority,
    proofTx: row.proof_tx ?? undefined,
    recommendation: row.recommendation,
    reviewedAt: row.reviewed_at ?? undefined,
    sessionId: row.session_id ?? undefined,
    signalType: row.signal_type,
    snoozedUntil: row.snoozed_until ?? undefined,
    sourcePrompt: row.source_prompt ?? undefined,
    sourceCount: row.source_count,
    status: row.status,
    subject: row.subject,
    summary: row.summary,
    title: row.title,
  };
}

export function normalizeAlphaWatchlistMetadataInput(
  input: AlphaWatchlistMetadataInput,
  now = new Date()
): AlphaWatchlistUpdate {
  const patch: AlphaWatchlistUpdate = {};

  if (Object.hasOwn(input, "note")) {
    patch.note = optionalText(input.note, 8_000) ?? null;
  }

  if (Object.hasOwn(input, "priority")) {
    patch.priority = readEnum(
      input.priority,
      "Priority",
      ["low", "medium", "high"] as const
    );
  }

  if (Object.hasOwn(input, "status")) {
    const status = readEnum(
      input.status,
      "Status",
      ["watching", "reviewed", "snoozed", "stale"] as const
    );
    patch.status = status;

    if (status === "snoozed") {
      patch.snoozed_until = readSnoozedUntil(input.snoozedUntil, now);
    } else {
      patch.snoozed_until = null;
    }

    patch.reviewed_at = status === "reviewed" ? now.toISOString() : null;
  } else if (Object.hasOwn(input, "snoozedUntil")) {
    throw new WatchlistHttpError(
      400,
      "Snooze time requires the snoozed status."
    );
  }

  return patch;
}

function isMissingSessionIdColumnError(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const details = [
    "code" in error ? error.code : undefined,
    "message" in error ? error.message : undefined,
    "details" in error ? error.details : undefined,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ");

  return /session_id/i.test(details) && /PGRST204|column|schema cache/i.test(details);
}

function readRequiredText(value: unknown, label: string, maxLength: number) {
  if (typeof value !== "string") {
    throw new WatchlistHttpError(400, `${label} is required.`);
  }

  const text = value.trim().replace(/\s+/g, " ");

  if (!text) {
    throw new WatchlistHttpError(400, `${label} is required.`);
  }

  return text.slice(0, maxLength);
}

function optionalText(value: unknown, maxLength = 500) {
  if (typeof value !== "string") {
    return undefined;
  }

  const text = value.trim();

  return text ? text.slice(0, maxLength) : undefined;
}

function readCount(value: unknown) {
  const parsed =
    typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);

  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

function readEnum<const T extends readonly string[]>(
  value: unknown,
  label: string,
  allowed: T
): T[number] {
  if (typeof value === "string" && allowed.some((option) => option === value)) {
    return value as T[number];
  }

  throw new WatchlistHttpError(
    400,
    `${label} must be one of: ${allowed.join(", ")}.`
  );
}

function readSnoozedUntil(value: unknown, now: Date) {
  const fallback = new Date(now.getTime() + 24 * 60 * 60 * 1_000);

  if (typeof value !== "string") {
    return fallback.toISOString();
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime()) || date.getTime() <= now.getTime()) {
    throw new WatchlistHttpError(400, "Snooze time must be in the future.");
  }

  return date.toISOString();
}

function readIsoDate(value: unknown) {
  if (typeof value === "string") {
    const date = new Date(value);

    if (!Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  }

  return new Date().toISOString();
}
