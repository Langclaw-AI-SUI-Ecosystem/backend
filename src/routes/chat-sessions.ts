import type { ChatSession, StoredChatMessage } from "../lib/chat-sessions";
import {
  accountAuthErrorResponse,
  requireAccountAuth,
} from "../lib/server/account-auth";
import type { WalletAuthInput } from "../lib/server/wallet-auth";
import type { Json } from "../lib/supabase/database.types";
import {
  getSupabaseAdmin,
  getSupabaseConfigStatus,
} from "../lib/supabase/server";

type ChatSessionsBody = {
  action?: unknown;
  pinned?: unknown;
  wallet?: WalletAuthInput;
  sessionId?: unknown;
  session?: unknown;
  title?: unknown;
};

type ChatSessionRow = {
  id: string;
  title: string;
  pinned: boolean | null;
  created_at: string;
  updated_at: string;
};

type ChatMessageRow = {
  id: string;
  role: "assistant" | "user";
  content: string;
  chain: "sui-testnet" | "sui-mainnet" | null;
  mode: "chat" | "onchain" | "research" | null;
  model: string | null;
  result: Json | null;
  direct_answer: Json | null;
  onchain_result: Json | null;
  progress_events: Json | null;
  error: string | null;
  stopped: boolean | null;
  created_at: string;
};

export async function handleChatSessions(request: Request) {
  const supabase = getSupabaseAdmin();
  const config = getSupabaseConfigStatus();

  if (!supabase) {
    return Response.json({
      configured: false,
      error: config.hasUrl
        ? "SUPABASE_SERVICE_ROLE_KEY is missing."
        : "Supabase URL and service role key are missing.",
    });
  }

  let body: ChatSessionsBody;

  try {
    body = (await request.json()) as ChatSessionsBody;
  } catch {
    return Response.json(
      { configured: true, error: "Request body must be valid JSON." },
      { status: 400 }
    );
  }

  const account = await requireAccountAuth({
    request,
    wallet: body.wallet ?? {},
  }).catch((error) => ({ error }));

  if ("error" in account) {
    return accountAuthErrorResponse(account.error, { configured: true });
  }

  const walletUserId = account.walletUser.id;

  if (body.action === "list") {
    const { data, error } = await supabase
      .from("langclaw_chat_sessions")
      .select("id,title,pinned,created_at,updated_at")
      .eq("wallet_user_id", walletUserId)
      .order("updated_at", { ascending: false })
      .limit(40);

    if (error) {
      return Response.json(
        { configured: true, error: error.message },
        { status: 500 }
      );
    }

    return Response.json({
      configured: true,
      sessions: ((data ?? []) as ChatSessionRow[]).map((row) =>
        rowToSession(row)
      ),
    });
  }

  if (body.action === "get") {
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";

    if (!sessionId) {
      return Response.json(
        { configured: true, error: "sessionId is required." },
        { status: 400 }
      );
    }

    const session = await readSession(walletUserId, sessionId);

    return Response.json({
      configured: true,
      session,
    });
  }

  if (body.action === "delete") {
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";

    if (!sessionId) {
      return Response.json(
        { configured: true, error: "sessionId is required." },
        { status: 400 }
      );
    }

    const existing = await readSessionOwner(sessionId);

    if (existing && existing.wallet_user_id !== walletUserId) {
      return Response.json(
        { configured: true, error: "Session belongs to another wallet." },
        { status: 403 }
      );
    }

    if (existing) {
      const deleted = await deleteSession(walletUserId, sessionId);

      if (!deleted) {
        return Response.json(
          { configured: true, error: "Unable to delete chat session." },
          { status: 500 }
        );
      }
    }

    return Response.json({
      configured: true,
      deleted: true,
    });
  }

  if (body.action === "update") {
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";

    if (!sessionId) {
      return Response.json(
        { configured: true, error: "sessionId is required." },
        { status: 400 }
      );
    }

    const titleResult = readOptionalTitle(body.title);
    const hasPinned = typeof body.pinned === "boolean";

    if (titleResult.error) {
      return Response.json(
        { configured: true, error: titleResult.error },
        { status: 400 }
      );
    }

    if (titleResult.value === undefined && !hasPinned) {
      return Response.json(
        { configured: true, error: "title or pinned is required." },
        { status: 400 }
      );
    }

    const existing = await readSessionOwner(sessionId);

    if (!existing) {
      return Response.json(
        { configured: true, error: "Chat session was not found." },
        { status: 404 }
      );
    }

    if (existing.wallet_user_id !== walletUserId) {
      return Response.json(
        { configured: true, error: "Session belongs to another wallet." },
        { status: 403 }
      );
    }

    const saved = await updateSessionMetadata(walletUserId, sessionId, {
      pinned: hasPinned ? body.pinned === true : undefined,
      title: titleResult.value,
    });

    if (!saved) {
      return Response.json(
        { configured: true, error: "Unable to update chat session." },
        { status: 500 }
      );
    }

    return Response.json({
      configured: true,
      session: saved,
    });
  }

  if (body.action === "upsert") {
    const session = normalizeSession(body.session);

    if (!session) {
      return Response.json(
        { configured: true, error: "A valid session is required." },
        { status: 400 }
      );
    }

    const existing = await readSessionOwner(session.id);

    if (existing && existing.wallet_user_id !== walletUserId) {
      return Response.json(
        { configured: true, error: "Session belongs to another wallet." },
        { status: 403 }
      );
    }

    const saved = await upsertSession(walletUserId, session);

    if (!saved) {
      return Response.json(
        { configured: true, error: "Unable to save chat session." },
        { status: 500 }
      );
    }

    if (session.messages.some((message) => message.result)) {
      await upsertResearchRuns(walletUserId, session);
    }

    return Response.json({
      configured: true,
      session: saved,
    });
  }

  return Response.json(
    { configured: true, error: "Unsupported action." },
    { status: 400 }
  );
}

async function readSessionOwner(sessionId: string) {
  const supabase = getSupabaseAdmin();

  if (!supabase) {
    return null;
  }

  const { data, error } = await supabase
    .from("langclaw_chat_sessions")
    .select("wallet_user_id")
    .eq("id", sessionId)
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  return data as { wallet_user_id: string };
}

async function readSession(walletUserId: string, sessionId: string) {
  const supabase = getSupabaseAdmin();

  if (!supabase) {
    return null;
  }

  const { data: sessionRow, error: sessionError } = await supabase
    .from("langclaw_chat_sessions")
    .select("id,title,pinned,created_at,updated_at")
    .eq("wallet_user_id", walletUserId)
    .eq("id", sessionId)
    .maybeSingle();

  if (sessionError || !sessionRow) {
    return null;
  }

  const messages = supabase.from("langclaw_chat_messages") as ReturnType<
    typeof supabase.from
  > & {
    insert: (values: unknown) => any;
    select: (columns: string) => any;
  };

  const { data: messageRows, error: messagesError } = await messages
    .select(
      "id,role,content,chain,mode,model,result,direct_answer,onchain_result,progress_events,error,stopped,created_at"
    )
    .eq("wallet_user_id", walletUserId)
    .eq("session_id", sessionId)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });

  if (messagesError) {
    return rowToSession(sessionRow as ChatSessionRow);
  }

  return rowToSession(
    sessionRow as ChatSessionRow,
    ((messageRows ?? []) as unknown as ChatMessageRow[]).map(rowToMessage)
  );
}

async function upsertSession(walletUserId: string, session: ChatSession) {
  const supabase = getSupabaseAdmin();

  if (!supabase) {
    return null;
  }

  const { error: sessionError } = await supabase
    .from("langclaw_chat_sessions")
    .upsert(
      {
        created_at: session.createdAt,
        id: session.id,
        pinned: Boolean(session.pinned),
        title: session.title,
        updated_at: session.updatedAt,
        wallet_user_id: walletUserId,
      },
      { onConflict: "id" }
    );

  if (sessionError) {
    return null;
  }

  const { error: deleteError } = await supabase
    .from("langclaw_chat_messages")
    .delete()
    .eq("wallet_user_id", walletUserId)
    .eq("session_id", session.id);

  if (deleteError) {
    return null;
  }

  if (session.messages.length) {
    const messages = supabase.from("langclaw_chat_messages") as ReturnType<
      typeof supabase.from
    > & {
      insert: (values: unknown) => any;
    };
    const { error: insertError } = await messages
      .insert(
        session.messages.map((message, position) => ({
          content: message.content,
          chain: message.chain ?? null,
          created_at: session.updatedAt,
          direct_answer: toJson(message.directAnswer),
          error: message.error ?? null,
          id: message.id,
          mode: message.mode ?? null,
          model: message.model ?? null,
          onchain_result: toJson(message.onChain),
          position,
          progress_events: toJson(message.progressEvents),
          result: toJson(message.result),
          role: message.role,
          session_id: session.id,
          stopped: Boolean(message.stopped),
          wallet_user_id: walletUserId,
        }))
      );

    if (insertError) {
      return null;
    }
  }

  return readSession(walletUserId, session.id);
}

async function deleteSession(walletUserId: string, sessionId: string) {
  const supabase = getSupabaseAdmin();

  if (!supabase) {
    return false;
  }

  const { error } = await supabase
    .from("langclaw_chat_sessions")
    .delete()
    .eq("wallet_user_id", walletUserId)
    .eq("id", sessionId);

  return !error;
}

async function updateSessionMetadata(
  walletUserId: string,
  sessionId: string,
  patch: {
    pinned?: boolean;
    title?: string;
  }
) {
  const supabase = getSupabaseAdmin();

  if (!supabase) {
    return null;
  }

  const updates: {
    pinned?: boolean;
    title?: string;
  } = {};

  if (patch.title !== undefined) {
    updates.title = patch.title;
  }

  if (patch.pinned !== undefined) {
    updates.pinned = patch.pinned;
  }

  const { data, error } = await supabase
    .from("langclaw_chat_sessions")
    .update(updates)
    .eq("wallet_user_id", walletUserId)
    .eq("id", sessionId)
    .select("id,title,pinned,created_at,updated_at")
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  return rowToSession(data as ChatSessionRow);
}

async function upsertResearchRuns(walletUserId: string, session: ChatSession) {
  const supabase = getSupabaseAdmin();

  if (!supabase) {
    return;
  }

  const rows = session.messages
    .filter((message) => message.role === "assistant" && message.result)
    .map((message) => ({
      message_id: message.id,
      proof: toJson(message.result?.proof ?? message.result?.zeroG),
      result: toJson(message.result),
      session_id: session.id,
      topic: message.result?.topic ?? session.title,
      wallet_user_id: walletUserId,
    }));

  if (!rows.length) {
    return;
  }

  await supabase.from("langclaw_research_runs").upsert(rows, {
    onConflict: "message_id",
  });
}

function rowToSession(
  row: ChatSessionRow,
  messages: StoredChatMessage[] = []
): ChatSession {
  return {
    createdAt: row.created_at,
    id: row.id,
    messages,
    pinned: Boolean(row.pinned),
    title: row.title,
    updatedAt: row.updated_at,
  };
}

function rowToMessage(row: ChatMessageRow): StoredChatMessage {
  return {
    content: row.content,
    chain: row.chain ?? undefined,
    directAnswer:
      (row.direct_answer as StoredChatMessage["directAnswer"]) ?? undefined,
    error: row.error ?? undefined,
    id: row.id,
    mode: row.mode ?? undefined,
    model: row.model ?? undefined,
    onChain: (row.onchain_result as StoredChatMessage["onChain"]) ?? undefined,
    progressEvents:
      (row.progress_events as StoredChatMessage["progressEvents"]) ?? undefined,
    result: (row.result as StoredChatMessage["result"]) ?? undefined,
    role: row.role,
    stopped: Boolean(row.stopped),
  };
}

function normalizeSession(value: unknown): ChatSession | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const session = value as Partial<ChatSession>;

  if (
    typeof session.id !== "string" ||
    typeof session.title !== "string" ||
    typeof session.createdAt !== "string" ||
    typeof session.updatedAt !== "string" ||
    !Array.isArray(session.messages)
  ) {
    return null;
  }

  const messages = session.messages
    .map(normalizeMessage)
    .filter((message): message is StoredChatMessage => Boolean(message));

  return {
    createdAt: session.createdAt,
    id: session.id,
    messages,
    pinned: Boolean(session.pinned),
    title: session.title,
    updatedAt: session.updatedAt,
  };
}

function toJson(value: unknown): Json | null {
  if (value === undefined || value === null) {
    return null;
  }

  return JSON.parse(JSON.stringify(value)) as Json;
}

function readOptionalTitle(value: unknown): { error?: string; value?: string } {
  if (value === undefined) {
    return {};
  }

  if (typeof value !== "string") {
    return { error: "title must be a string." };
  }

  const title = value.trim().replace(/\s+/g, " ");

  if (!title) {
    return { error: "title cannot be empty." };
  }

  return { value: title.length > 120 ? `${title.slice(0, 117)}...` : title };
}

function normalizeMessage(value: unknown): StoredChatMessage | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const message = value as Partial<StoredChatMessage>;

  if (
    typeof message.id !== "string" ||
    (message.role !== "assistant" && message.role !== "user") ||
    typeof message.content !== "string"
  ) {
    return null;
  }

  return {
    content: message.content,
    directAnswer: message.directAnswer,
    error: typeof message.error === "string" ? message.error : undefined,
    id: message.id,
    mode:
      message.mode === "chat" ||
      message.mode === "onchain" ||
      message.mode === "research"
        ? message.mode
        : undefined,
    model: typeof message.model === "string" ? message.model : undefined,
    onChain: message.onChain,
    progressEvents: Array.isArray(message.progressEvents)
      ? message.progressEvents
      : undefined,
    result: message.result,
    role: message.role,
    stopped: Boolean(message.stopped),
  };
}
