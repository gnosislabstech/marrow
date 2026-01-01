// scripts/cli.ts — terminal CLI (outside the MCP server).
//
// Usage (binary name is configurable via CB_CLI_NAME; default `cb`):
//   ./run.sh scripts/cli.ts search "your query"
//   ./run.sh scripts/cli.ts answer "your question"
//   ./run.sh scripts/cli.ts list [--since=ISO] [--project=PATH] [--limit=N]
//   ./run.sh scripts/cli.ts get <session_id>
//   ./run.sh scripts/cli.ts replay <session_id> <turn_index> [--window=N]
//   ./run.sh scripts/cli.ts stats
//
// Same search.ts surface as the MCP server uses — single source of truth.

import { loadEnv } from "../src/env.js";
import {
  getSession,
  hybridSearchSessions,
  listSessions,
  rerankCandidates,
  replaySession,
  resolveSearchMode,
  synthesizeAnswer,
  type SearchMode,
} from "../src/search.js";
import { makeSupabaseHeaders } from "../src/env.js";

const env = loadEnv();

function usage(): never {
  const cli = env.cliName;
  console.error(`Usage:
  ${cli} search "query" [--limit=N] [--no-rerank] [--show-meta] [--current|--balanced|--mode=auto]
  ${cli} answer "question" [--sources=sessions|memory|all] [--match-count=N] [--current|--balanced|--mode=auto]
  ${cli} list [--since=ISO] [--project=PATH] [--limit=N]
  ${cli} get <session_id>
  ${cli} replay <session_id> <turn_index> [--window=N]
  ${cli} stats [--health] [--days=N]

Search modes:
  --balanced    Pure RRF (semantic + lexical). Best for historical queries.
  --current     Add recency rank dimension. Best for "where are we" / current-state queries.
  --mode=auto   Detect from query keywords (default).

Stats:
  --health      Append recent-ingest health from the hook logs.
  --days=N      Health window in days (default 7).`);
  process.exit(1);
}

/** Resolve --current / --balanced / --mode=X flags into a SearchMode. */
function pickModeFlag(flags: Record<string, string | true>): SearchMode {
  if (flags.current) return "current";
  if (flags.balanced) return "balanced";
  const m = flags.mode;
  if (m === "balanced" || m === "current" || m === "auto") return m;
  return "auto";
}

function fmtSnippet(text: string, max = 300): string {
  return text.replace(/\s+/g, " ").slice(0, max);
}

function parseFlags(argv: string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (const a of argv) {
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        flags[a.slice(2)] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

async function cmdSearch(args: string[]): Promise<void> {
  const { positional, flags } = parseFlags(args);
  const query = positional.join(" ");
  if (!query) usage();
  const limit = Number(flags.limit ?? 10);
  const rerank = !flags["no-rerank"];
  const hideMeta = !flags["show-meta"];
  const mode = pickModeFlag(flags);
  const resolvedMode = resolveSearchMode(mode, query);

  const fetchLimit = rerank ? Math.min(limit * 2, 30) : limit;
  let rows = await hybridSearchSessions(env, query, {
    matchCount: fetchLimit,
    searchMode: resolvedMode,
  });
  if (hideMeta) {
    rows = rows.filter((r) => {
      const m = r.metadata as { is_meta_file?: boolean; is_meta_message?: boolean };
      return !(m.is_meta_file || m.is_meta_message);
    });
  }
  let final = rows;
  // Reranker is recency-blind — skip in current mode so we don't undo the bias
  if (rerank && rows.length > 1 && resolvedMode !== "current") {
    const ranked = await rerankCandidates(env, query, rows.map((r) => r.content), limit);
    final = ranked.map((r) => rows[r.index]);
  }
  final = final.slice(0, limit);

  console.log(`\n${final.length} hits for "${query}" [mode=${resolvedMode}]:\n`);
  for (const [i, h] of final.entries()) {
    const date = h.occurred_at?.slice(0, 10) ?? "unknown";
    console.log(`[${i + 1}] ${h.session_id.slice(0, 8)} turn=${h.turn_index} role=${h.role} ${date}`);
    console.log(`    ${fmtSnippet(h.content)}\n`);
  }
}

async function cmdAnswer(args: string[]): Promise<void> {
  const { positional, flags } = parseFlags(args);
  const question = positional.join(" ");
  if (!question) usage();
  const sources = (flags.sources as "sessions" | "memory" | "all" | undefined) ?? "all";
  const matchCount = Number(flags["match-count"] ?? 10);
  const mode = pickModeFlag(flags);
  const resolvedMode = resolveSearchMode(mode, question);

  console.error(`(synthesizing answer over ${sources} corpus, mode=${resolvedMode}...)`);
  const r = await synthesizeAnswer(env, question, {
    sources,
    matchCount,
    rerank: true,
    searchMode: mode,
  });
  console.log(`\n${r.answer}\n`);
  console.log(
    `--- ${r.citations.length} citations (${r.ms}ms, $${r.cost_estimate_usd.toFixed(5)}, mode=${r.search_mode}) ---`,
  );
  for (const c of r.citations) {
    if (c.kind === "session") {
      console.log(`[${c.n}] session=${c.session_id?.slice(0, 8)} turn=${c.turn_index} ${c.occurred_at?.slice(0, 10) ?? ""}`);
    } else {
      console.log(`[${c.n}] memory=${c.source_path}`);
    }
  }
}

async function cmdList(args: string[]): Promise<void> {
  const { flags } = parseFlags(args);
  const sessions = await listSessions(env, {
    since: flags.since as string | undefined,
    projectPath: flags.project as string | undefined,
    limit: Number(flags.limit ?? 25),
  });
  console.log(`\n${sessions.length} sessions:\n`);
  for (const s of sessions) {
    const started = s.started_at?.slice(0, 19).replace("T", " ") ?? "?";
    const title = s.summary ?? "(no title)";
    console.log(`  ${s.session_id.slice(0, 8)}  ${started}  ${s.source_machine.padEnd(20)} ${s.project_path ?? ""}`);
    console.log(`    ${title.slice(0, 80)}\n`);
  }
}

async function cmdGet(args: string[]): Promise<void> {
  const sessionId = args[0];
  if (!sessionId) usage();
  const s = await getSession(env, sessionId);
  if (!s) {
    console.log(`No session found: ${sessionId}`);
    return;
  }
  console.log(JSON.stringify(s, null, 2));
}

async function cmdReplay(args: string[]): Promise<void> {
  const { positional, flags } = parseFlags(args);
  const sessionId = positional[0];
  const around = Number(positional[1]);
  if (!sessionId || Number.isNaN(around)) usage();
  const window = Number(flags.window ?? 5);

  const turns = await replaySession(env, sessionId, around, window);
  console.log(`\n${turns.length} turns around ${sessionId.slice(0, 8)}:${around}:\n`);
  for (const t of turns) {
    const marker = t.turn_index === around ? "★" : " ";
    console.log(`${marker} [${t.turn_index}] ${t.role} ${t.occurred_at?.slice(0, 19).replace("T", " ") ?? ""}`);
    console.log(`    ${fmtSnippet(t.content, 500)}\n`);
  }
}

async function cmdStats(args: string[]): Promise<void> {
  const { flags } = parseFlags(args);
  const url = `${env.supabaseUrl.replace(/\/$/, "")}/rest/v1`;
  const hdr = { ...makeSupabaseHeaders(env), Prefer: "count=exact" };
  async function count(table: string, qs = ""): Promise<number> {
    const r = await fetch(`${url}/${table}?select=*&limit=1${qs}`, { headers: hdr });
    const cr = r.headers.get("content-range") ?? "";
    return Number(cr.split("/")[1] ?? 0);
  }
  const [sessions, sessChunks, memChunks, quarantine] = await Promise.all([
    count("sessions"),
    count("session_chunks"),
    count("memory_chunks"),
    count("quarantine"),
  ]);
  console.log(`\n${env.productName} corpus stats:\n`);
  console.log(`  sessions:        ${sessions.toLocaleString()}`);
  console.log(`  session_chunks:  ${sessChunks.toLocaleString()}`);
  console.log(`  memory_chunks:   ${memChunks.toLocaleString()}`);
  console.log(`  quarantine:      ${quarantine.toLocaleString()}`);
  console.log(`  TOTAL indexed:   ${(sessChunks + memChunks).toLocaleString()} chunks\n`);

  if (flags.health) {
    const days = Number(flags.days ?? 7);
    await printIngestHealth(days);
    await printDbCrHealth(url, hdr);
  }
}

/**
 * DB-level CR health — durable past /tmp reboots. Counts session_chunks
 * by their has_cr_prefix tristate (true = CR succeeded, false = CR failed
 * during a DeepSeek outage, NULL = legacy/unknown chunks).
 *
 * Complements printIngestHealth(): logs are real-time + cause-of-failure
 * specific, DB count is total-accumulated and survives reboots. Together
 * they answer "is it happening NOW" (logs) and "how much TOTAL backlog
 * needs backfill" (DB).
 */
async function printDbCrHealth(
  baseUrl: string,
  hdr: Record<string, string>,
): Promise<void> {
  const countHdr = { ...hdr, Prefer: "count=exact" };
  async function count(filter: string): Promise<number> {
    const r = await fetch(`${baseUrl}/session_chunks?select=*&limit=1&${filter}`, { headers: countHdr });
    const cr = r.headers.get("content-range") ?? "";
    return Number(cr.split("/")[1] ?? 0);
  }
  const [crTrue, crFalse, crNull] = await Promise.all([
    count("has_cr_prefix=is.true"),
    count("has_cr_prefix=is.false"),
    count("has_cr_prefix=is.null"),
  ]);
  const total = crTrue + crFalse + crNull;
  if (total === 0) {
    console.log(`db-level CR coverage:`);
    console.log(`  (no session_chunks counted)\n`);
    return;
  }
  console.log(`db-level CR coverage (all session_chunks ever ingested):`);
  console.log(`  with CR prefix (good):      ${crTrue.toLocaleString().padStart(8)}  ${((crTrue / total) * 100).toFixed(1)}%`);
  console.log(`  CR failed (degraded):       ${crFalse.toLocaleString().padStart(8)}  ${((crFalse / total) * 100).toFixed(1)}%  ${crFalse > 0 ? "← backfill candidates" : ""}`);
  console.log(`  CR status unknown (legacy): ${crNull.toLocaleString().padStart(8)}  ${((crNull / total) * 100).toFixed(1)}%`);
  console.log();
}

/**
 * Scan recent ingest hook logs for ingest health signals.
 *
 * Surfaces what would otherwise be invisible: how many CR calls have been
 * failing since the last upstream outage, when the most recent 402 was, how
 * many chunks landed without CR prefix (degraded retrieval quality).
 *
 * Bounded by /tmp lifetime (cleared on reboot) and the --days window — the
 * operationally-meaningful window ("is something degraded right now").
 */
async function printIngestHealth(days: number): Promise<void> {
  const { readdir, readFile, stat } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const LOG_DIR = "/tmp/cb-ingest";

  let entries: string[];
  try {
    entries = await readdir(LOG_DIR);
  } catch {
    console.log(`recent ingest health (last ${days}d):`);
    console.log(`  log directory not present — ingest hooks haven't fired yet on this box.\n`);
    return;
  }

  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const sessionLogs: string[] = [];
  const memoryLogs: string[] = [];
  for (const e of entries) {
    if (!e.endsWith(".log")) continue;
    const full = join(LOG_DIR, e);
    let st;
    try { st = await stat(full); } catch { continue; }
    if (st.mtimeMs < cutoff) continue;
    if (e.startsWith("memory-refresh-")) memoryLogs.push(full);
    else sessionLogs.push(full);
  }

  let sessionsIngested = 0;
  let chunksInserted = 0;
  let chunksQuarantined = 0;
  let crFailures = 0;
  let mostRecent402: number | null = null;
  let worstSingleRunCrFailures = 0;
  const memoryRefreshes = memoryLogs.length;

  for (const path of sessionLogs) {
    let text: string;
    try { text = await readFile(path, "utf8"); } catch { continue; }
    sessionsIngested += 1;

    const crFailLines = text.match(/CR failed for /g);
    const runCrFailures = crFailLines ? crFailLines.length : 0;
    crFailures += runCrFailures;
    if (runCrFailures > worstSingleRunCrFailures) worstSingleRunCrFailures = runCrFailures;

    const summary = text.match(/Done: (\d+) inserted, (\d+) quarantined/);
    if (summary) {
      chunksInserted += Number(summary[1]);
      chunksQuarantined += Number(summary[2]);
    }

    if (text.includes("Insufficient Balance") || text.includes("402")) {
      try {
        const st = await stat(path);
        if (mostRecent402 === null || st.mtimeMs > mostRecent402) {
          mostRecent402 = st.mtimeMs;
        }
      } catch {}
    }
  }

  console.log(`recent ingest health (last ${days}d, from ${LOG_DIR}):`);
  console.log(`  session ingest runs:        ${sessionsIngested.toLocaleString()}`);
  console.log(`  memory refresh runs:        ${memoryRefreshes.toLocaleString()}`);
  console.log(`  chunks inserted:            ${chunksInserted.toLocaleString()}`);
  console.log(`  chunks quarantined:         ${chunksQuarantined.toLocaleString()}`);
  console.log(`  CR failures:                ${crFailures.toLocaleString()}  ${crFailures > 0 ? "(those chunks landed but without CR prefix — degraded retrieval quality)" : "(zero — CR healthy)"}`);
  if (crFailures > 0) {
    console.log(`  worst single-run burst:     ${worstSingleRunCrFailures.toLocaleString()} chunks in one session`);
  }
  if (mostRecent402 !== null) {
    const when = new Date(mostRecent402);
    const ageHours = (Date.now() - mostRecent402) / (60 * 60 * 1000);
    console.log(`  most recent 402:            ${when.toISOString()} (${ageHours.toFixed(1)}h ago)`);
  } else {
    console.log(`  most recent 402:            none in window`);
  }
  console.log();
}

// ─── Dispatch ─────────────────────────────────────────────────────

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "search":   await cmdSearch(rest); break;
  case "answer":   await cmdAnswer(rest); break;
  case "list":     await cmdList(rest); break;
  case "get":      await cmdGet(rest); break;
  case "replay":   await cmdReplay(rest); break;
  case "stats":    await cmdStats(rest); break;
  default:         usage();
}
