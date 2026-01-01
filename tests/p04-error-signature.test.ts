// P04 — normalizeErrorSignature collapses the same failure CLASS to one
// signature (strips digits/paths/quoted-strings/ids) while keeping different
// classes distinct.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeErrorSignature } from "../src/analytics/error-signature.js";

test("P04: same class, different numbers → identical signature", () => {
  assert.equal(
    normalizeErrorSignature("Exit code 2"),
    normalizeErrorSignature("Exit code 137"),
  );
});

test("P04: same class, different paths → identical signature", () => {
  assert.equal(
    normalizeErrorSignature("File /home/synthuser/a.ts has not been read yet"),
    normalizeErrorSignature("File /home/synthuser/x/b/c.ts has not been read yet"),
  );
});

test("P04: same class, different quoted values → identical signature", () => {
  assert.equal(
    normalizeErrorSignature('column "foo" does not exist'),
    normalizeErrorSignature('column "bar_baz" does not exist'),
  );
});

test("P04: different classes stay distinct (no degenerate constant)", () => {
  assert.notEqual(
    normalizeErrorSignature("Exit code 2"),
    normalizeErrorSignature('column "foo" does not exist'),
  );
});
