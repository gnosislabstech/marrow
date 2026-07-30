// scripts/bootstrap.ts — full corpus ingestion orchestrator.
//
// CLI:
//   ./run.sh scripts/bootstrap.ts [options]
//
// Options:
//   --dry-run             Count + cost-estimate, no API calls or writes
//   --source=<label>      Limit to one configured source label (default: claude-code)
//   --max-files=N         Cap files processed per source (debugging / first-run sanity)
//   --skip-contextual     Skip Anthropic Contextual Retrieval (faster but lower-quality embeddings)
//   --help, -h            Show this help
//
// Pipeline per session:
//   1. Stream-parse JSONL → entries[]
//   2. Meta-conversation file check (flag in metadata, do NOT skip)
//   3. Project content-bearing entries → ProjectedTurn[]
//   4. Group into TurnWindow[] (3-8 turns, ~3200 char cap, 1-turn overlap)
//   5. Hash each window; dedup against existing session_chunks via content_hash
//   6. Build full document text for Contextual Retrieval (truncated to 600K chars)
//   7. For each new window: privacy pre-scan; bad → quarantine table (NOT embedded)
//   8. For embeddable windows: generate Contextual Retrieval prefix via cached Haiku
//   9. Embed in batches of 128 via Voyage (input_type=document)
//  10. Upsert sessions row, batch insert session_chunks rows
//  11. Update ingest_runs progress periodically
//  12. Finalize ingest_runs status on success/failure

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";

import { loadEnv, type Env } from "../src/env.js";
import { parseJsonlFile } from "../src/parser.js";
import {
  messageUsesOwnTool,
  isMetaConversationMessage,
} from "../src/metafilter.js";
import {
  buildQuarantineRow,
  privacyPreScan,
  type PrivacyVerdict,
} from "../src/privacy.js";
import {
  concatPrefixWithChunk,
  generateContextualPrefix,
  truncateDocumentForContext,
} from "../src/contextual.js";
import {
  embedBatch,
  embeddingToPostgresArray,
  EMBED_BATCH_SIZE,
  sanitizeUtf8,
  splitIntoVoyageBatches,
} from "../src/embedding.js";
import {
  beginIngestRun,
  finishIngestRun,
  getExistingHashes,
  insertBatch,
  pingSupabase,
  updateIngestRun,
  upsertSession,
} from "../src/supabase.js";
import {
  entryToTurn,
  groupTurnsIntoWindows,
  type ProjectedTurn,
  type TurnWindow,
} from "../src/windowing.js";

// ─── CLI ───────────────────────────────────────────────────────────

interface CliArgs {
  dryRun: boolean;
  source: string | null;
  maxFiles: number | null;
  maxFileBytes: number | null;
  skipContextual: boolean;
  file: string | null;
}

function parseArgs(): CliArgs {
  const args: CliArgs = {
    dryRun: false,
    source: null,
    maxFiles: null,
    maxFileBytes: null,
    skipContextual: false,
    file: null,
  };
  for (const a of process.argv.slice(2)) {
    if (a === "--dry-run") args.dryRun = true;
    else if (a.startsWith("--source=")) args.source = a.slice("--source=".length);
    else if (a.startsWith("--max-files=")) {
      args.maxFiles = Number.parseInt(a.slice("--max-files=".length), 10);
    } else if (a.startsWith("--max-file-bytes=")) {
      args.maxFileBytes = Number.parseInt(a.slice("--max-file-bytes=".length), 10);
    } else if (a === "--skip-contextual") args.skipContextual = true;
    else if (a.startsWith("--file=")) args.file = a.slice("--file=".length);
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: ./run.sh scripts/bootstrap.ts [options]\n" +
          "  --dry-run             Count + cost-estimate, no writes\n" +
          "  --source=<label>      one configured source label (default: claude-code)\n" +
          "  --file=<path>         Ingest a single JSONL file (for SessionEnd hook use)\n" +
          "  --max-files=N         Cap files processed per source\n" +
          "  --max-file-bytes=N    Skip session files larger than N bytes (OOM guard)\n" +
          "  --skip-contextual     Skip Contextual Retrieval (faster, lower quality)",
      );
      process.exit(0);
    }
  }
  return args;
}

/** Derive source_machine from absolute file path (for --file mode). */
function deriveSourceMachineFromPath(filePath: string): string {
  if (filePath.startsWith(`${homedir()}/.claude/projects/`)) return "local";
  return "unknown";
}

// ─── Source registry ──────────────────────────────────────────────

interface SourceConfig {
  label: string;
  type:
    | "cc-jsonl-tree"
    | "cc-jsonl-flat"
    | "claude-web-export"
    | "chatgpt-export"
    | "telegram-export"
    | "memory-tree";
  rootPath: string;
  sourceMachine: string;
}

// Default registry — the standard Claude Code projects tree, where Claude Code
// stores every session for any user. Override or extend it by creating
// src/sources.config.ts (gitignored; copy src/sources.config.ts.example). The
// engine also supports Claude-web / ChatGPT / Telegram export ingest and a
// generic markdown memory-tree — point those at your own export files via config.
const DEFAULT_SOURCES: SourceConfig[] = [
  {
    label: "claude-code",
    type: "cc-jsonl-tree",
    rootPath: `${homedir()}/.claude/projects`,
    sourceMachine: "local",
  },
];

/**
 * Resolve the source registry: an optional operator override from
 * src/sources.config.ts (must export `SOURCES: SourceConfig[]`), else the
 * built-in DEFAULT_SOURCES. The dynamic import specifier is intentional — it
 * keeps a fresh clone (no override file present) typechecking + building cleanly.
 */
async function loadSources(): Promise<SourceConfig[]> {
  try {
    const mod = (await import("../src/" + "sources.config.js")) as {
      SOURCES?: SourceConfig[];
    };
    if (Array.isArray(mod.SOURCES) && mod.SOURCES.length > 0) return mod.SOURCES;
  } catch {
    // No override file present — use the built-in default (the common case).
  }
  return DEFAULT_SOURCES;
}

// ─── Helpers ──────────────────────────────────────────────────────

function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function chunked<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

function listJsonlFilesRecursive(rootPath: string): string[] {
  if (!existsSync(rootPath)) return [];
  const out: string[] = [];
  const stack: string[] = [rootPath];
  // Symlink cycles (a dir linking to its own ancestor) would loop forever;
  // track visited real paths and never descend twice.
  const visited = new Set<string>([realpathSync(rootPath)]);
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        let real: string;
        try {
          real = realpathSync(full);
        } catch {
          continue;
        }
        if (visited.has(real)) continue;
        visited.add(real);
        stack.push(full);
      } else if (st.isFile() && extname(entry) === ".jsonl") {
        out.push(full);
      }
    }
  }
  return out;
}

function listJsonlFilesFlat(rootPath: string): string[] {
  if (!existsSync(rootPath)) return [];
  return readdirSync(rootPath)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => join(rootPath, f));
}

function deriveSessionId(filePath: string): string {
  return basename(filePath, ".jsonl");
}

function bytesOf(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

// ─── Per-session ingestion (Claude Code JSONL) ────────────────────

interface IngestSessionStats {
  windowsTotal: number;
  windowsNew: number;
  windowsQuarantined: number;
  windowsInserted: number;
  charsEmbedded: number;
  voyageTokens: number;
  haikuInputTokens: number;
  haikuCacheRead: number;
  haikuCacheCreate: number;
  haikuOutputTokens: number;
}

function emptyStats(): IngestSessionStats {
  return {
    windowsTotal: 0,
    windowsNew: 0,
    windowsQuarantined: 0,
    windowsInserted: 0,
    charsEmbedded: 0,
    voyageTokens: 0,
    haikuInputTokens: 0,
    haikuCacheRead: 0,
    haikuCacheCreate: 0,
    haikuOutputTokens: 0,
  };
}

async function ingestSession(
  env: Env,
  source: SourceConfig,
  filePath: string,
  ingestBatch: string,
  args: CliArgs,
): Promise<IngestSessionStats> {
  const stats = emptyStats();
  const sessionId = deriveSessionId(filePath);

  // ─── Single streaming pass ────────────────────────────────────
  // Build minimal state so marathon sessions don't OOM.
  // We do NOT keep the full entry list in memory — only lightweight ProjectedTurn[].
  const turns: ProjectedTurn[] = [];
  let firstTimestamp: string | null = null;
  let lastTimestamp: string | null = null;
  let cwd: string | null = null;
  let aiTitle: string | null = null;
  let messageCount = 0;
  let metaToolCount = 0;
  let turnIdx = 0;

  try {
    for await (const entry of parseJsonlFile(filePath)) {
      messageCount++;

      // Min/max timestamps
      if (typeof entry.timestamp === "string") {
        if (!firstTimestamp || entry.timestamp < firstTimestamp) {
          firstTimestamp = entry.timestamp;
        }
        if (!lastTimestamp || entry.timestamp > lastTimestamp) {
          lastTimestamp = entry.timestamp;
        }
      }

      // First-seen cwd → project_path fallback
      if (!cwd && typeof entry.cwd === "string") cwd = entry.cwd;

      // ai-title → free auto-generated session summary
      if (
        entry.type === "ai-title" &&
        typeof (entry as { aiTitle?: string }).aiTitle === "string"
      ) {
        aiTitle = (entry as { aiTitle?: string }).aiTitle ?? null;
      }

      // Meta-conversation tracking (file-level)
      if (messageUsesOwnTool(entry)) metaToolCount++;

      // Project to lightweight turn (drops the heavy entry reference)
      const isMetaMsg = isMetaConversationMessage(entry);
      const turn = entryToTurn(entry, turnIdx, isMetaMsg);
      if (!turn) continue;

      turns.push(turn);
      turnIdx++;

    }
  } catch (err) {
    // Streaming-level fatal (e.g., disk read error). Bubble up — file marked failed.
    throw err;
  }

  if (turns.length === 0) return stats;

  // A session is "meta" (about/using the tool itself) if it called the corpus
  // search tools heavily. Default-hidden from search; opt in with hide_meta=false.
  const isMetaFile = metaToolCount >= 3;

  // ─── Window + dedup + privacy + embed ─────────────────────────
  const windows = groupTurnsIntoWindows(turns);
  stats.windowsTotal = windows.length;
  if (windows.length === 0) return stats;

  const { documentText, newWindows } = await scanAndDedupeWindows({
    windows, sessionKey: sessionId, env, dryRun: args.dryRun,
  });
  stats.windowsNew = newWindows.length;
  if (newWindows.length === 0) return stats;

  // Upsert session row (skip in dry-run)
  if (!args.dryRun) {
    const sessionRow = buildSessionRowFromState({
      sessionId,
      sourceMachine: source.sourceMachine,
      sourcePath: filePath,
      ingestBatch,
      messageCount,
      startedAt: firstTimestamp,
      endedAt: lastTimestamp,
      projectPath: cwd,
      summary: aiTitle,
      owner: env.defaultOwner,
    });
    await upsertSession(env, sessionRow);
  }

  // 7-9. Persist windows: Privacy → parallel CR → token-aware Voyage → insert
  await persistChunkBatches(
    env, args, source, sessionId, filePath, newWindows,
    documentText, isMetaFile, ingestBatch, stats,
  );

  return stats;
}

// ─── Shared chunk-persist helper ──────────────────────────────────
// Phase 1 (privacy) → Phase 2 (parallel CR) → Phase 3 (token-aware Voyage + insert).
// Called by both ingestSession (CC JSONL) and the export-format ingesters.

/** A window plus its up-front privacy verdict — the pre-scan runs exactly
 *  once per window per ingest, before BOTH quarantine routing and the build
 *  of the (quarantine-free) CR document context. */
interface ScannedWindow {
  window: TurnWindow;
  hash: string;
  verdict: PrivacyVerdict;
}

/**
 * Scan a session's windows, build its CR document context, and drop the
 * windows already ingested. Every source path (Claude Code, Claude web,
 * ChatGPT, Telegram) needs exactly this sequence.
 *
 * It lives in one place on purpose. The privacy pre-scan MUST behave
 * identically for every source, and this logic previously existed as four
 * copy-pasted copies: a fix applied to one would have left the other three
 * quarantining nothing, which is the failure mode the scan exists to prevent.
 */
async function scanAndDedupeWindows(args: {
  windows: TurnWindow[];
  sessionKey: string;
  env: Env;
  dryRun: boolean;
}): Promise<{ documentText: string; newWindows: ScannedWindow[] }> {
  // The CR document context is built ONLY from windows that pass the privacy
  // pre-scan, so quarantined (secret-bearing) content never reaches the CR
  // provider either.
  const scanned: ScannedWindow[] = args.windows.map((w) => ({
    window: w,
    hash: contentHash(w.text),
    verdict: privacyPreScan(w.text),
  }));
  const documentText = truncateDocumentForContext(
    scanned.filter((x) => x.verdict.pass).map((x) => x.window.text).join("\n\n"),
  );

  let existingHashes = new Set<string>();
  if (!args.dryRun) {
    existingHashes = await getExistingHashes(
      args.env, "session_chunks", scanned.map((x) => x.hash), "session_id",
    );
  }
  const newWindows = scanned.filter(
    (x) => !existingHashes.has(`${args.sessionKey} ${x.hash}`),
  );
  return { documentText, newWindows };
}

async function persistChunkBatches(
  env: Env,
  args: CliArgs,
  source: SourceConfig,
  sessionId: string,
  filePath: string,
  newWindows: ScannedWindow[],
  documentText: string,
  isMetaFile: boolean,
  ingestBatch: string,
  stats: IngestSessionStats,
): Promise<void> {
  for (const batch of chunked(newWindows, EMBED_BATCH_SIZE)) {
    // ─ Phase 1: Privacy pre-scan (sync, fast) ─
    const quarantined: ReturnType<typeof buildQuarantineRow>[] = [];
    const candidates: { hash: string; window: TurnWindow }[] = [];
    for (const { window, hash, verdict } of batch) {
      if (!verdict.pass) {
        quarantined.push(
          buildQuarantineRow({
            source_table: "session_chunks",
            source_path: filePath,
            session_id: sessionId,
            content: window.text,
            verdict,
            ingest_batch: ingestBatch,
          }),
        );
      } else {
        candidates.push({ hash, window });
      }
    }

    if (quarantined.length > 0) {
      stats.windowsQuarantined += quarantined.length;
      if (!args.dryRun) {
        await insertBatch(
          env,
          "quarantine",
          quarantined as unknown as Record<string, unknown>[],
        );
      }
    }

    if (candidates.length === 0) continue;

    // ─ Phase 2: Parallel Contextual Retrieval ─
    // hasCrPrefix tristate per row:
    //   true   — CR call succeeded; embedText = prefix + content
    //   false  — CR call failed (per-chunk catch); embedText = raw content
    //   null   — CR was deliberately skipped (--dry-run, --skip-contextual);
    //            chunk has no prefix but degradation isn't an outage signal
    // Persisted to session_chunks.has_cr_prefix so backfill can find chunks
    // that NEED CR re-attempt (false) vs ones that opted out (null).
    const toEmbed: {
      hash: string;
      window: TurnWindow;
      embedText: string;
      hasCrPrefix: boolean | null;
    }[] = [];
    if (args.dryRun || args.skipContextual) {
      for (const c of candidates) {
        toEmbed.push({
          hash: c.hash,
          window: c.window,
          embedText: c.window.text,
          hasCrPrefix: null,
        });
      }
    } else {
      for (const subBatch of chunked(candidates, env.contextualParallel)) {
        const results = await Promise.allSettled(
          subBatch.map((c) =>
            generateContextualPrefix(env, documentText, c.window.text),
          ),
        );
        results.forEach((r, i) => {
          const c = subBatch[i];
          let embedText = c.window.text;
          let hasCrPrefix: boolean | null = false;
          if (r.status === "fulfilled") {
            stats.haikuInputTokens += r.value.inputTokens;
            stats.haikuCacheRead += r.value.cacheRead;
            stats.haikuCacheCreate += r.value.cacheCreate;
            stats.haikuOutputTokens += r.value.outputTokens;
            embedText = concatPrefixWithChunk(r.value.prefix, c.window.text);
            hasCrPrefix = true;
          } else {
            console.warn(
              `  CR failed for ${sessionId} chunk: ${r.reason instanceof Error ? r.reason.message : r.reason}`,
            );
          }
          toEmbed.push({ hash: c.hash, window: c.window, embedText, hasCrPrefix });
        });
      }
    }

    if (toEmbed.length === 0) continue;

    // ─ Phase 3: Token-aware Voyage batching + insert ─
    if (args.dryRun) {
      const totalChars = toEmbed.reduce((sum, x) => sum + x.embedText.length, 0);
      stats.charsEmbedded += totalChars;
      stats.voyageTokens += Math.ceil(totalChars / 3.5);
      stats.windowsInserted += toEmbed.length;
    } else {
      // Session-wide hash dedup tracker. Long sessions produce windows with
      // repeating content_hashes both within a single batch AND across
      // batches. PostgREST's Prefer: resolution=ignore-duplicates fails
      // the entire batch on UNIQUE violation rather than skipping the
      // offending row, so we MUST de-dupe in-process before insert.
      // Scope is per-session (one ingest call) — we don't dedup across
      // sessions because the UNIQUE constraint is per-session.
      const sessionSeenHashes = new Set<string>();
      const voyageBatches = splitIntoVoyageBatches(toEmbed.map((x) => x.embedText));
      let cursor = 0;
      for (const voyageBatch of voyageBatches) {
        const slice = toEmbed.slice(cursor, cursor + voyageBatch.length);
        cursor += voyageBatch.length;
        try {
          const { embeddings, totalTokens } = await embedBatch(
            env, voyageBatch, "document",
          );
          stats.voyageTokens += totalTokens;
          stats.charsEmbedded += voyageBatch.reduce((s, t) => s + t.length, 0);

          // Build candidate rows
          const candidateRows = slice.map((x, i) =>
            buildChunkRow({
              sessionId,
              window: x.window,
              embedding: embeddings[i],
              contentHash: x.hash,
              sourceMachine: source.sourceMachine,
              ingestBatch,
              isMetaFile,
              hasCrPrefix: x.hasCrPrefix,
              owner: env.defaultOwner,
            }),
          );
          // Session-wide dedup by (session_id, content_hash). The UNIQUE
          // constraint fires on the SECOND occurrence within OR across
          // batches even with Prefer: resolution=ignore-duplicates set
          // (which only handles conflicts with EXISTING DB rows, not
          // intra-batch ones, and even existing-row conflicts in a batch
          // can fail-the-batch). Long sessions with repetitive tool_result
          // text produce windows that share content, so the same
          // content_hash appears multiple times within a single voyage
          // batch AND across batches. `sessionSeenHashes` lives outside
          // the voyage-batch loop so it tracks every hash already sent
          // for this session. Without this dedup, a delete-then-re-ingest
          // of a session with repetitive content inserts near-ZERO rows.
          const rows = candidateRows.filter((r) => {
            const h = r.content_hash as string;
            if (sessionSeenHashes.has(h)) return false;
            sessionSeenHashes.add(h);
            return true;
          });
          const result = await insertBatch(env, "session_chunks", rows);
          stats.windowsInserted += result.inserted;
        } catch (err) {
          console.warn(
            `  Voyage embed failed for ${sessionId} sub-batch (${voyageBatch.length} chunks): ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    }
  }
}

// ─── Row builders ─────────────────────────────────────────────────

function buildSessionRowFromState(args: {
  sessionId: string;
  sourceMachine: string;
  sourcePath: string;
  ingestBatch: string;
  messageCount: number;
  startedAt: string | null;
  endedAt: string | null;
  projectPath: string | null;
  summary: string | null;
  owner: string;
}): Record<string, unknown> {
  return {
    session_id: args.sessionId,
    source_machine: args.sourceMachine,
    source_path: args.sourcePath,
    project_path: args.projectPath,
    ingest_batch: args.ingestBatch,
    started_at: args.startedAt,
    ended_at: args.endedAt,
    message_count: args.messageCount,
    byte_size: bytesOf(args.sourcePath),
    summary: args.summary,
    owner: args.owner,
    metadata: {},
  };
}

function buildChunkRow(args: {
  sessionId: string;
  window: TurnWindow;
  embedding: number[];
  contentHash: string;
  sourceMachine: string;
  ingestBatch: string;
  isMetaFile: boolean;
  /** Tristate — true on CR success, false on CR failure, null when CR was
   *  deliberately skipped (--dry-run / --skip-contextual). See migration
   *  20260528043320 for the full semantic. */
  hasCrPrefix: boolean | null;
  owner: string;
}): Record<string, unknown> {
  const firstTurn = args.window.turns[0];
  const role =
    args.window.turns.length === 1 ? firstTurn.role : "mixed";

  // Collect tools across all turns in the window
  const toolsCalled: string[] = [];
  for (const turn of args.window.turns) {
    for (const t of turn.toolsCalled) toolsCalled.push(t);
  }

  const isMetaMessage = args.window.turns.some((t) => t.isMetaMessage);

  return {
    session_id: args.sessionId,
    turn_index: args.window.startIndex,
    role,
    // Sanitize stored content — strip NULL bytes + control chars Postgres rejects
    // (sanitizeUtf8 drops \x00 which causes 22P05 unsupported-Unicode-escape errors)
    content: sanitizeUtf8(args.window.text),
    content_hash: args.contentHash,
    embedding: embeddingToPostgresArray(args.embedding),
    source_machine: args.sourceMachine,
    ingest_batch: args.ingestBatch,
    occurred_at: firstTurn.occurredAt,
    has_cr_prefix: args.hasCrPrefix,
    metadata: {
      end_turn_index: args.window.endIndex,
      window_size: args.window.turns.length,
      tools_called: toolsCalled,
      is_sub_chunk: args.window.isSubChunk ?? false,
      parent_turn_index: args.window.parentIndex ?? null,
      is_meta_file: args.isMetaFile,
      is_meta_message: isMetaMessage,
    },
    owner: args.owner,
  };
}

// ─── Source ingestion dispatchers ─────────────────────────────────

async function ingestClaudeCodeSource(
  env: Env,
  source: SourceConfig,
  ingestBatch: string,
  args: CliArgs,
): Promise<IngestSessionStats> {
  const lister =
    source.type === "cc-jsonl-tree"
      ? listJsonlFilesRecursive
      : listJsonlFilesFlat;
  let files = lister(source.rootPath);
  if (args.maxFileBytes) {
    const cap = args.maxFileBytes;
    const before = files.length;
    files = files.filter((f) => {
      const b = bytesOf(f);
      if (b <= cap) return true;
      console.log(
        `[${source.label}] SKIP oversized ${(b / 1048576).toFixed(0)}MB (OOM guard): ${basename(f)}`,
      );
      return false;
    });
    if (before !== files.length) {
      console.log(
        `[${source.label}] skipped ${before - files.length} file(s) over ${cap} bytes`,
      );
    }
  }
  if (args.maxFiles) files = files.slice(0, args.maxFiles);

  console.log(`[${source.label}] ${files.length} JSONL files`);
  if (!args.dryRun) {
    await updateIngestRun(env, ingestBatch, { files_total: files.length });
  }

  const totals = emptyStats();
  let filesDone = 0;
  let filesFailed = 0;

  for (const filePath of files) {
    try {
      const s = await ingestSession(env, source, filePath, ingestBatch, args);
      filesDone++;
      totals.windowsTotal += s.windowsTotal;
      totals.windowsNew += s.windowsNew;
      totals.windowsQuarantined += s.windowsQuarantined;
      totals.windowsInserted += s.windowsInserted;
      totals.charsEmbedded += s.charsEmbedded;
      totals.voyageTokens += s.voyageTokens;
      totals.haikuInputTokens += s.haikuInputTokens;
      totals.haikuCacheRead += s.haikuCacheRead;
      totals.haikuCacheCreate += s.haikuCacheCreate;
      totals.haikuOutputTokens += s.haikuOutputTokens;

      if (filesDone % 50 === 0 || filesDone === files.length) {
        if (!args.dryRun) {
          await updateIngestRun(env, ingestBatch, {
            files_done: filesDone,
            chunks_inserted: totals.windowsInserted,
            chunks_quarantined: totals.windowsQuarantined,
          });
        }
        console.log(
          `  [${source.label}] ${filesDone}/${files.length}  inserted=${totals.windowsInserted}  quarantine=${totals.windowsQuarantined}  voyage=${totals.voyageTokens}t`,
        );
      }
    } catch (err) {
      filesFailed++;
      console.error(
        `  [${source.label}] FAIL ${filePath}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  if (!args.dryRun) {
    await updateIngestRun(env, ingestBatch, {
      files_done: filesDone,
      files_failed: filesFailed,
      chunks_inserted: totals.windowsInserted,
      chunks_quarantined: totals.windowsQuarantined,
    });
  }
  console.log(
    `[${source.label}] DONE: files=${filesDone}/${files.length} failed=${filesFailed} chunks=${totals.windowsInserted} quarantine=${totals.windowsQuarantined}`,
  );
  return totals;
}

// ─── Claude.ai web export ingestion ───────────────────────────────
// Source: a Claude.ai web-export conversations.json (configure via sources.config.ts)
// Format (per convert_history.py reference):
//   [{ uuid, name?, created_at?, updated_at?, chat_messages: [{sender, text, created_at?}] }, ...]
//
// Each conversation becomes one session in our schema (source_machine='claude-web').
// Messages are single-text turns — no tool blocks, no thinking blocks. Simpler shape.

interface ClaudeWebMessage {
  sender: string; // 'human' | 'assistant'
  text?: string;
  created_at?: string;
}
interface ClaudeWebConversation {
  uuid: string;
  name?: string;
  created_at?: string;
  updated_at?: string;
  chat_messages: ClaudeWebMessage[];
}

async function ingestClaudeWebExport(
  env: Env,
  source: SourceConfig,
  ingestBatch: string,
  args: CliArgs,
): Promise<IngestSessionStats> {
  const totals = emptyStats();

  if (!existsSync(source.rootPath)) {
    console.log(`[${source.label}] file not found: ${source.rootPath}`);
    return totals;
  }

  console.log(`[${source.label}] loading ${source.rootPath}...`);
  let conversations: ClaudeWebConversation[];
  try {
    const text = readFileSync(source.rootPath, "utf8");
    conversations = JSON.parse(text) as ClaudeWebConversation[];
  } catch (err) {
    console.error(
      `[${source.label}] failed to parse JSON: ${err instanceof Error ? err.message : err}`,
    );
    return totals;
  }
  console.log(`[${source.label}] ${conversations.length} conversations`);

  if (!args.dryRun) {
    await updateIngestRun(env, ingestBatch, { files_total: conversations.length });
  }

  let convsDone = 0;
  let convsFailed = 0;

  for (const conv of conversations) {
    if (!conv.uuid || !conv.chat_messages || conv.chat_messages.length === 0) {
      convsDone++;
      continue;
    }

    try {
      // Build lightweight ProjectedTurn list directly from web format
      const turns: ProjectedTurn[] = [];
      let firstTs: string | null = null;
      let lastTs: string | null = null;
      let turnIdx = 0;

      for (const msg of conv.chat_messages) {
        const text = (msg.text ?? "").trim();
        if (!text) continue;
        const role: "user" | "assistant" =
          msg.sender === "human" ? "user" : "assistant";
        const ts = msg.created_at ?? conv.created_at ?? null;
        if (ts) {
          if (!firstTs || ts < firstTs) firstTs = ts;
          if (!lastTs || ts > lastTs) lastTs = ts;
        }
        turns.push({
          text,
          turn_index: turnIdx,
          role,
          occurredAt: ts,
          toolsCalled: [],
          isMetaMessage: false,
        });
        turnIdx++;

      }

      if (turns.length === 0) {
        convsDone++;
        continue;
      }

      const windows = groupTurnsIntoWindows(turns);
      totals.windowsTotal += windows.length;
      if (windows.length === 0) {
        convsDone++;
        continue;
      }

      const { documentText, newWindows } = await scanAndDedupeWindows({
        windows, sessionKey: conv.uuid, env, dryRun: args.dryRun,
      });
      totals.windowsNew += newWindows.length;
      if (newWindows.length === 0) {
        convsDone++;
        continue;
      }

      if (!args.dryRun) {
        await upsertSession(env, {
          session_id: conv.uuid,
          source_machine: source.sourceMachine,
          source_path: `${source.rootPath}#${conv.uuid}`,
          project_path: null,
          ingest_batch: ingestBatch,
          started_at: firstTs ?? conv.created_at ?? null,
          ended_at: lastTs ?? conv.updated_at ?? null,
          message_count: conv.chat_messages.length,
          byte_size: 0,
          summary: conv.name ?? null,
          owner: env.defaultOwner,
          metadata: { conv_name: conv.name ?? null },
        });
      }

      await persistChunkBatches(
        env, args, source, conv.uuid, source.rootPath, newWindows,
        documentText, false, ingestBatch, totals,
      );

      convsDone++;
      if (convsDone % 100 === 0 || convsDone === conversations.length) {
        if (!args.dryRun) {
          await updateIngestRun(env, ingestBatch, {
            files_done: convsDone,
            files_failed: convsFailed,
            chunks_inserted: totals.windowsInserted,
            chunks_quarantined: totals.windowsQuarantined,
          });
        }
        console.log(
          `  [${source.label}] ${convsDone}/${conversations.length}  inserted=${totals.windowsInserted}  quarantine=${totals.windowsQuarantined}`,
        );
      }
    } catch (err) {
      convsFailed++;
      console.error(
        `  [${source.label}] FAIL ${conv.uuid}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  if (!args.dryRun) {
    await updateIngestRun(env, ingestBatch, {
      files_done: convsDone,
      files_failed: convsFailed,
      chunks_inserted: totals.windowsInserted,
      chunks_quarantined: totals.windowsQuarantined,
    });
  }
  console.log(
    `[${source.label}] DONE: convs=${convsDone}/${conversations.length} failed=${convsFailed} chunks=${totals.windowsInserted} quarantine=${totals.windowsQuarantined}`,
  );
  return totals;
}

// ─── ChatGPT web export ingestion ─────────────────────────────────
// conversations.json = array of conversations, each with a `mapping` graph of
// message nodes. We linearize the canonical thread by walking from
// `current_node` up through `parent` pointers (fallback: all message nodes by
// create_time), then project user/assistant text turns. Non-text content_types,
// system/tool authors, and visually-hidden nodes are skipped. Each conversation
// = one session (source_machine='chatgpt-web').

interface ChatGptNode {
  id: string;
  message?: {
    author?: { role?: string };
    create_time?: number | null;
    content?: { content_type?: string; parts?: unknown[] };
    metadata?: { is_visually_hidden_from_conversation?: boolean };
  } | null;
  parent?: string | null;
  children?: string[];
}
interface ChatGptConversation {
  title?: string;
  create_time?: number | null;
  update_time?: number | null;
  mapping: Record<string, ChatGptNode>;
  current_node?: string | null;
  conversation_id?: string;
  id?: string;
}

function unixToIso(t: number | null | undefined): string | null {
  if (typeof t !== "number" || !Number.isFinite(t)) return null;
  return new Date(t * 1000).toISOString();
}

// Walk current_node → parent to root, return root→leaf ordered nodes.
function linearizeChatGptMapping(conv: ChatGptConversation): ChatGptNode[] {
  const map = conv.mapping;
  let cur = conv.current_node ?? null;
  if (cur && map[cur]) {
    const ordered: ChatGptNode[] = [];
    const seen = new Set<string>();
    while (cur && map[cur] && !seen.has(cur)) {
      seen.add(cur);
      ordered.push(map[cur]);
      cur = map[cur].parent ?? null;
    }
    ordered.reverse();
    return ordered;
  }
  // Fallback: no usable current_node — take all message nodes by create_time.
  const nodes = Object.values(map).filter((n) => n.message);
  nodes.sort(
    (a, b) => (a.message?.create_time ?? 0) - (b.message?.create_time ?? 0),
  );
  return nodes;
}

function chatGptNodeText(node: ChatGptNode): string | null {
  const m = node.message;
  if (!m) return null;
  const role = m.author?.role;
  if (role !== "user" && role !== "assistant") return null;
  if (m.metadata?.is_visually_hidden_from_conversation) return null;
  const parts = m.content?.parts;
  if (!Array.isArray(parts)) return null;
  const text = parts
    .filter((p): p is string => typeof p === "string")
    .join("\n")
    .trim();
  return text || null;
}

async function ingestChatGptExport(
  env: Env,
  source: SourceConfig,
  ingestBatch: string,
  args: CliArgs,
): Promise<IngestSessionStats> {
  const totals = emptyStats();

  if (!existsSync(source.rootPath)) {
    console.log(`[${source.label}] file not found: ${source.rootPath}`);
    return totals;
  }

  console.log(`[${source.label}] loading ${source.rootPath}...`);
  let conversations: ChatGptConversation[];
  try {
    conversations = JSON.parse(
      readFileSync(source.rootPath, "utf8"),
    ) as ChatGptConversation[];
  } catch (err) {
    console.error(
      `[${source.label}] failed to parse JSON: ${err instanceof Error ? err.message : err}`,
    );
    return totals;
  }
  console.log(`[${source.label}] ${conversations.length} conversations`);

  if (!args.dryRun) {
    await updateIngestRun(env, ingestBatch, {
      files_total: conversations.length,
    });
  }

  let convsDone = 0;
  let convsFailed = 0;

  for (const conv of conversations) {
    const sessionId = conv.conversation_id ?? conv.id;
    if (!sessionId || !conv.mapping) {
      convsDone++;
      continue;
    }
    try {
      const nodes = linearizeChatGptMapping(conv);
      const turns: ProjectedTurn[] = [];
      let firstTs: string | null = null;
      let lastTs: string | null = null;
      let turnIdx = 0;

      for (const node of nodes) {
        const text = chatGptNodeText(node);
        if (!text) continue;
        const role: "user" | "assistant" =
          node.message?.author?.role === "user" ? "user" : "assistant";
        const ts = unixToIso(node.message?.create_time);
        if (ts) {
          if (!firstTs || ts < firstTs) firstTs = ts;
          if (!lastTs || ts > lastTs) lastTs = ts;
        }
        turns.push({
          text,
          turn_index: turnIdx,
          role,
          occurredAt: ts,
          toolsCalled: [],
          isMetaMessage: false,
        });
        turnIdx++;

      }

      if (turns.length === 0) {
        convsDone++;
        continue;
      }

      const windows = groupTurnsIntoWindows(turns);
      totals.windowsTotal += windows.length;
      if (windows.length === 0) {
        convsDone++;
        continue;
      }

      const { documentText, newWindows } = await scanAndDedupeWindows({
        windows, sessionKey: sessionId, env, dryRun: args.dryRun,
      });
      totals.windowsNew += newWindows.length;
      if (newWindows.length === 0) {
        convsDone++;
        continue;
      }

      if (!args.dryRun) {
        await upsertSession(env, {
          session_id: sessionId,
          source_machine: source.sourceMachine,
          source_path: `${source.rootPath}#${sessionId}`,
          project_path: null,
          ingest_batch: ingestBatch,
          started_at: firstTs ?? unixToIso(conv.create_time),
          ended_at: lastTs ?? unixToIso(conv.update_time),
          message_count: turns.length,
          byte_size: 0,
          summary: conv.title ?? null,
          owner: env.defaultOwner,
          metadata: { conv_title: conv.title ?? null },
        });
      }

      await persistChunkBatches(
        env, args, source, sessionId, source.rootPath, newWindows,
        documentText, false, ingestBatch, totals,
      );

      convsDone++;
      if (convsDone % 100 === 0 || convsDone === conversations.length) {
        if (!args.dryRun) {
          await updateIngestRun(env, ingestBatch, {
            files_done: convsDone,
            files_failed: convsFailed,
            chunks_inserted: totals.windowsInserted,
            chunks_quarantined: totals.windowsQuarantined,
          });
        }
        console.log(
          `  [${source.label}] ${convsDone}/${conversations.length}  inserted=${totals.windowsInserted}  quarantine=${totals.windowsQuarantined}`,
        );
      }
    } catch (err) {
      convsFailed++;
      console.error(
        `  [${source.label}] FAIL ${sessionId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  if (!args.dryRun) {
    await updateIngestRun(env, ingestBatch, {
      files_done: convsDone,
      files_failed: convsFailed,
      chunks_inserted: totals.windowsInserted,
      chunks_quarantined: totals.windowsQuarantined,
    });
  }
  console.log(
    `[${source.label}] DONE: convs=${convsDone}/${conversations.length} failed=${convsFailed} chunks=${totals.windowsInserted} quarantine=${totals.windowsQuarantined}`,
  );
  return totals;
}

// ─── Telegram export ingestion ────────────────────────────────────
// rootPath is a directory holding ChatExport_*/result.json. Each result.json
// is one chat (one session). messages[] carry `text` as a string OR a rich
// array of entity parts; we flatten both. `type:'service'` messages are
// skipped. Bot-chat role mapping: sender matching the chat name = assistant.

interface TelegramMessage {
  id: number;
  type?: string;
  date?: string;
  from?: string;
  text?: unknown; // string | Array<string | {type:string; text:string}>
}
interface TelegramResult {
  name?: string;
  type?: string;
  id?: number | string;
  messages?: TelegramMessage[];
}

function flattenTelegramText(text: unknown): string {
  if (typeof text === "string") return text;
  if (Array.isArray(text)) {
    return text
      .map((p) =>
        typeof p === "string" ? p : ((p as { text?: string })?.text ?? ""),
      )
      .join("");
  }
  return "";
}

async function ingestTelegramExport(
  env: Env,
  source: SourceConfig,
  ingestBatch: string,
  args: CliArgs,
): Promise<IngestSessionStats> {
  const totals = emptyStats();

  if (!existsSync(source.rootPath)) {
    console.log(`[${source.label}] dir not found: ${source.rootPath}`);
    return totals;
  }

  // Each ChatExport_*/result.json = one chat = one session.
  const resultFiles: { rj: string; dirName: string }[] = [];
  for (const entry of readdirSync(source.rootPath, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const rj = join(source.rootPath, entry.name, "result.json");
    if (existsSync(rj)) resultFiles.push({ rj, dirName: entry.name });
  }
  console.log(`[${source.label}] ${resultFiles.length} chat export(s)`);

  if (!args.dryRun) {
    await updateIngestRun(env, ingestBatch, { files_total: resultFiles.length });
  }

  let done = 0;
  let failed = 0;

  for (const { rj, dirName } of resultFiles) {
    try {
      const result = JSON.parse(readFileSync(rj, "utf8")) as TelegramResult;
      const chatName = result.name ?? dirName;
      const sessionId = `telegram-${result.id ?? dirName}`;
      const msgs = result.messages ?? [];

      const turns: ProjectedTurn[] = [];
      let firstTs: string | null = null;
      let lastTs: string | null = null;
      let turnIdx = 0;

      for (const msg of msgs) {
        if (msg.type !== "message") continue;
        const text = flattenTelegramText(msg.text).trim();
        if (!text) continue;
        const role: "user" | "assistant" =
          msg.from && msg.from === chatName ? "assistant" : "user";
        const ts = msg.date ?? null;
        if (ts) {
          if (!firstTs || ts < firstTs) firstTs = ts;
          if (!lastTs || ts > lastTs) lastTs = ts;
        }
        turns.push({
          text,
          turn_index: turnIdx,
          role,
          occurredAt: ts,
          toolsCalled: [],
          isMetaMessage: false,
        });
        turnIdx++;

      }

      if (turns.length === 0) {
        done++;
        continue;
      }

      const windows = groupTurnsIntoWindows(turns);
      totals.windowsTotal += windows.length;
      if (windows.length === 0) {
        done++;
        continue;
      }

      const { documentText, newWindows } = await scanAndDedupeWindows({
        windows, sessionKey: sessionId, env, dryRun: args.dryRun,
      });
      totals.windowsNew += newWindows.length;
      if (newWindows.length === 0) {
        done++;
        continue;
      }

      if (!args.dryRun) {
        await upsertSession(env, {
          session_id: sessionId,
          source_machine: source.sourceMachine,
          source_path: rj,
          project_path: null,
          ingest_batch: ingestBatch,
          started_at: firstTs,
          ended_at: lastTs,
          message_count: turns.length,
          byte_size: 0,
          summary: chatName,
          owner: env.defaultOwner,
          metadata: { chat_name: chatName },
        });
      }

      await persistChunkBatches(
        env, args, source, sessionId, rj, newWindows,
        documentText, false, ingestBatch, totals,
      );
      done++;
      console.log(
        `  [${source.label}] ${done}/${resultFiles.length} (${chatName})  inserted=${totals.windowsInserted}  quarantine=${totals.windowsQuarantined}`,
      );
    } catch (err) {
      failed++;
      console.error(
        `  [${source.label}] FAIL ${rj}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  if (!args.dryRun) {
    await updateIngestRun(env, ingestBatch, {
      files_done: done,
      files_failed: failed,
      chunks_inserted: totals.windowsInserted,
      chunks_quarantined: totals.windowsQuarantined,
    });
  }
  console.log(
    `[${source.label}] DONE: chats=${done}/${resultFiles.length} failed=${failed} chunks=${totals.windowsInserted} quarantine=${totals.windowsQuarantined}`,
  );
  return totals;
}

// ─── Memory file ingestion ────────────────────────────────────────
// Walks a configured directory of markdown knowledge artifacts and indexes them
// into the memory_chunks table for hybrid search, separate from session_chunks.
// The directory is the memory source's rootPath — point it at your own notes or
// memory tree via src/sources.config.ts (see the .example). Every *.md becomes
// one chunk; files matching /handoff/ are typed 'handoff'.

interface MemoryFileSpec {
  path: string;
  sourceType: "memory" | "observation" | "handoff" | "timeline" | "briefing" | "doctrine";
  chunkBy: "file" | "hr-separator" | "h2-section";
}

function collectMemorySpecs(memDir: string): MemoryFileSpec[] {
  const specs: MemoryFileSpec[] = [];
  if (!existsSync(memDir)) return specs;

  // Every *.md in the configured memory dir → one memory chunk (MEMORY.md index
  // skipped — it's just pointers). Files matching /handoff/ are typed 'handoff'.
  for (const f of readdirSync(memDir)) {
    if (!f.endsWith(".md") || f === "MEMORY.md") continue;
    const isHandoff = /handoff/i.test(f);
    specs.push({
      path: join(memDir, f),
      sourceType: isHandoff ? "handoff" : "memory",
      chunkBy: "file", // memory files are usually one logical unit
    });
  }

  return specs;
}

interface MemoryChunkInput {
  source_path: string;
  source_type: string;
  section_title: string | null;
  content: string;
  /** Optional — when set, used directly. When unset, ingestMemoryFiles
   *  falls back to statSync(source_path).mtime. A synthetic source path
   *  (one with no real file on disk) MUST set this; the statSync fallback
   *  would catch + return null and lose recency information. */
  last_modified?: string | null;
  /** Optional — merged into the persisted memory_chunks.metadata jsonb.
   *  Synthetic-source ingests can use it to carry source ids, etc., for
   *  citation context. */
  metadata?: Record<string, unknown>;
}

function chunkMarkdownFile(spec: MemoryFileSpec): MemoryChunkInput[] {
  let text: string;
  try {
    text = readFileSync(spec.path, "utf8");
  } catch {
    return [];
  }
  if (!text.trim()) return [];

  const out: MemoryChunkInput[] = [];

  if (spec.chunkBy === "file") {
    // Whole file as one chunk; sub-chunk only if very large
    const sections = text.length > 8000 ? splitOversizedMarkdown(text, 6000) : [text];
    for (const s of sections) {
      const title = extractFirstHeading(s);
      out.push({
        source_path: spec.path,
        source_type: spec.sourceType,
        section_title: title,
        content: s.trim(),
      });
    }
  } else if (spec.chunkBy === "hr-separator") {
    // Split by lines containing only ---
    const parts = text.split(/\n---+\n/g).map((s) => s.trim()).filter((s) => s.length > 20);
    for (const p of parts) {
      out.push({
        source_path: spec.path,
        source_type: spec.sourceType,
        section_title: extractFirstHeading(p),
        content: p,
      });
    }
  } else if (spec.chunkBy === "h2-section") {
    // Split by ## headers; keep header with section
    const sections = text.split(/(?=^## )/gm).map((s) => s.trim()).filter((s) => s.length > 20);
    for (const s of sections) {
      out.push({
        source_path: spec.path,
        source_type: spec.sourceType,
        section_title: extractFirstHeading(s),
        content: s,
      });
    }
  }
  return out;
}

function extractFirstHeading(text: string): string | null {
  const m = text.match(/^#+\s+(.+)$/m);
  return m ? m[1].trim().slice(0, 200) : null;
}

function splitOversizedMarkdown(text: string, targetChars: number): string[] {
  if (text.length <= targetChars) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + targetChars, text.length);
    if (end < text.length) {
      const lastPara = text.lastIndexOf("\n\n", end);
      if (lastPara > start + targetChars * 0.5) end = lastPara + 2;
    }
    chunks.push(text.slice(start, end).trim());
    start = end;
  }
  return chunks.filter((c) => c.length > 20);
}

async function ingestMemoryFiles(
  env: Env,
  source: SourceConfig,
  ingestBatch: string,
  args: CliArgs,
): Promise<IngestSessionStats> {
  const stats = emptyStats();
  const specs = collectMemorySpecs(source.rootPath);
  console.log(`[${source.label}] ${specs.length} memory artifact files`);

  // Collect all chunks across all files first
  const allChunks: MemoryChunkInput[] = [];
  for (const spec of specs) {
    const chunks = chunkMarkdownFile(spec);
    allChunks.push(...chunks);
  }
  console.log(`[${source.label}] expanded to ${allChunks.length} memory chunks`);

  if (!args.dryRun) {
    await updateIngestRun(env, ingestBatch, {
      files_total: specs.length,
      files_done: 0,
    });
  }

  // Hash + dedup against memory_chunks
  const hashes = allChunks.map((c) => contentHash(c.content));
  let existing = new Set<string>();
  if (!args.dryRun) {
    existing = await getExistingHashes(env, "memory_chunks", hashes, "source_path");
  }
  const newChunks: { chunk: MemoryChunkInput; hash: string }[] = [];
  for (let i = 0; i < allChunks.length; i++) {
    // Dedup is scoped per source_path, matching the UNIQUE constraint — an
    // identical chunk in a DIFFERENT memory file is a legitimate new row.
    if (!existing.has(`${allChunks[i].source_path} ${hashes[i]}`)) {
      newChunks.push({ chunk: allChunks[i], hash: hashes[i] });
    }
  }
  console.log(`[${source.label}] ${newChunks.length} new chunks (${allChunks.length - newChunks.length} already in DB)`);

  if (newChunks.length === 0) {
    if (!args.dryRun) {
      await updateIngestRun(env, ingestBatch, { files_done: specs.length });
    }
    return stats;
  }

  // Privacy + embed + insert in batches
  stats.windowsTotal = newChunks.length;
  for (const batch of chunked(newChunks, EMBED_BATCH_SIZE)) {
    const quarantined: ReturnType<typeof buildQuarantineRow>[] = [];
    const toEmbed: { hash: string; chunk: MemoryChunkInput; embedText: string }[] = [];

    for (const { chunk, hash } of batch) {
      const verdict = privacyPreScan(chunk.content);
      if (!verdict.pass) {
        quarantined.push(
          buildQuarantineRow({
            source_table: "memory_chunks",
            source_path: chunk.source_path,
            session_id: null,
            content: chunk.content,
            verdict,
            ingest_batch: ingestBatch,
          }),
        );
      } else {
        toEmbed.push({ hash, chunk, embedText: chunk.content });
      }
    }

    if (quarantined.length > 0) {
      stats.windowsQuarantined += quarantined.length;
      if (!args.dryRun) {
        await insertBatch(env, "quarantine", quarantined as unknown as Record<string, unknown>[]);
      }
    }

    if (toEmbed.length === 0) continue;

    if (args.dryRun) {
      const totalChars = toEmbed.reduce((s, x) => s + x.embedText.length, 0);
      stats.charsEmbedded += totalChars;
      stats.voyageTokens += Math.ceil(totalChars / 3.5);
      stats.windowsInserted += toEmbed.length;
    } else {
      const voyageBatches = splitIntoVoyageBatches(toEmbed.map((x) => x.embedText));
      let cursor = 0;
      for (const vb of voyageBatches) {
        const slice = toEmbed.slice(cursor, cursor + vb.length);
        cursor += vb.length;
        const { embeddings, totalTokens } = await embedBatch(env, vb, "document");
        stats.voyageTokens += totalTokens;
        stats.charsEmbedded += vb.reduce((s, t) => s + t.length, 0);
        const rows = slice.map((x, i) => ({
          source_path: x.chunk.source_path,
          source_type: x.chunk.source_type,
          section_title: x.chunk.section_title,
          content: sanitizeUtf8(x.chunk.content),
          content_hash: x.hash,
          embedding: embeddingToPostgresArray(embeddings[i]),
          source_machine: source.sourceMachine,
          ingest_batch: ingestBatch,
          last_modified: x.chunk.last_modified !== undefined
            ? x.chunk.last_modified
            : (() => {
                try {
                  return statSync(x.chunk.source_path).mtime.toISOString();
                } catch {
                  return null;
                }
              })(),
          metadata: x.chunk.metadata ?? {},
          owner: env.defaultOwner,
        }));
        const result = await insertBatch(env, "memory_chunks", rows);
        stats.windowsInserted += result.inserted;
      }
    }
  }

  if (!args.dryRun) {
    await updateIngestRun(env, ingestBatch, {
      files_done: specs.length,
      chunks_inserted: stats.windowsInserted,
      chunks_quarantined: stats.windowsQuarantined,
    });
  }
  console.log(
    `[${source.label}] DONE: inserted=${stats.windowsInserted}/${newChunks.length} quarantined=${stats.windowsQuarantined}`,
  );
  return stats;
}

// ─── Cost estimation ──────────────────────────────────────────────

function printCostEstimate(
  env: Env,
  totals: IngestSessionStats,
  args: CliArgs,
): void {
  const VOYAGE_3L_PER_M = 0.12;

  // Provider-specific Contextual Retrieval pricing (per million tokens)
  // Anthropic Haiku 4.5: cached $0.025, uncached $0.25, cache_write $0.30, output $1.25
  // DeepSeek V3.1:       cache_hit $0.014, cache_miss $0.27, output $0.28
  let cachedPerM: number;
  let uncachedPerM: number;
  let cacheWritePerM: number;
  let outputPerM: number;

  if (env.contextualProvider === "deepseek") {
    cachedPerM = 0.014;
    uncachedPerM = 0.27;
    cacheWritePerM = 0.27; // DeepSeek doesn't separate writes — same as miss
    outputPerM = 0.28;
  } else {
    cachedPerM = 0.025;
    uncachedPerM = 0.25;
    cacheWritePerM = 0.3;
    outputPerM = 1.25;
  }

  const voyageCost = (totals.voyageTokens / 1_000_000) * VOYAGE_3L_PER_M;
  const crUncached = Math.max(
    0,
    totals.haikuInputTokens - totals.haikuCacheRead - totals.haikuCacheCreate,
  );
  const crCost =
    (crUncached / 1_000_000) * uncachedPerM +
    (totals.haikuCacheRead / 1_000_000) * cachedPerM +
    (totals.haikuCacheCreate / 1_000_000) * cacheWritePerM +
    (totals.haikuOutputTokens / 1_000_000) * outputPerM;

  const provider = env.contextualProvider;
  const model =
    provider === "deepseek" ? env.contextualDeepseekModel : env.contextualHaikuModel;

  console.log("\n── Cost summary ──");
  console.log(
    `  Voyage:  ${totals.voyageTokens.toLocaleString()} tokens → $${voyageCost.toFixed(2)} (model: ${env.embeddingModel})`,
  );
  if (!args.skipContextual) {
    const cacheLabel = provider === "deepseek" ? "cache_hit" : "cached";
    const writeLabel = provider === "deepseek" ? "cache_miss" : "write";
    console.log(
      `  ${provider} CR (${model}): input=${totals.haikuInputTokens.toLocaleString()} (${cacheLabel}=${totals.haikuCacheRead.toLocaleString()}, ${writeLabel}=${totals.haikuCacheCreate.toLocaleString()}), output=${totals.haikuOutputTokens.toLocaleString()} → $${crCost.toFixed(4)}`,
    );
  } else {
    console.log("  Contextual Retrieval: SKIPPED (--skip-contextual)");
  }
  console.log(`  TOTAL: $${(voyageCost + crCost).toFixed(4)}`);
}

// ─── Main ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();
  const env = loadEnv();

  console.log(`\n${"=".repeat(70)}`);
  console.log(`${env.productName} bootstrap ${args.dryRun ? "(DRY RUN)" : "(LIVE)"}`);
  console.log("=".repeat(70));
  console.log(`Source filter: ${args.source ?? "all"}`);
  console.log(`Skip contextual: ${args.skipContextual}`);
  if (args.maxFiles) console.log(`Max files per source: ${args.maxFiles}`);

  if (!args.dryRun) {
    const ok = await pingSupabase(env);
    if (!ok) throw new Error("Supabase ping failed — check creds + URL");
    console.log("Supabase ✓");
  }

  // ─── Single-file mode (for SessionEnd hook) ───────────────────────
  if (args.file) {
    const filePath = args.file;
    if (!existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }
    const sourceMachine = deriveSourceMachineFromPath(filePath);
    const source: SourceConfig = {
      label: `incremental-${sourceMachine}`,
      type: "cc-jsonl-flat",
      rootPath: filePath.substring(0, filePath.lastIndexOf("/")),
      sourceMachine,
    };
    console.log(`\nSingle-file mode: ${filePath}`);
    console.log(`  source_machine: ${sourceMachine}`);

    let ingestBatch = "00000000-0000-0000-0000-000000000000";
    if (!args.dryRun) {
      ingestBatch = await beginIngestRun(env, source.label);
    }

    try {
      const stats = await ingestSession(env, source, filePath, ingestBatch, args);
      if (!args.dryRun) {
        await updateIngestRun(env, ingestBatch, {
          files_total: 1,
          files_done: 1,
          files_failed: 0,
          chunks_inserted: stats.windowsInserted,
          chunks_quarantined: stats.windowsQuarantined,
        });
        await finishIngestRun(env, ingestBatch, "completed");
      }
      console.log(
        `Done: ${stats.windowsInserted} inserted, ${stats.windowsQuarantined} quarantined, ${stats.windowsTotal} total windows`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!args.dryRun) {
        await finishIngestRun(env, ingestBatch, "failed", msg);
      }
      throw err;
    }
    return;
  }

  const allSources = await loadSources();
  const sources = args.source
    ? allSources.filter((s) => s.label === args.source)
    : allSources;
  if (sources.length === 0) {
    throw new Error(`No matching source for filter: ${args.source}`);
  }

  const grandTotals = emptyStats();

  for (const source of sources) {
    console.log(`\n── source: ${source.label} (${source.sourceMachine}) ──`);
    console.log(`   path: ${source.rootPath}`);

    let ingestBatch = "00000000-0000-0000-0000-000000000000";
    if (!args.dryRun) {
      ingestBatch = await beginIngestRun(env, source.label);
    }

    try {
      let sourceTotals: IngestSessionStats;
      switch (source.type) {
        case "cc-jsonl-tree":
        case "cc-jsonl-flat":
          sourceTotals = await ingestClaudeCodeSource(
            env,
            source,
            ingestBatch,
            args,
          );
          break;
        case "claude-web-export":
          sourceTotals = await ingestClaudeWebExport(
            env,
            source,
            ingestBatch,
            args,
          );
          break;
        case "chatgpt-export":
          sourceTotals = await ingestChatGptExport(
            env,
            source,
            ingestBatch,
            args,
          );
          break;
        case "telegram-export":
          sourceTotals = await ingestTelegramExport(
            env,
            source,
            ingestBatch,
            args,
          );
          break;
        case "memory-tree":
          sourceTotals = await ingestMemoryFiles(env, source, ingestBatch, args);
          break;
      }

      // Aggregate for grand total
      grandTotals.windowsTotal += sourceTotals.windowsTotal;
      grandTotals.windowsNew += sourceTotals.windowsNew;
      grandTotals.windowsQuarantined += sourceTotals.windowsQuarantined;
      grandTotals.windowsInserted += sourceTotals.windowsInserted;
      grandTotals.charsEmbedded += sourceTotals.charsEmbedded;
      grandTotals.voyageTokens += sourceTotals.voyageTokens;
      grandTotals.haikuInputTokens += sourceTotals.haikuInputTokens;
      grandTotals.haikuCacheRead += sourceTotals.haikuCacheRead;
      grandTotals.haikuCacheCreate += sourceTotals.haikuCacheCreate;
      grandTotals.haikuOutputTokens += sourceTotals.haikuOutputTokens;

      if (!args.dryRun) {
        await finishIngestRun(env, ingestBatch, "completed");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Source ${source.label} failed: ${msg}`);
      if (!args.dryRun) {
        await finishIngestRun(env, ingestBatch, "failed", msg);
      }
      throw err;
    }
  }

  console.log(`\n${"─".repeat(70)}`);
  console.log("GRAND TOTALS");
  console.log("─".repeat(70));
  console.log(`  Windows: ${grandTotals.windowsInserted.toLocaleString()} inserted, ${grandTotals.windowsQuarantined.toLocaleString()} quarantined (of ${grandTotals.windowsTotal.toLocaleString()} total)`);
  console.log(`  Chars embedded: ${grandTotals.charsEmbedded.toLocaleString()}`);
  printCostEstimate(env, grandTotals, args);

  console.log(
    `\nDone${args.dryRun ? " (dry run — no data written)" : ""}.`,
  );
}

main().catch((err) => {
  console.error(`\nFATAL: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
