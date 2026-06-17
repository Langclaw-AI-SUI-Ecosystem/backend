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
  proofTx?: string;
  recommendation: string;
  signalType: string;
  sourceCount: number;
  subject: string;
  summary: string;
  title: string;
};

export type AlphaWatchlistInput = Partial<AlphaWatchlistItem>;

type AlphaWatchlistRow =
  Database["public"]["Tables"]["langclaw_alpha_watchlist"]["Row"];
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
  const { data, error } = await context.supabase
    .from("langclaw_alpha_watchlist")
    .upsert(
      {
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
        signal_type: item.signalType,
        source_count: item.sourceCount,
        subject: item.subject,
        summary: item.summary,
        title: item.title,
        wallet_user_id: context.walletUser.id,
      },
      { onConflict: "wallet_user_id,id" }
    )
    .select("*")
    .single();

  if (error || !data) {
    throw new WatchlistHttpError(
      500,
      error?.message || "Unable to save alpha watchlist item."
    );
  }

  return rowToAlphaWatchlistItem(data);
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
    proofTx: optionalText(input.proofTx, 160),
    recommendation: readRequiredText(input.recommendation, "Recommendation", 4_000),
    signalType: readRequiredText(input.signalType, "Signal type", 120),
    sourceCount: readCount(input.sourceCount),
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
    proofTx: row.proof_tx ?? undefined,
    recommendation: row.recommendation,
    signalType: row.signal_type,
    sourceCount: row.source_count,
    subject: row.subject,
    summary: row.summary,
    title: row.title,
  };
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

function readIsoDate(value: unknown) {
  if (typeof value === "string") {
    const date = new Date(value);

    if (!Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  }

  return new Date().toISOString();
}
