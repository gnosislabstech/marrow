// P12 — clampInt bounds MCP numeric args: non-finite values throw (never a
// NaN reaching PostgREST), out-of-range values clamp, undefined falls back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { clampInt } from "../src/mcp-validate.js";

test("P12: undefined yields the fallback", () => {
  assert.equal(clampInt(undefined, 1, 100, "limit", 10), 10);
});

test("P12: NaN / Infinity / junk throw", () => {
  assert.throws(() => clampInt(NaN, 1, 100, "limit", 10));
  assert.throws(() => clampInt(Infinity, 1, 100, "limit", 10));
  assert.throws(() => clampInt("25&offset=9999", 1, 100, "limit", 10));
});

test("P12: out-of-range clamps to the bound", () => {
  assert.equal(clampInt(100000, 1, 100, "limit", 10), 100);
  assert.equal(clampInt(-5, 1, 100, "limit", 10), 1);
});

test("P12: fractional values truncate, valid values pass", () => {
  assert.equal(clampInt(7.9, 1, 100, "limit", 10), 7);
  assert.equal(clampInt(42, 1, 100, "limit", 10), 42);
});
