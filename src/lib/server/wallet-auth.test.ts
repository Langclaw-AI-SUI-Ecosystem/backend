import assert from "node:assert/strict";
import test from "node:test";

import { withEnv } from "../../test/helpers";
import {
  createWalletChallenge,
  normalizeSuiAddress,
  verifyWalletSession,
} from "./wallet-auth";

// @mysten/sui is ESM-only; load it dynamically so this CommonJS-compiled test
// typechecks (no static require of an ESM module).
type Signer = {
  toSuiAddress(): string;
  signPersonalMessage(bytes: Uint8Array): Promise<{ signature: string }>;
};

let cached: { keypair: Signer; suiAddress: string; normalized: string } | null = null;

async function getSigner() {
  if (!cached) {
    const { Ed25519Keypair } = await import("@mysten/sui/keypairs/ed25519");
    const keypair = new Ed25519Keypair() as unknown as Signer;
    const suiAddress = keypair.toSuiAddress();
    cached = { keypair, suiAddress, normalized: normalizeSuiAddress(suiAddress) };
  }

  return cached;
}

async function signSui(keypair: Signer, message: string) {
  const { signature } = await keypair.signPersonalMessage(
    new TextEncoder().encode(message)
  );

  return signature;
}

test("rejects a Sui message that was not bound to a fresh challenge nonce", async () => {
  const { keypair, suiAddress } = await getSigner();
  const message = `Login to Langclaw\nAddress: ${suiAddress}\nTime: ${new Date().toISOString()}`;
  const signature = await signSui(keypair, message);

  const verified = await verifyWalletSession({
    address: suiAddress,
    message,
    signature,
  });

  assert.equal(verified, null);
});

test("verifies a Sui nonce challenge once and issues a short session token", async () => {
  const { keypair, suiAddress, normalized } = await getSigner();
  await withEnv({ LANGCLAW_WALLET_SESSION_SECRET: "test-wallet-secret" }, async () => {
    const challenge = createWalletChallenge({
      address: suiAddress,
      request: new Request("https://api.langclaw.test/api/wallet/challenge"),
    });
    const signature = await signSui(keypair, challenge.message);

    const verified = await verifyWalletSession(
      {
        address: suiAddress,
        message: challenge.message,
        signature,
      },
      { requiredPurpose: "session" }
    );

    assert.equal(verified?.authMethod, "challenge");
    assert.equal(verified?.address, normalized);
    assert.match(verified?.sessionToken ?? "", /^lws_v1\./);

    const session = await verifyWalletSession({
      address: suiAddress,
      sessionToken: verified?.sessionToken,
    });

    assert.equal(session?.authMethod, "session");
    assert.equal(session?.address, normalized);

    const replay = await verifyWalletSession(
      {
        address: suiAddress,
        message: challenge.message,
        signature,
      },
      { requiredPurpose: "session" }
    );

    assert.equal(replay, null);
  });
});

test("accepts a demo signature for local development", async () => {
  const { suiAddress, normalized } = await getSigner();
  await withEnv({ LANGCLAW_ALLOW_DEMO_SIGNATURES: "true" }, async () => {
    const message = `Langclaw Sui wallet ${normalized.slice(2, 14)} private memory session`;

    const verified = await verifyWalletSession(
      { address: suiAddress, message, signature: "demo:local" },
      { requiredPurpose: "session" }
    );

    assert.equal(verified?.authMethod, "challenge");
    assert.equal(verified?.address, normalized);
  });
});

test("API key creation requires a fresh api-key:create challenge", async () => {
  const { keypair, suiAddress } = await getSigner();
  await withEnv({ LANGCLAW_WALLET_SESSION_SECRET: "test-wallet-secret" }, async () => {
    const sessionChallenge = createWalletChallenge({
      address: suiAddress,
      request: new Request("https://api.langclaw.test/api/wallet/challenge"),
    });
    const sessionSignature = await signSui(keypair, sessionChallenge.message);
    const sessionWallet = await verifyWalletSession(
      {
        address: suiAddress,
        message: sessionChallenge.message,
        signature: sessionSignature,
      },
      { requiredPurpose: "session" }
    );

    const sessionAsApiKeyAuth = await verifyWalletSession(
      {
        address: suiAddress,
        sessionToken: sessionWallet?.sessionToken,
      },
      { requireChallenge: true, requiredPurpose: "api-key:create" }
    );

    assert.equal(sessionAsApiKeyAuth, null);

    const apiKeyChallenge = createWalletChallenge({
      address: suiAddress,
      purpose: "api-key:create",
      request: new Request("https://api.langclaw.test/api/wallet/challenge"),
    });
    const apiKeySignature = await signSui(keypair, apiKeyChallenge.message);
    const apiKeyAuth = await verifyWalletSession(
      {
        address: suiAddress,
        message: apiKeyChallenge.message,
        signature: apiKeySignature,
      },
      {
        issueSession: false,
        requireChallenge: true,
        requiredPurpose: "api-key:create",
      }
    );

    assert.equal(apiKeyAuth?.authMethod, "challenge");
    assert.equal(apiKeyAuth?.purpose, "api-key:create");
    assert.equal(apiKeyAuth?.sessionToken, undefined);
  });
});
