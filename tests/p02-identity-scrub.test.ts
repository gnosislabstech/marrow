// P02 — identityScrub replaces personal/infra topology with neutral placeholders,
// boundary-matched so it does not over-scrub similar tokens. Config-driven: the
// operator's real terms are supplied via ScrubTerms; these fixtures are synthetic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { identityScrub, type ScrubTerms } from "../src/scrub.js";

const TERMS: ScrubTerms = {
  usernames: ["synthuser"],
  projectRefs: ["synthprojref0000000a"],
};

test("P02: home dir → $HOME", () => {
  const out = identityScrub("/home/synthuser/sample-project", TERMS);
  assert.ok(!out.includes("/home/synthuser"), "must not leak the home path");
  assert.ok(out.includes("$HOME"), "must use the $HOME placeholder");
});

test("P02: path-boundary — a different user is NOT over-scrubbed", () => {
  const out = identityScrub("/home/synthuserx/data", TERMS);
  assert.ok(out.includes("synthuserx"), "must not mangle a longer username into the replacement");
});

test("P02: op:// reference → <secret-ref> (built-in, always on)", () => {
  const out = identityScrub("creds at op://example-vault/voyage/api_key end", TERMS); // pickaxe-allow
  assert.ok(!out.includes("op://"), "must not leak op:// references");
  assert.ok(out.includes("<secret-ref>"), "must use the <secret-ref> placeholder");
});

test("P02: supabase project ref → <project-ref>", () => {
  const out = identityScrub("project synthprojref0000000a region oregon", TERMS);
  assert.ok(!out.includes("synthprojref0000000a"), "must not leak the project ref");
  assert.ok(out.includes("<project-ref>"), "must use the <project-ref> placeholder");
});
