// P10 — sanitizeUtf8 strips lone surrogates and control chars but preserves
// valid surrogate pairs (emoji and other non-BMP characters).
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeUtf8 } from "../src/embedding.js";

test("P10: emoji and non-BMP characters survive", () => {
  const input = "deploy done 🚀 — café 中文 𝕌";
  assert.equal(sanitizeUtf8(input), input);
});

test("P10: lone surrogates are removed", () => {
  // A high surrogate with no following low surrogate is invalid and Voyage
  // rejects it — it must be stripped (via toWellFormed → U+FFFD → removed).
  const input = "broken\uD800surrogate text";
  assert.equal(sanitizeUtf8(input), "brokensurrogate text");
});

test("P10: control chars are stripped, normal whitespace kept", () => {
  assert.equal(sanitizeUtf8("a\x00b\x07c\nd\te"), "abc\nd\te");
});
