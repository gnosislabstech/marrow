// P01 — buildQuarantineRow must store a FINGERPRINT, never the raw secret.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildQuarantineRow } from "../src/privacy.js";

const SECRET = "sup3rSecretPassw0rd"; // gitleaks:allow — synthetic needle: the fixture this test plants to prove fingerprinting
const row = buildQuarantineRow({
  source_table: "session_chunks",
  source_path: "/some/session.jsonl",
  session_id: "sess-1",
  content: `DATABASE_URL=postgres://admin:${SECRET}@db.internal:5432/prod`,
  verdict: { pass: false, reason: "postgres_url_with_creds", matchedPattern: `postgres://admin:${SECRET}@db.internal` },
  ingest_batch: "batch-1",
});

test("P01: content does not contain the raw secret", () => {
  assert.ok(!row.content.includes(SECRET), "row.content must not echo the secret");
});

test("P01: matched_pattern is a short prefix (<=8 chars) and never the full secret", () => {
  assert.ok(!(row.matched_pattern ?? "").includes(SECRET), "matched_pattern must not echo the secret");
  assert.ok((row.matched_pattern ?? "").length <= 8, "matched_pattern must be a short prefix, not 80 chars");
});

test("P01: a sha256 fingerprint of the match is present in content", () => {
  assert.match(row.content, /sha256=[0-9a-f]{64}/, "content must carry a sha256 fingerprint");
});

test("P01: audit skeleton (reason + source) is preserved", () => {
  assert.equal(row.reason, "postgres_url_with_creds");
  assert.equal(row.source_path, "/some/session.jsonl");
  assert.equal(row.session_id, "sess-1");
});

test("P01: the fingerprint hash is SALTED (not a bare sha256 of the match)", () => {
  const stored = row.content.match(/sha256=([0-9a-f]{64})/)?.[1];
  assert.ok(stored, "a sha256 must be present");
  const bareMatch = `postgres://admin:${SECRET}@db.internal`;
  const unsalted = createHash("sha256").update(bareMatch).digest("hex");
  assert.notEqual(stored, unsalted, "hash must be salted so it isn't a confirmation oracle for a guessed secret");
});
