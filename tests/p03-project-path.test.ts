// P03 — canonicalizeProjectPath folds path variants to one logical project
// and buckets the unscoped catch-alls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { canonicalizeProjectPath, UNSCOPED } from "../src/analytics/project-path.js";

test("P03: null / undefined → unscoped", () => {
  assert.equal(canonicalizeProjectPath(null), UNSCOPED);
  assert.equal(canonicalizeProjectPath(undefined), UNSCOPED);
});

test("P03: bare home + scratch → unscoped", () => {
  assert.equal(canonicalizeProjectPath(homedir()), UNSCOPED);
  assert.equal(canonicalizeProjectPath("/tmp/whatever"), UNSCOPED);
});

test("P03: worktree folds to its parent repo", () => {
  assert.equal(
    canonicalizeProjectPath("/home/synthuser/sample-project/.acme-worktrees/abc123"),
    "/home/synthuser/sample-project",
  );
});

test("P03: a normal project path is returned unchanged", () => {
  assert.equal(
    canonicalizeProjectPath("/home/synthuser/another-project"),
    "/home/synthuser/another-project",
  );
});
