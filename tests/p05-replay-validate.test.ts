// P05 — validateReplayArgs rejects non-integer/negative/missing `around` BEFORE
// it can reach PostgREST as turn_index=gte.NaN (the replay_session 22P02 bug).
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateReplayArgs } from "../src/mcp-validate.js";

test("P05: missing / non-numeric around throws", () => {
  assert.throws(() => validateReplayArgs({ around: undefined }));
  assert.throws(() => validateReplayArgs({ around: "abc" }));
  assert.throws(() => validateReplayArgs({}));
});

test("P05: negative / non-integer around throws", () => {
  assert.throws(() => validateReplayArgs({ around: -1 }));
  assert.throws(() => validateReplayArgs({ around: 3.5 }));
});

test("P05: valid around coerces, window defaults to 5", () => {
  assert.deepEqual(validateReplayArgs({ around: 7 }), { around: 7, window: 5 });
});

test("P05: valid around + window pass through", () => {
  assert.deepEqual(validateReplayArgs({ around: 7, window: 2 }), { around: 7, window: 2 });
});
