import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "../supabase/database.types";

type Supabase = SupabaseClient<Database>;
type ApiKeyRow = Database["public"]["Tables"]["langclaw_api_keys"]["Row"];

export type ApiKeyMetadata = {
  id: string;
  name: string;
  prefix: string;
  suffix: string;
  maskedKey: string;
  status: "active" | "revoked";
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
};

export type AuthenticatedApiKey = {
  id: string;
  name: string;
  walletAddress: string;
  walletUserId: string;
};

export class ApiKeyHttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const keyPrefix = "lck_live_";
const displayPrefixLength = 12;
const displaySuffixLength = 6;

export function generateApiKeySecret(bytes: Buffer = randomBytes(32)) {
  return `${keyPrefix}${bytes.toString("base64url")}`;
}

export function hashApiKeySecret(
  secret: string,
  pepper = readApiKeyPepper()
) {
  return createHmac("sha256", pepper).update(secret).digest("hex");
}

export function verifyApiKeyHash(
  secret: string,
  expectedHash: string,
  pepper = readApiKeyPepper()
) {
  if (!/^[0-9a-f]{64}$/.test(expectedHash)) {
    return false;
  }

  const actual = Buffer.from(hashApiKeySecret(secret, pepper), "hex");
  const expected = Buffer.from(expectedHash, "hex");

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function createApiKey(
  supabase: Supabase,
  walletUserId: string,
  nameInput: unknown
) {
  const name = readApiKeyName(nameInput);
  const secret = generateApiKeySecret();
  const keyHash = hashApiKeySecret(secret);
  const { data, error } = await supabase.rpc("langclaw_create_api_key", {
    p_key_hash: keyHash,
    p_key_prefix: secret.slice(0, displayPrefixLength),
    p_key_suffix: secret.slice(-displaySuffixLength),
    p_name: name,
    p_wallet_user_id: walletUserId,
  });

  if (error || !data) {
    throw mapApiKeyStorageError(error?.message || "Unable to create API key.");
  }

  return {
    key: rowToApiKeyMetadata(data as ApiKeyRow),
    secret,
  };
}

export async function listApiKeys(supabase: Supabase, walletUserId: string) {
  const { data, error } = await supabase
    .from("langclaw_api_keys")
    .select(
      "id,name,key_prefix,key_suffix,status,last_used_at,revoked_at,created_at"
    )
    .eq("wallet_user_id", walletUserId)
    .order("created_at", { ascending: false })
    .limit(30);

  if (error) {
    throw new ApiKeyHttpError(500, error.message);
  }

  return ((data ?? []) as ApiKeyRow[]).map(rowToApiKeyMetadata);
}

export async function revokeApiKey(
  supabase: Supabase,
  walletUserId: string,
  keyIdInput: unknown
) {
  const keyId = readApiKeyId(keyIdInput);
  const { data, error } = await supabase
    .from("langclaw_api_keys")
    .update({
      revoked_at: new Date().toISOString(),
      status: "revoked",
    })
    .eq("id", keyId)
    .eq("wallet_user_id", walletUserId)
    .select(
      "id,name,key_prefix,key_suffix,status,last_used_at,revoked_at,created_at"
    )
    .maybeSingle();

  if (error) {
    throw new ApiKeyHttpError(500, error.message);
  }

  if (!data) {
    throw new ApiKeyHttpError(404, "API key was not found.");
  }

  return rowToApiKeyMetadata(data as ApiKeyRow);
}

export async function authenticateApiKey(
  request: Request | undefined,
  supabase: Supabase
): Promise<AuthenticatedApiKey | null> {
  const secret = readBearerApiKey(request);

  if (!secret) {
    return null;
  }

  const pepper = readApiKeyPepper();
  const keyHash = hashApiKeySecret(secret, pepper);
  const { data: keyRow, error: keyError } = await supabase
    .from("langclaw_api_keys")
    .select("id,name,key_hash,status,wallet_user_id")
    .eq("key_hash", keyHash)
    .maybeSingle();

  if (keyError) {
    throw new ApiKeyHttpError(500, keyError.message);
  }

  if (
    !keyRow ||
    keyRow.status !== "active" ||
    !verifyApiKeyHash(secret, keyRow.key_hash, pepper)
  ) {
    throw new ApiKeyHttpError(401, "Valid API key is required.");
  }

  const { data: walletUser, error: walletError } = await supabase
    .from("langclaw_wallet_users")
    .select("id,wallet_address")
    .eq("id", keyRow.wallet_user_id)
    .maybeSingle();

  if (walletError) {
    throw new ApiKeyHttpError(500, walletError.message);
  }

  if (!walletUser) {
    throw new ApiKeyHttpError(401, "API key owner was not found.");
  }

  await supabase
    .from("langclaw_api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", keyRow.id)
    .eq("status", "active");

  return {
    id: keyRow.id,
    name: keyRow.name,
    walletAddress: walletUser.wallet_address,
    walletUserId: walletUser.id,
  };
}

export function maskApiKey(prefix: string, suffix: string) {
  return `${prefix}${"*".repeat(8)}${suffix}`;
}

function readApiKeyPepper() {
  const pepper = process.env.LANGCLAW_API_KEY_PEPPER?.trim();

  if (!pepper) {
    throw new ApiKeyHttpError(503, "LANGCLAW_API_KEY_PEPPER is not configured.");
  }

  return pepper;
}

function readBearerApiKey(request: Request | undefined) {
  const auth = request?.headers.get("authorization") || "";

  if (!auth.toLowerCase().startsWith("bearer ")) {
    return "";
  }

  const secret = auth.slice("bearer ".length).trim();

  return secret.startsWith(keyPrefix) ? secret : "";
}

function readApiKeyName(value: unknown) {
  const name = typeof value === "string" ? value.trim() : "";

  if (!name) {
    throw new ApiKeyHttpError(400, "API key name is required.");
  }

  if (name.length > 80) {
    throw new ApiKeyHttpError(400, "API key name must be 80 characters or less.");
  }

  return name;
}

function readApiKeyId(value: unknown) {
  const id = typeof value === "string" ? value.trim() : "";

  if (!id) {
    throw new ApiKeyHttpError(400, "keyId is required.");
  }

  return id;
}

function rowToApiKeyMetadata(row: ApiKeyRow): ApiKeyMetadata {
  return {
    createdAt: row.created_at,
    id: row.id,
    lastUsedAt: row.last_used_at ?? undefined,
    maskedKey: maskApiKey(row.key_prefix, row.key_suffix),
    name: row.name,
    prefix: row.key_prefix,
    revokedAt: row.revoked_at ?? undefined,
    status: row.status,
    suffix: row.key_suffix,
  };
}

function mapApiKeyStorageError(message: string) {
  if (message.includes("max_active_api_keys")) {
    return new ApiKeyHttpError(409, "Maximum active API keys reached.");
  }

  if (message.includes("wallet_user_not_found")) {
    return new ApiKeyHttpError(404, "Wallet user was not found.");
  }

  if (message.toLowerCase().includes("duplicate")) {
    return new ApiKeyHttpError(409, "API key collision. Try again.");
  }

  return new ApiKeyHttpError(500, message);
}
