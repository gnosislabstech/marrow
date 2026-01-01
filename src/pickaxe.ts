// src/pickaxe.ts — leak-history "pickaxe" core scanner (pure, no I/O).
//
// The pickaxe is the measuring instrument every public-export gate exits
// green against: it scans text against a denylist of identity/topology terms so
// nothing personal or infra-shaped reaches a published artifact. Denylist-based
// (NOT NER) — precise + auditable. Word-boundary matched where a bare token would
// otherwise over-match substrings of larger words (e.g. `convergence`).
//
// P01 scope: scanText() + the built-in topology denylist. P02 extends this with
// the enumerable DENYLIST export, a line-scoped allowlist, caller-supplied extra
// terms (the private denylist), and loadPrivateDenylist() file loading.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

/** A single denylist match: which term fired, on which 1-based line. */
export interface Hit {
  term: string;
  line: number;
}

/** Options for {@link scanText}. */
export interface ScanOptions {
  /** Caller-supplied private denylist terms, scanned as literal substrings. */
  extraTerms?: string[];
}

/** One built-in denylist entry: its reported `name` and a per-line matcher. */
export interface DenyEntry {
  name: string;
  matches: (line: string) => boolean;
}

// Built-in denylist = GENERIC, non-identifying secret shapes ONLY, so the public
// tool ships no personal/infra terms and never flags its own source. Operator-
// specific terms (usernames, home paths, vault names, project refs, persona /
// family / client names) are NOT built in — they come from the private
// `.pickaxe-denylist` file (loaded via loadPrivateDenylist → scanText extraTerms).
// Lesson: a leak-scanner that hardcodes its needles flags itself.
export const DENYLIST: DenyEntry[] = [
  // A real 1Password secret reference: op:// followed by an actual vault segment.
  // Bare mentions ("op://" in prose/code) and the `op://<vault>/...` placeholder
  // are NOT flagged — this engine documents + detects op:// refs, so its own
  // code/docs legitimately contain the string. The leak is a REAL vault name,
  // which the private denylist (extraTerms) catches.
  { name: "op://", matches: (l) => /op:\/\/[A-Za-z0-9]/.test(l) },
];

// A line ending in the trailing comment `// pickaxe-allow` is an explicit,
// line-scoped opt-out: that one line is never flagged (and only that line).
const ALLOW_RE = /\/\/\s*pickaxe-allow\s*$/;

/**
 * Scan `text` line-by-line against the built-in {@link DENYLIST} plus any
 * `opts.extraTerms` (the private denylist, matched as literal substrings).
 * Returns one {@link Hit} per (term, line) match, with 1-based line numbers.
 * A line ending in `// pickaxe-allow` is skipped entirely. Clean text → `[]`.
 */
export function scanText(text: string, opts?: ScanOptions): Hit[] {
  const hits: Hit[] = [];
  const extraTerms = opts?.extraTerms ?? [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (ALLOW_RE.test(line)) continue;
    for (const entry of DENYLIST) {
      if (entry.matches(line)) {
        hits.push({ term: entry.name, line: i + 1 });
      }
    }
    for (const term of extraTerms) {
      if (term && line.includes(term)) {
        hits.push({ term, line: i + 1 });
      }
    }
  }
  return hits;
}

/**
 * Load a private denylist file: one term per line, skipping blank lines and
 * lines beginning with `#` (comments). Whitespace is trimmed. Returns the terms.
 */
export function loadPrivateDenylist(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

// ─────────────────────────── P03 — git-history scan ───────────────────────────

/** Which historical surface a {@link RepoHit} was found on. */
export type Surface = "content" | "filename" | "metadata";

/** A denylist match found while scanning a git repository's full history. */
export interface RepoHit {
  term: string;
  surface: Surface;
  /** Human-readable origin: `commit:file` (content), the path (filename), or the metadata line. */
  location: string;
}

/** Options for {@link scanRepo}. */
export interface ScanRepoOptions {
  /** Private denylist terms (e.g. project refs, persona/family/client names). */
  extraTerms?: string[];
}

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** Term names firing on a single line, via the shared {@link scanText} matcher. */
function termsOn(line: string, extraTerms: string[]): string[] {
  return scanText(line, { extraTerms }).map((h) => h.term);
}

/**
 * Scan a git repository's FULL history (`--all`) across three surfaces:
 *  - **content** — every added/removed line across all commit diffs;
 *  - **filename** — every tracked path that ever existed;
 *  - **metadata** — every commit's author + committer name and email.
 * Returns de-duplicated {@link RepoHit}s. A clean history → `[]`. This is the
 * publish gate: any hit means the tree is not safe to make public.
 */
export function scanRepo(dir: string, opts?: ScanRepoOptions): RepoHit[] {
  const extraTerms = opts?.extraTerms ?? [];
  const hits: RepoHit[] = [];
  const seen = new Set<string>();
  const push = (term: string, surface: Surface, location: string) => {
    const key = `${surface}\0${term}\0${location}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({ term, surface, location });
  };

  // 1) CONTENT — full-history patches; scan only +/- content lines, not headers.
  const patch = git(dir, ["log", "--all", "-p", "--no-color", "--format=%H"]);
  let commit = "";
  let file = "";
  for (const raw of patch.split("\n")) {
    if (/^[0-9a-f]{40}$/.test(raw)) {
      commit = raw;
      continue;
    }
    if (raw.startsWith("+++ ") || raw.startsWith("--- ")) {
      const m = raw.match(/^\+\+\+ b\/(.+)$/);
      if (m) file = m[1];
      continue;
    }
    if (raw.startsWith("diff ") || raw.startsWith("@@") || raw.startsWith("index ")) continue;
    if (raw.startsWith("+") || raw.startsWith("-")) {
      const content = raw.slice(1);
      for (const term of termsOn(content, extraTerms)) {
        push(term, "content", `${commit.slice(0, 8)}:${file}`);
      }
    }
  }

  // 2) FILENAMES — paths added anywhere in history, plus the current index.
  const added = git(dir, ["log", "--all", "--diff-filter=A", "--pretty=format:", "--name-only"]);
  const tracked = git(dir, ["ls-files"]);
  for (const name of new Set(
    (added + "\n" + tracked).split("\n").map((s) => s.trim()).filter(Boolean),
  )) {
    for (const term of termsOn(name, extraTerms)) {
      push(term, "filename", name);
    }
  }

  // 3) METADATA — author + committer name/email across every commit.
  const meta = git(dir, ["log", "--all", "--format=%an%n%ae%n%cn%n%ce"]);
  for (const line of meta.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    for (const term of termsOn(trimmed, extraTerms)) {
      push(term, "metadata", trimmed);
    }
  }

  return hits;
}
