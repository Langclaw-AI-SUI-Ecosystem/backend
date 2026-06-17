import assert from "node:assert/strict";
import test from "node:test";

import { normalizeRawTokenAmount } from "./surf";

test("normalizes common token raw amounts with token decimals", () => {
  assert.equal(normalizeRawTokenAmount("123456789", 6), 123.456789);
  assert.equal(normalizeRawTokenAmount("1000000", 6), 1);
  assert.equal(normalizeRawTokenAmount("123456789", 8), 1.23456789);
  assert.equal(normalizeRawTokenAmount("1500000000000000000", 18), 1.5);
});

test("does not treat thousands as millions after normalization", () => {
  assert.equal(normalizeRawTokenAmount("29797832970000", 6), 29797832.97);
  assert.equal(normalizeRawTokenAmount("2979783297", 6), 2979.783297);
});
