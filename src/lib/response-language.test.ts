import assert from "node:assert/strict";
import test from "node:test";

import { detectResponseLanguage } from "./response-language";

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
