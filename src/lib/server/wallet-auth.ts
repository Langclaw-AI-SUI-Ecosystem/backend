import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type WalletAuthInput = {
  address?: unknown;
  message?: unknown;
  sessionToken?: unknown;
  signature?: unknown;
};

export type VerifiedWallet = {
  authMethod: "challenge" | "session";
  address: string;
  message?: string;
  purpose?: WalletAuthPurpose;
  sessionExpiresAt?: string;
  sessionToken?: string;
  signature?: string;
};

export type WalletAuthPurpose = "api-key:create" | "session";

export type WalletChallenge = {
  address: string;
  chainId: number;
  domain: string;
  expiresAt: string;
  issuedAt: string;
  message: string;
  network: string;
  nonce: string;
  purpose: WalletAuthPurpose;
  uri: string;
};

type WalletChallengeRecord = WalletChallenge & {
  expiresAtMs: number;
};

type VerifyWalletSessionOptions = {
  issueSession?: boolean;
  requireChallenge?: boolean;
  requiredPurpose?: WalletAuthPurpose;
};

type WalletSessionPayload = {
  address: string;
  exp: number;
  iat: number;
  v: 1;
};

export class WalletAuthError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const WALLET_LOGIN_STATEMENT = "Login to Langclaw";
const WALLET_AUTH_VERSION = "1";
// Sui has no numeric chain id; this field is retained for API back-compat only.
const SUI_CHAIN_ID_PLACEHOLDER = 0;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SESSION_TOKEN_PREFIX = "lws_v1";
const allowedPurposes = new Set<WalletAuthPurpose>([
  "api-key:create",
  "session",
]);
const challenges = new Map<string, WalletChallengeRecord>();

export function createWalletChallenge({
  address,
  chainId,
  purpose,
  request,
}: {
  address: unknown;
  chainId?: unknown;
  purpose?: unknown;
  request: Request;
}): WalletChallenge {
  const suiAddress = readSuiAddressOrThrow(address);
  const challengePurpose = readPurpose(purpose);
  const challengeChainId = readChainId(chainId);
  const network = readSuiNetwork(process.env.SUI_NETWORK);
  const now = Date.now();
  const issuedAt = new Date(now).toISOString();
  const expiresAtMs = now + CHALLENGE_TTL_MS;
  const expiresAt = new Date(expiresAtMs).toISOString();
  const nonce = randomBytes(16).toString("hex");
  const { domain, uri } = readRequestDomain(request);
  const message = [
    `${domain} wants you to sign in with your Sui account:`,
    suiAddress,
    "",
    WALLET_LOGIN_STATEMENT,
    "",
    `URI: ${uri}`,
    `Version: ${WALLET_AUTH_VERSION}`,
    `Network: ${network}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expiration Time: ${expiresAt}`,
    `Purpose: ${challengePurpose}`,
  ].join("\n");
  const challenge: WalletChallengeRecord = {
    address: suiAddress,
    chainId: challengeChainId,
    domain,
    expiresAt,
    expiresAtMs,
    issuedAt,
    message,
    network,
    nonce,
    purpose: challengePurpose,
    uri,
  };

  pruneExpiredChallenges(now);
  challenges.set(nonce, challenge);

  return publicChallenge(challenge);
}

export async function verifyWalletSession(
  wallet: WalletAuthInput,
  options: VerifyWalletSessionOptions = {}
): Promise<VerifiedWallet | null> {
  const address = normalizeWalletInputAddress(wallet.address);

  if (!address) {
    return null;
  }

  if (typeof wallet.sessionToken === "string") {
    if (options.requireChallenge) {
      return null;
    }

    return verifyWalletSessionToken(address, wallet.sessionToken);
  }

  if (
    typeof wallet.message !== "string" ||
    typeof wallet.signature !== "string"
  ) {
    return null;
  }

  const message = wallet.message;
  const signature = wallet.signature;

  // Demo signatures: a local-dev convenience that skips cryptographic
  // verification but still binds the signed message to the wallet. Enabled
  // unless LANGCLAW_ALLOW_DEMO_SIGNATURES is explicitly "false".
  if (signature.startsWith("demo:")) {
    if (process.env.LANGCLAW_ALLOW_DEMO_SIGNATURES === "false") {
      return null;
    }

    if (!message.toLowerCase().includes(address.slice(2, 14))) {
      return null;
    }

    const nonce = readMessageField(message, "Nonce");

    if (nonce) {
      // Best-effort: consume a matching challenge if one was issued, so the
      // web flow stays single-use; raw demo calls without a challenge still pass.
      consumeChallenge(nonce);
    }

    return {
      authMethod: "challenge",
      address,
      message,
      purpose: options.requiredPurpose ?? "session",
      ...issueSession(address, options),
      signature,
    };
  }

  const nonce = readMessageField(message, "Nonce");

  if (!nonce) {
    return null;
  }

  const challenge = consumeChallenge(nonce);

  if (!challenge) {
    return null;
  }

  if (
    challenge.address !== address ||
    challenge.message !== message ||
    (options.requiredPurpose && challenge.purpose !== options.requiredPurpose)
  ) {
    return null;
  }

  const valid = await verifySuiSignature(address, message, signature);

  if (!valid) {
    return null;
  }

  return {
    authMethod: "challenge",
    address,
    message,
    purpose: challenge.purpose,
    ...issueSession(address, options),
    signature,
  };
}

export function createWalletSessionForVerifiedAddress(address: string): VerifiedWallet {
  const suiAddress = readSuiAddressOrThrow(address);

  return {
    address: suiAddress,
    authMethod: "session",
    purpose: "session",
    ...issueSession(suiAddress, { requiredPurpose: "session" }),
  };
}

async function verifySuiSignature(
  address: string,
  message: string,
  signature: string
): Promise<boolean> {
  try {
    const verifier = (await import("@mysten/sui/verify")) as {
      verifyPersonalMessageSignature: (
        message: Uint8Array,
        signature: string
      ) => Promise<{ toSuiAddress: () => string }>;
    };
    const publicKey = await verifier.verifyPersonalMessageSignature(
      new TextEncoder().encode(message),
      signature
    );

    return normalizeSuiAddress(publicKey.toSuiAddress()) === address;
  } catch {
    return false;
  }
}

function verifyWalletSessionToken(
  address: string,
  sessionToken: string
): VerifiedWallet | null {
  const payload = parseSessionToken(sessionToken);

  if (!payload || payload.address !== address) {
    return null;
  }

  return {
    address: payload.address,
    authMethod: "session",
    purpose: "session",
    sessionExpiresAt: new Date(payload.exp).toISOString(),
    sessionToken,
  };
}

function issueSession(
  address: string,
  options: VerifyWalletSessionOptions
) {
  if (options.issueSession === false || options.requiredPurpose !== "session") {
    return {};
  }

  const issuedAtMs = Date.now();
  const expiresAtMs = issuedAtMs + SESSION_TTL_MS;
  const sessionToken = createSessionToken({
    address,
    exp: expiresAtMs,
    iat: issuedAtMs,
    v: 1,
  });

  return {
    sessionExpiresAt: new Date(expiresAtMs).toISOString(),
    sessionToken,
  };
}

function createSessionToken(payload: WalletSessionPayload) {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
    "base64url"
  );
  const signature = signSessionPayload(encodedPayload);

  return `${SESSION_TOKEN_PREFIX}.${encodedPayload}.${signature}`;
}

function parseSessionToken(token: string): WalletSessionPayload | null {
  const parts = token.split(".");

  if (parts.length !== 3 || parts[0] !== SESSION_TOKEN_PREFIX) {
    return null;
  }

  const [, encodedPayload, signature] = parts;
  const expectedSignature = signSessionPayload(encodedPayload);

  if (!safeEqual(signature, expectedSignature)) {
    return null;
  }

  let payload: WalletSessionPayload;

  try {
    payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8")
    ) as WalletSessionPayload;
  } catch {
    return null;
  }

  if (
    payload.v !== 1 ||
    typeof payload.address !== "string" ||
    typeof payload.iat !== "number" ||
    typeof payload.exp !== "number" ||
    payload.exp <= Date.now() ||
    payload.iat - Date.now() > 5 * 60 * 1000
  ) {
    return null;
  }

  try {
    return {
      ...payload,
      address: normalizeSuiAddress(payload.address),
    };
  } catch {
    return null;
  }
}

function signSessionPayload(encodedPayload: string) {
  return createHmac("sha256", readSessionSecret())
    .update(encodedPayload)
    .digest("base64url");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function readSessionSecret() {
  const explicit = process.env.LANGCLAW_WALLET_SESSION_SECRET?.trim();

  if (process.env.NODE_ENV === "production") {
    if (!explicit) {
      throw new WalletAuthError(
        503,
        "LANGCLAW_WALLET_SESSION_SECRET is required."
      );
    }

    return explicit;
  }

  const fallback =
    explicit ||
    process.env.LANGCLAW_API_KEY_PEPPER?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (fallback) {
    return fallback;
  }

  return "langclaw-dev-wallet-session-secret";
}

function consumeChallenge(nonce: string) {
  pruneExpiredChallenges();
  const challenge = challenges.get(nonce);

  if (!challenge) {
    return null;
  }

  challenges.delete(nonce);

  if (challenge.expiresAtMs <= Date.now()) {
    return null;
  }

  return challenge;
}

function pruneExpiredChallenges(now = Date.now()) {
  for (const [nonce, challenge] of challenges) {
    if (challenge.expiresAtMs <= now) {
      challenges.delete(nonce);
    }
  }
}

function publicChallenge(challenge: WalletChallengeRecord): WalletChallenge {
  return {
    address: challenge.address,
    chainId: challenge.chainId,
    domain: challenge.domain,
    expiresAt: challenge.expiresAt,
    issuedAt: challenge.issuedAt,
    message: challenge.message,
    network: challenge.network,
    nonce: challenge.nonce,
    purpose: challenge.purpose,
    uri: challenge.uri,
  };
}

/** Normalize a Sui address to lowercase 0x + 64 hex chars, throwing on bad input. */
export function normalizeSuiAddress(input: unknown): string {
  if (typeof input !== "string") {
    throw new WalletAuthError(400, "A valid Sui wallet address is required.");
  }

  const trimmed = input.trim().toLowerCase();
  const hex = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;

  if (!/^[0-9a-f]{1,64}$/.test(hex)) {
    throw new WalletAuthError(400, "A valid Sui wallet address is required.");
  }

  return `0x${hex.padStart(64, "0")}`;
}

function readSuiAddressOrThrow(value: unknown) {
  return normalizeSuiAddress(value);
}

function normalizeWalletInputAddress(value: unknown) {
  try {
    return normalizeSuiAddress(value);
  } catch {
    return null;
  }
}

function readPurpose(value: unknown): WalletAuthPurpose {
  if (value === undefined || value === null || value === "") {
    return "session";
  }

  if (typeof value === "string" && allowedPurposes.has(value as WalletAuthPurpose)) {
    return value as WalletAuthPurpose;
  }

  throw new WalletAuthError(400, "Unsupported wallet auth purpose.");
}

function readChainId(value: unknown) {
  if (value === undefined || value === null || value === "") {
    return SUI_CHAIN_ID_PLACEHOLDER;
  }

  const chainId = typeof value === "number" ? value : Number(value);

  if (!Number.isSafeInteger(chainId) || chainId < 0) {
    return SUI_CHAIN_ID_PLACEHOLDER;
  }

  return chainId;
}

function readSuiNetwork(value: string | undefined) {
  const cleaned = value?.trim();

  if (
    cleaned === "mainnet" ||
    cleaned === "testnet" ||
    cleaned === "devnet" ||
    cleaned === "localnet"
  ) {
    return cleaned;
  }

  return "mainnet";
}

function readRequestDomain(request: Request) {
  const configuredDomain = process.env.LANGCLAW_WALLET_AUTH_DOMAIN?.trim();
  const url = new URL(request.url);
  const domain = configuredDomain || url.host;
  const uri = `${url.protocol}//${domain}`;

  return { domain, uri };
}

function readMessageField(message: string, field: string) {
  return message
    .split("\n")
    .find((line) => line.startsWith(`${field}: `))
    ?.replace(`${field}: `, "")
    .trim();
}
