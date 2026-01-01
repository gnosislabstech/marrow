// P0 — leak-history "pickaxe" (publish gate). These tests define the contract for
// src/pickaxe.ts (core scanner, pure-ish) + scripts/pickaxe.ts (CLI). The pickaxe is
// the measuring instrument every later public-core phase exits green against.
//
// NOTE: the module is built by the loop, so these use DYNAMIC import + an assertion
// (not a static top-level import). A not-yet-built module then fails as a real
// assertion ("must import cleanly"), never a load-time crash — a load crash exits
// non-zero but is an unfixable gate (the worker may be forbidden from editing tests).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../scripts/pickaxe.ts", import.meta.url));

async function loadCore() {
  try {
    return await import("../src/pickaxe.js");
  } catch (e) {
    return { __importError: e instanceof Error ? e : new Error(String(e)) };
  }
}
function ensureCore(m: any) {
  assert.ok(
    !m.__importError,
    `src/pickaxe.ts must import cleanly: ${m.__importError?.message ?? ""}`,
  );
}

// Build a throwaway git repo in a tmp dir. `setup({dir, git})` populates it.
function makeRepo(setup: (ctx: { dir: string; git: (...a: string[]) => void }) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "pickaxe-repo-"));
  const git = (...args: string[]) => {
    execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  };
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test User");
  setup({ dir, git });
  return dir;
}

// ─────────────────────────── P01 — core text scanner ───────────────────────────
test("P01: scanText flags the built-in generic term (op://) with a 1-based line", async () => {
  const m = await loadCore();
  ensureCore(m);
  assert.equal(typeof m.scanText, "function", "export required: scanText(text, opts?) => Hit[]");
  const text = [
    'const u = "op://vault/db/url";', // pickaxe-allow
    "an ordinary line with nothing sensitive",
  ].join("\n");
  const hits = m.scanText(text);
  assert.ok(Array.isArray(hits), "scanText returns an array");
  const opHit = hits.find((h: any) => h.term === "op://");
  assert.ok(opHit, "op:// is built in and flagged");
  assert.equal(opHit.line, 1, "op:// hit carries its 1-based line number");
});

test("P01: scanText returns [] on clean text", async () => {
  const m = await loadCore();
  ensureCore(m);
  assert.deepEqual(m.scanText("just ordinary code\nno secrets here\n"), []);
});

test("P01: identity/infra terms are NOT built in — flagged only via private extraTerms", async () => {
  const m = await loadCore();
  ensureCore(m);
  // Out of the box (no private denylist), personal/infra strings are NOT flagged —
  // the public build ships none of them.
  assert.deepEqual(m.scanText('path "/home/someone/x" user someone vault Some-Vault'), []);
  // The private denylist (extraTerms) is what catches operator-specific terms.
  const hits = m.scanText("commit by someone in Some-Vault", {
    extraTerms: ["someone", "Some-Vault"],
  });
  const terms = new Set(hits.map((h: any) => h.term));
  assert.ok(terms.has("someone") && terms.has("Some-Vault"), "private terms flagged via extraTerms");
});

// ──────────────── P02 — denylist assembly, allowlist, private terms ────────────────
test("P02: DENYLIST is enumerable, generic-only (no hardcoded identity terms)", async () => {
  const m = await loadCore();
  ensureCore(m);
  assert.ok(Array.isArray(m.DENYLIST), "export required: DENYLIST array");
  const names = new Set(m.DENYLIST.map((d: any) => d.name));
  assert.ok(names.has("op://"), "the generic op:// pattern is built in");
  // The built-in list ships ONLY generic secret shapes — no operator identity terms
  // (those belong in the private denylist; hardcoding them would leak + self-flag).
  // Whitelist assertion: every entry must be a known-generic pattern. This catches a
  // hardcoded identity term WITHOUT naming any real one (which would itself leak).
  const GENERIC_ONLY = new Set(["op://"]);
  for (const name of names) {
    assert.ok(GENERIC_ONLY.has(name), `DENYLIST must ship only generic patterns, got identity-shaped term: ${name}`);
  }
});

test("P02: line-scoped // pickaxe-allow suppresses only its own line", async () => {
  const m = await loadCore();
  ensureCore(m);
  const text = [
    'const a = "op://vault/x"; // pickaxe-allow', // pickaxe-allow
    'const b = "op://vault/y";', // pickaxe-allow
  ].join("\n");
  const hits = m.scanText(text);
  assert.equal(hits.length, 1, "only the non-allowlisted line is flagged");
  assert.equal(hits[0].line, 2);
});

test("P02: scanText scans caller-supplied extra terms (the private denylist)", async () => {
  const m = await loadCore();
  ensureCore(m);
  const hits = m.scanText("the project ref synthproj123 appears", { extraTerms: ["synthproj123"] });
  assert.ok(hits.some((h: any) => h.term === "synthproj123"), "extra terms are scanned");
});

test("P02: loadPrivateDenylist reads one-term-per-line, skipping blanks and # comments", async () => {
  const m = await loadCore();
  ensureCore(m);
  assert.equal(typeof m.loadPrivateDenylist, "function", "export required: loadPrivateDenylist(path)");
  const dir = mkdtempSync(join(tmpdir(), "pickaxe-dl-"));
  try {
    const f = join(dir, "denylist.txt");
    writeFileSync(f, "# private names — never commit\nNeedleName\n\nsynthproj123\n");
    const terms = m.loadPrivateDenylist(f);
    assert.deepEqual([...terms].sort(), ["NeedleName", "synthproj123"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ──────────────── P03 — git-history scan (3 surfaces) + CLI exit codes ────────────────
test("P03: scanRepo flags a secret in committed diff CONTENT", async () => {
  const m = await loadCore();
  ensureCore(m);
  assert.equal(typeof m.scanRepo, "function", "export required: scanRepo(dir, opts?) => Hit[]");
  const dir = makeRepo(({ dir, git }) => {
    writeFileSync(join(dir, "config.ts"), 'const url = "op://example-vault/db/url";\n'); // pickaxe-allow
    git("add", "-A");
    git("commit", "-q", "-m", "add config");
  });
  try {
    const hits = await m.scanRepo(dir);
    assert.ok(hits.length >= 1, "op:// in committed content must be flagged");
    assert.ok(hits.some((h: any) => h.surface === "content"), "a content-surface hit is reported");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P03: scanRepo flags a sensitive tracked FILENAME (clean content)", async () => {
  const m = await loadCore();
  ensureCore(m);
  const dir = makeRepo(({ dir, git }) => {
    writeFileSync(join(dir, "synthuser-notes.md"), "totally benign body text\n");
    git("add", "-A");
    git("commit", "-q", "-m", "notes");
  });
  try {
    const hits = await m.scanRepo(dir, { extraTerms: ["synthuser"] });
    assert.ok(hits.some((h: any) => h.surface === "filename"), "the filename surface must be scanned");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P03: scanRepo flags sensitive commit AUTHOR/committer metadata", async () => {
  const m = await loadCore();
  ensureCore(m);
  const dir = makeRepo(({ dir, git }) => {
    writeFileSync(join(dir, "ok.txt"), "benign\n");
    git("add", "-A");
    // Plant the needle in commit metadata. GIT_*_NAME/EMAIL env vars override both
    // repo config and `-c` flags (true in this environment), so set them explicitly.
    execFileSync("git", ["commit", "-q", "-m", "x"], {
      cwd: dir,
      stdio: "pipe",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "synthuser",
        GIT_AUTHOR_EMAIL: "synthuser@example.com",
        GIT_COMMITTER_NAME: "synthuser",
        GIT_COMMITTER_EMAIL: "synthuser@example.com",
      },
    });
  });
  try {
    const hits = await m.scanRepo(dir, { extraTerms: ["synthuser"] });
    assert.ok(hits.some((h: any) => h.surface === "metadata"), "commit metadata must be scanned");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P03: scanRepo returns [] for a clean repo", async () => {
  const m = await loadCore();
  ensureCore(m);
  const dir = makeRepo(({ dir, git }) => {
    writeFileSync(join(dir, "readme.md"), "an ordinary open-source readme\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
  });
  try {
    assert.deepEqual(await m.scanRepo(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P03: CLI scripts/pickaxe.ts exits non-zero on a hit, zero on a clean repo", async () => {
  const dirty = makeRepo(({ dir, git }) => {
    writeFileSync(join(dir, "leak.ts"), 'const k = "op://example-vault/x";\n'); // pickaxe-allow
    git("add", "-A");
    git("commit", "-q", "-m", "leak");
  });
  const clean = makeRepo(({ dir, git }) => {
    writeFileSync(join(dir, "readme.md"), "ordinary readme\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
  });
  const run = (target: string): number => {
    try {
      execFileSync(process.execPath, ["--import", "tsx", CLI, target], { stdio: "pipe" });
      return 0;
    } catch (e: any) {
      return e.status ?? 1;
    }
  };
  try {
    assert.notEqual(run(dirty), 0, "dirty repo → non-zero exit (gate FAILS)");
    assert.equal(run(clean), 0, "clean repo → zero exit (gate PASSES)");
  } finally {
    rmSync(dirty, { recursive: true, force: true });
    rmSync(clean, { recursive: true, force: true });
  }
});

test("P03: .gitignore excludes the private denylist file", async () => {
  // The real private denylist (persona/family/client names + project refs) must NEVER
  // be committed. The repo's .gitignore must exclude it.
  const gi = fileURLToPath(new URL("../.gitignore", import.meta.url));
  const { readFileSync } = await import("node:fs");
  let body = "";
  try {
    body = readFileSync(gi, "utf8");
  } catch {
    /* falls to the assertion below */
  }
  assert.ok(/pickaxe-denylist/.test(body), ".gitignore must exclude the private denylist (pickaxe-denylist*)");
});
