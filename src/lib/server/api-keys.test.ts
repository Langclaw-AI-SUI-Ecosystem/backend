import assert from "node:assert/strict";
import test from "node:test";

import {
  generateApiKeySecret,
  hashApiKeySecret,
  maskApiKey,
  verifyApiKeyHash,
} from "./api-keys";

test("generates Langclaw API keys with live prefix", () => {
  const secret = generateApiKeySecret(Buffer.alloc(32, 1));

  assert.match(secret, /^lck_live_[A-Za-z0-9_-]+$/);
});

test("hashes and verifies API keys with a pepper", () => {
  const secret = generateApiKeySecret(Buffer.alloc(32, 2));
  const hash = hashApiKeySecret(secret, "test-pepper");

  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(verifyApiKeyHash(secret, hash, "test-pepper"), true);
  assert.equal(verifyApiKeyHash(`${secret}x`, hash, "test-pepper"), false);
  assert.equal(verifyApiKeyHash(secret, hash, "wrong-pepper"), false);
});

test("masks API keys without exposing the full secret", () => {
  assert.equal(maskApiKey("lck_live_ab1", "9xyz12"), "lck_live_ab1********9xyz12");
});
