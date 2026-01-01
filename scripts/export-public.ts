// scripts/export-public.ts — produce a clean, standalone public repo from the
// current tracked tree. One-directional: nothing private flows out.
//
//   tsx scripts/export-public.ts [--out=/path/to/export]
//
// Steps:
//   1. snapshot the tracked tree via `git archive` (no .git, no gitignored files)
//   2. delete the private overlay (CLAUDE.md, docs/, loops/)
//   3. regenerate package-lock.json (drops the orphaned `postgres` dep)
//   4. re-init git with ONE squashed, identity-free commit (pinned neutral author,
//      no Co-Authored-By trailers)
//   5. gate: the pickaxe must pass over the export's ENTIRE history
//
// The pickaxe is armed with THIS repo's private .pickaxe-denylist via
// --denylist: the export tree never contains it (gitignored → not archived),
// so letting the pickaxe look for it inside the export would silently run the
// gate with built-in generic patterns only.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");

const outArg = process.argv.find((a) => a.startsWith("--out="));
const OUT = outArg ? outArg.slice("--out=".length) : join(tmpdir(), "marrow-public");

// Tracked, but must NOT ship publicly (the private overlay).
const DELETE = ["CLAUDE.md", "docs", "loops"];

function run(cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: env ?? process.env,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// 1) fresh OUT
if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// 2) snapshot tracked files via git archive → tar (no .git, no gitignored)
const tarDir = mkdtempSync(join(tmpdir(), "cx-"));
const tmpTar = join(tarDir, "tree.tar");
run("git", ["archive", "--format=tar", "-o", tmpTar, "HEAD"], REPO);
run("tar", ["-xf", tmpTar, "-C", OUT], REPO);
rmSync(tarDir, { recursive: true, force: true });

// 3) delete the private overlay
const deleted: string[] = [];
for (const p of DELETE) {
  const full = join(OUT, p);
  if (existsSync(full)) {
    rmSync(full, { recursive: true, force: true });
    deleted.push(p);
  }
}

// 4) regenerate the lockfile (drops the orphaned `postgres` dep). Needs network;
//    fall back to removing the stale lock so a fresh clone regenerates it.
let lockNote: string;
try {
  run("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], OUT);
  lockNote = "regenerated package-lock.json";
} catch {
  const lock = join(OUT, "package-lock.json");
  if (existsSync(lock)) rmSync(lock);
  lockNote = "removed stale package-lock.json (offline; `npm install` regenerates it)";
}

// 5) re-init git with ONE squashed, identity-free commit
const idEnv: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Marrow",
  GIT_AUTHOR_EMAIL: "noreply@example.com",
  GIT_COMMITTER_NAME: "Marrow",
  GIT_COMMITTER_EMAIL: "noreply@example.com",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};
run("git", ["init", "-q", "-b", "main"], OUT);
run("git", ["add", "-A"], OUT);
run("git", ["commit", "-q", "-m", "Initial public release"], OUT, idEnv);
const commit = run("git", ["rev-parse", "--short", "HEAD"], OUT).trim();

// 6) gate: the pickaxe over the export's ENTIRE history (content + filenames + metadata)
const pickaxe = join(HERE, "pickaxe.ts");
const pickaxeArgs = ["--import", "tsx", pickaxe, OUT];
// Arm the gate with the SOURCE repo's private denylist — the export tree never
// contains it (gitignored), so without this the gate would run generic-only.
const srcDenylist = join(REPO, ".pickaxe-denylist");
if (existsSync(srcDenylist)) {
  pickaxeArgs.push(`--denylist=${srcDenylist}`);
} else {
  console.warn(
    "WARNING: no .pickaxe-denylist in the source repo — the gate runs with built-in generic patterns only.",
  );
}
let pickaxeOut = "";
let pickaxePass = false;
try {
  pickaxeOut = run(process.execPath, pickaxeArgs, REPO);
  pickaxePass = true;
} catch (e) {
  const err = e as { stdout?: string; stderr?: string };
  pickaxeOut = (err.stdout ?? "") + (err.stderr ?? "");
  pickaxePass = false;
}

console.log("─".repeat(64));
console.log(`Public export → ${OUT}`);
console.log(`  deleted (private overlay): ${deleted.join(", ") || "(none)"}`);
console.log(`  lockfile: ${lockNote}`);
console.log(`  squashed commit: ${commit}  (author "Marrow", no co-author trailers)`);
console.log(`  pickaxe over full history: ${pickaxePass ? "CLEAN ✓" : "HITS ✗ — NOT publishable"}`);
if (!pickaxePass) console.log("\n" + pickaxeOut);
console.log("─".repeat(64));
process.exit(pickaxePass ? 0 : 1);
