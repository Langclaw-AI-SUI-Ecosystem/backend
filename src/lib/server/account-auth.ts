import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "../supabase/database.types";
import {
  getSupabaseAdmin,
  getSupabaseConfigStatus,
} from "../supabase/server";
import {
  ApiKeyHttpError,
  authenticateApiKey,
  type AuthenticatedApiKey,
} from "./api-keys";
import {
  verifyWalletSession,
  type VerifiedWallet,
  type WalletAuthInput,
  type WalletAuthPurpose,
} from "./wallet-auth";

type Supabase = SupabaseClient<Database>;
type WalletAccountOptions = {
  issueSession?: boolean;
  requireChallenge?: boolean;
  requiredPurpose?: WalletAuthPurpose;
};
type TelegramSettingsRow = Pick<
  Database["public"]["Tables"]["langclaw_automation_settings"]["Row"],
  | "telegram_chat_id"
  | "telegram_linked_at"
  | "telegram_username"
  | "telegram_verified"
>;

export type AccountTelegramLinkStatus = {
  chatId?: string;
  linked: boolean;
  linkedAt?: string;
  username?: string;
};

export type WalletUserContext = {
  id: string;
  walletAddress: string;
};

export type AuthenticatedAccount = {
  authMethod: "api_key" | "wallet";
  apiKey?: AuthenticatedApiKey;
  supabase: Supabase;
  wallet?: VerifiedWallet;
  walletUser: WalletUserContext;
};

export type AccountAuthInput = {
  account?: AuthenticatedAccount;
  request?: Request;
  wallet?: WalletAuthInput;
};

export class AccountAuthError extends Error {
  code?: string;
  status: number;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export async function requireAccountAuth(
  input: AccountAuthInput
): Promise<AuthenticatedAccount> {
  if (input.account) {
    return input.account;
  }

  if (hasWalletAuthInput(input.wallet)) {
    return requireWalletAccount(input.wallet ?? {});
  }

  if (!hasApiKeyInput(input.request)) {
    throw new AccountAuthError(401, "Wallet signature or API key is required.");
  }

  const supabase = requireSupabaseAdmin();

  try {
    const apiKey = await authenticateApiKey(input.request, supabase);

    if (apiKey) {
      return {
        apiKey,
        authMethod: "api_key",
        supabase,
        walletUser: {
          id: apiKey.walletUserId,
          walletAddress: apiKey.walletAddress,
        },
      };
    }
  } catch (error) {
    throw mapApiKeyError(error);
  }

  throw new AccountAuthError(401, "Wallet signature or API key is required.");
}

export async function requireWalletAccount(
  walletInput: WalletAuthInput,
  options: WalletAccountOptions = {}
): Promise<AuthenticatedAccount> {
  const wallet = await verifyWalletSession(walletInput, options);

  if (!wallet) {
    throw new AccountAuthError(401, "Wallet signature is required.");
  }

  const supabase = requireSupabaseAdmin();
  const walletUser = await upsertWalletUser(supabase, wallet);

  return {
    authMethod: "wallet",
    supabase,
    wallet,
    walletUser,
  };
}

export async function createVerifiedWalletAccount(
  wallet: VerifiedWallet
): Promise<AuthenticatedAccount> {
  const supabase = requireSupabaseAdmin();
  const walletUser = await upsertWalletUser(supabase, wallet);

  return {
    authMethod: "wallet",
    supabase,
    wallet,
    walletUser,
  };
}

export async function readAccountTelegramLinkStatus(
  account: AuthenticatedAccount
): Promise<AccountTelegramLinkStatus> {
  const { data, error } = await account.supabase
    .from("langclaw_automation_settings")
    .select(
      "telegram_chat_id,telegram_linked_at,telegram_username,telegram_verified"
    )
    .eq("wallet_user_id", account.walletUser.id)
    .maybeSingle();

  if (error) {
    throw new AccountAuthError(
      500,
      error.message || "Unable to read Telegram link status."
    );
  }

  const settings = data as TelegramSettingsRow | null;
  const chatId = settings?.telegram_chat_id?.trim();
  const linked = Boolean(settings?.telegram_verified && chatId);

  return {
    chatId: linked ? chatId : undefined,
    linked,
    linkedAt: linked ? settings?.telegram_linked_at ?? undefined : undefined,
    username: linked ? settings?.telegram_username ?? undefined : undefined,
  };
}

export async function requireTelegramLinkedAccount(
  account: AuthenticatedAccount
): Promise<AuthenticatedAccount> {
  // The Telegram link is an optional automation feature, not a gate on research
  // runs. Enforce it only when explicitly opted in so the Sui+Walrus demo flows
  // with just a wallet signature.
  if (process.env.LANGCLAW_REQUIRE_TELEGRAM !== "true") {
    return account;
  }

  const telegram = await readAccountTelegramLinkStatus(account);

  if (!telegram.linked) {
    throw new AccountAuthError(
      403,
      "Telegram connection is required.",
      "telegram_link_required"
    );
  }

  return account;
}

export function requireSupabaseAdmin() {
  const supabase = getSupabaseAdmin();
  const config = getSupabaseConfigStatus();

  if (!supabase) {
    throw new AccountAuthError(
      503,
      config.hasUrl
        ? "SUPABASE_SERVICE_ROLE_KEY is missing."
        : "Supabase URL and service role key are missing."
    );
  }

  return supabase;
}

export function accountAuthErrorResponse(
  error: unknown,
  payload: Record<string, unknown> = {}
) {
  if (error instanceof AccountAuthError) {
    return Response.json(
      { ...payload, ...(error.code ? { code: error.code } : {}), error: error.message },
      { status: error.status }
    );
  }

  return Response.json(
    {
      ...payload,
      error:
        error instanceof Error ? error.message : "Account authentication failed.",
    },
    { status: 500 }
  );
}

function hasWalletAuthInput(wallet?: WalletAuthInput) {
  return Boolean(
    wallet?.address ||
      wallet?.message ||
      wallet?.sessionToken ||
      wallet?.signature
  );
}

function hasApiKeyInput(request?: Request) {
  const auth = request?.headers.get("authorization") || "";

  return auth.toLowerCase().startsWith("bearer lck_live_");
}

async function upsertWalletUser(
  supabase: Supabase,
  wallet: VerifiedWallet
): Promise<WalletUserContext> {
  const { data, error } = await supabase
    .from("langclaw_wallet_users")
    .upsert(buildWalletUserUpsert(wallet), { onConflict: "wallet_address" })
    .select("id,wallet_address")
    .single();

  if (error || !data) {
    throw new AccountAuthError(
      500,
      error?.message || "Unable to sync wallet session."
    );
  }

  return {
    id: data.id,
    walletAddress: data.wallet_address,
  };
}

function buildWalletUserUpsert(wallet: VerifiedWallet) {
  const payload: {
    last_login_message?: string;
    last_seen_at: string;
    last_signature?: string;
    wallet_address: string;
  } = {
    last_seen_at: new Date().toISOString(),
    wallet_address: wallet.address,
  };

  if (wallet.message && wallet.signature) {
    payload.last_login_message = wallet.message;
    payload.last_signature = wallet.signature;
  }

  return payload;
}

function mapApiKeyError(error: unknown) {
  if (error instanceof ApiKeyHttpError) {
    return new AccountAuthError(error.status, error.message);
  }

  return error;
}
