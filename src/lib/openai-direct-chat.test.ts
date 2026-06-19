import assert from "node:assert/strict";
import test from "node:test";

import { buildLocalFallback } from "./openai-direct-chat";

test("direct chat fallback uses Spanish for a Spanish prompt", () => {
  assert.match(
    buildLocalFallback("hola, puedes ayudarme", []),
    /puedo ayudarte|cómo puedo ayudarte/i
  );
});

test("direct chat fallback inherits Indonesian for an ambiguous follow-up", () => {
  assert.match(
    buildLocalFallback("MNT 5000 Agni", [
      {
        role: "user",
        content: "tolong analisis protokol ini",
      },
    ]),
    /belum bisa menghubungi model chat/i
  );
});

test("direct chat fallback uses Japanese for a Japanese prompt", () => {
  assert.match(
    buildLocalFallback("スマートマネーを探して", []),
    /チャットモデル/
  );
});
