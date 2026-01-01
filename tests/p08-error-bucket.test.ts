// P08 — bucketSignature routes a normalized signature to a seed key or UNMATCHED.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bucketSignature, UNMATCHED, type SeedMap } from "../src/analytics/error-bucket.js";

const seeds: SeedMap = {
  "oversized-read": ["has not been read"],
  "grep-denied": ["permission to use grep"],
  "exit-nonzero": ["exit code"],
};

test("P08: matches a seed by case-insensitive substring", () => {
  assert.equal(bucketSignature("File <PATH> has not been read yet", seeds), "oversized-read");
  assert.equal(bucketSignature("Exit code <NUM>", seeds), "exit-nonzero");
  assert.equal(bucketSignature("You need Permission to use Grep here", seeds), "grep-denied");
});

test("P08: a novel signature falls to UNMATCHED", () => {
  assert.equal(bucketSignature("some brand new error nobody has seen", seeds), UNMATCHED);
});

test("P08: empty seeds → UNMATCHED", () => {
  assert.equal(bucketSignature("Exit code <NUM>", {}), UNMATCHED);
});
