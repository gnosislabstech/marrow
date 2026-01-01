#!/usr/bin/env node
// scripts/pickaxe.ts — CLI for the leak-history pickaxe (the publish gate).
//
// Usage:  node --import tsx scripts/pickaxe.ts [repo-dir] [--denylist=<path>]
// Scans the repo's FULL git history (content + filenames + commit metadata) against
// the built-in topology denylist plus an OPTIONAL private denylist (one term per
// line). The denylist is resolved from --denylist first, then
// <repo>/.pickaxe-denylist. Exits non-zero on any hit, zero when clean — so CI
// can veto a publish.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { scanRepo, loadPrivateDenylist } from "../src/pickaxe.js";

const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const target = positional[0] ?? process.cwd();
const denylistArg = process.argv
  .slice(2)
  .find((a) => a.startsWith("--denylist="));

let extraTerms: string[] = [];
// An explicit --denylist path wins. This matters for export gates: the export
// tree never contains the gitignored private denylist, so the caller (e.g.
// export-public.ts) must point back at the SOURCE repo's copy — scanning the
// export with no operator terms would wave identity leaks through as "clean".
const denyPath = denylistArg
  ? denylistArg.slice("--denylist=".length)
  : join(target, ".pickaxe-denylist");
if (existsSync(denyPath)) {
  try {
    extraTerms = loadPrivateDenylist(denyPath);
  } catch {
    // An unreadable private denylist is non-fatal; the built-in terms still apply.
  }
}

const hits = scanRepo(target, { extraTerms });

if (hits.length > 0) {
  for (const h of hits) {
    console.error(`[pickaxe] ${h.surface}\t${h.term}\t${h.location}`);
  }
  console.error(`[pickaxe] FAIL — ${hits.length} denylist hit(s) in git history of ${target}`);
  process.exit(1);
}

console.log(`[pickaxe] OK — no denylist hits in git history of ${target}`);
process.exit(0);
