// P09 — scoreFingerprint = frequency_norm × fixability × recency_factor, where
// frequency_norm = affectedSessions/totalSessions,
// recency_factor = 0.6*exp(-daysSinceLast/30) + 0.4*clamp(monthlySlope,0,1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreFingerprint } from "../src/analytics/fingerprint-score.js";

test("P09: exact formula on a known input", () => {
  // freq=0.5, fix=1, recency = 0.6*exp(0)+0.4*1 = 1.0 → 0.5
  const s = scoreFingerprint({ affectedSessions: 50, totalSessions: 100, fixability: 1, daysSinceLast: 0, monthlySlope: 1 });
  assert.ok(Math.abs(s - 0.5) < 1e-9, `expected ~0.5, got ${s}`);
});

test("P09: excluded class (fixability 0) scores 0", () => {
  assert.equal(scoreFingerprint({ affectedSessions: 99, totalSessions: 100, fixability: 0, daysSinceLast: 0, monthlySlope: 1 }), 0);
});

test("P09: higher frequency + more recent ranks above lower + stale", () => {
  const hot = scoreFingerprint({ affectedSessions: 80, totalSessions: 100, fixability: 1, daysSinceLast: 1, monthlySlope: 1 });
  const cold = scoreFingerprint({ affectedSessions: 5, totalSessions: 100, fixability: 1, daysSinceLast: 200, monthlySlope: 0 });
  assert.ok(hot > cold, `hot ${hot} should exceed cold ${cold}`);
});

test("P09: monthlySlope is clamped (out-of-range does not explode the score)", () => {
  const s = scoreFingerprint({ affectedSessions: 100, totalSessions: 100, fixability: 1, daysSinceLast: 0, monthlySlope: 999 });
  assert.ok(s <= 1 + 1e-9, `score should stay <=1, got ${s}`);
});
