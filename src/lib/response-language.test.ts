import assert from "node:assert/strict";
import test from "node:test";

import {
  detectResponseLanguage,
  resolveResponseLanguage,
} from "./response-language";

test("detectResponseLanguage prefers Indonesian for casual mixed prompts", () => {
  const result = detectResponseLanguage(
    "kok response nya jelek ya, bisa bantu fix smart-money Mantle gak?"
  );

  assert.equal(result.label, "Indonesian");
  assert.equal(result.confidence, "high");
  assert.match(result.instruction, /Write all user-visible prose in Indonesian/);
});

test("detectResponseLanguage detects English research prompts", () => {
  const result = detectResponseLanguage(
    "Find smart-money accumulation on Mantle"
  );

  assert.equal(result.label, "English");
  assert.equal(result.confidence, "medium");
});

test("detectResponseLanguage detects non-Latin scripts", () => {
  assert.equal(detectResponseLanguage("スマートマネーを探して").label, "Japanese");
  assert.equal(
    detectResponseLanguage("ابحث عن تدفقات المحافظ").label,
    "the user's Arabic-script language"
  );
  assert.equal(detectResponseLanguage("스마트머니 흐름을 찾아줘").label, "Korean");
  assert.equal(detectResponseLanguage("ค้นหาการสะสมของวอลเล็ต").label, "Thai");
});

test("detectResponseLanguage detects common Latin language markers", () => {
  assert.equal(detectResponseLanguage("hola, puedes buscar señales").label, "Spanish");
  assert.equal(detectResponseLanguage("bonjour, peux-tu chercher").label, "French");
  assert.equal(detectResponseLanguage("olá, você pode procurar").label, "Portuguese");
  assert.equal(detectResponseLanguage("merhaba, lütfen bul").label, "Turkish");
});

test("detectResponseLanguage falls back to latest user language instruction", () => {
  const result = detectResponseLanguage("MNT 5000 Agni");

  assert.equal(result.label, "the user's language");
  assert.equal(result.confidence, "low");
  assert.match(
    result.instruction,
    /same language used by the latest user message/
  );
});

test("resolveResponseLanguage inherits an unambiguous prior user language", () => {
  const result = resolveResponseLanguage("MNT 5000 Agni", [
    {
      role: "user",
      content: "tolong bandingkan protokol ini dengan data sebelumnya",
    },
    {
      role: "assistant",
      content: "I can compare the protocols.",
    },
  ]);

  assert.equal(result.label, "Indonesian");
  assert.equal(result.code, "id");
  assert.equal(result.confidence, "medium");
});

test("resolveResponseLanguage follows the latest explicit language request", () => {
  const result = resolveResponseLanguage(
    "tolong jawab dalam bahasa Inggris",
    [
      {
        role: "user",
        content: "jelaskan hasil sebelumnya dalam bahasa Indonesia",
      },
    ]
  );

  assert.equal(result.label, "English");
  assert.equal(result.code, "en");
  assert.equal(result.confidence, "high");
});

test("detectResponseLanguage recognizes a native explicit language request", () => {
  const result = detectResponseLanguage(
    "Analiza en español la liquidez actual del ecosistema Sui"
  );

  assert.equal(result.label, "Spanish");
  assert.equal(result.code, "es");
  assert.equal(result.confidence, "high");
});

test("detectResponseLanguage recognizes short Indonesian follow-ups", () => {
  const result = detectResponseLanguage("yang kedua lanjut");

  assert.equal(result.label, "Indonesian");
  assert.equal(result.code, "id");
});
