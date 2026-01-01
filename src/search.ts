// src/search.ts — Query-side helpers for the MCP server.
//
// Pipeline per query:
//   1. Embed query via Voyage (input_type="query" — asymmetric)
//   2. hybrid_search_*_recency RPC (RRF k=60, vector + tsvector + optional recency)
//   3. Optionally rerank top candidates via the configured reranker
//   4. Return shaped results
//
// searchMode='current' biases retrieval toward newer chunks, suppressing the
// stale-design-chatter failure mode (newer resolutions outrank old discussion).

import type { Env } from "./env.js";
import {
  makeAnthropicHeaders as _unusedAnthropic, // not used here, kept exported elsewhere
  makeSupabaseHeaders,
  makeSupabaseHeadersWithReturn,
  makeVoyageHeaders,
} from "./env.js";
import { embedBatch } from "./embedding.js";
import { loadConfig } from "./config.js";

void _unusedAnthropic; // silence unused-warning if tsconfig flags it

// Genericization layer — neutral public defaults, env-overridable (see src/config.ts).
const cfg = loadConfig();

// ─── Query embedding ──────────────────────────────────────────────

/** Embed a single query string with input_type="query" for asymmetric retrieval. */
export async function embedQuery(env: Env, text: string): Promise<number[]> {
  const { embeddings } = await embedBatch(env, [text], "query");
  return embeddings[0];
}

// ─── Hybrid search RPCs ───────────────────────────────────────────

export interface SessionChunkRow {
  chunk_id: string;
  session_id: string;
  turn_index: number;
  role: string;
  content: string;
  source_machine: string;
  occurred_at: string | null;
  metadata: Record<string, unknown>;
  owner: string;
}

export interface MemoryChunkRow {
  chunk_id: string;
  source_path: string;
  source_type: string;
  section_title: string | null;
  content: string;
  source_machine: string;
  last_modified: string | null;
  metadata: Record<string, unknown>;
  owner: string;
}

function restUrl(env: Env, path: string): string {
  return `${env.supabaseUrl.replace(/\/$/, "")}/rest/v1/${path}`;
}

function pgVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

/**
 * Search mode controls the retrieval ranking shape.
 *
 *   'balanced'  Pure RRF (semantic + lexical). Optimal for historical queries.
 *   'current'   Same RRF plus a recency rank dimension. Optimal for
 *               "what's the current state of X" queries where newer chunks
 *               should outrank older design-phase chatter on the same topic.
 *   'auto'      Detect via detectSearchMode(query) on common current-state
 *               keywords; falls through to 'balanced' otherwise.
 */
export type SearchMode = "balanced" | "current" | "auto";

const CURRENT_STATE_PATTERNS: RegExp[] = [
  /\b(current(?:ly)?|now|today|latest|recent(?:ly)?|ongoing|still)\b/i,
  /\bwhere (are we|do we stand|am i)\b/i,
  /\bwhat'?s? (left|next|the (current|latest) (state|status))\b/i,
  /\b(status|state) (of|on)\b/i,
  /\bright now\b/i,
  /\bas of (now|today)\b/i,
];

/** Returns 'current' if the query reads like a current-state question, else 'balanced'. */
export function detectSearchMode(query: string): "balanced" | "current" {
  for (const p of CURRENT_STATE_PATTERNS) {
    if (p.test(query)) return "current";
  }
  return "balanced";
}

/** Resolve a user-facing SearchMode (including 'auto') to a concrete weighting decision. */
export function resolveSearchMode(mode: SearchMode, query: string): "balanced" | "current" {
  if (mode === "auto") return detectSearchMode(query);
  return mode;
}

export interface HybridSearchOptions {
  matchCount?: number;
  fullTextWeight?: number;
  semanticWeight?: number;
  recencyWeight?: number;
  rrfK?: number;
  ownerFilter?: string;
  searchMode?: SearchMode;
}

/** Pick recency_weight for a given resolved mode (current=1.0, balanced=0.0). */
function recencyWeightFor(resolved: "balanced" | "current"): number {
  return resolved === "current" ? 1.0 : 0.0;
}

/**
 * RPC statuses where retrying-once-then-returning-empty is the right move:
 *   408  Request Timeout
 *   500  Server Error (Supabase wraps statement_timeout this way)
 *   503  Service Unavailable
 *   504  Gateway Timeout
 * These are operational failures of the database tier, not bugs on our side.
 * Pattern parallels DEEPSEEK_FALLBACK_STATUSES in callSynthesisLLM (2026-05-28).
 *
 * Other 4xx (400 malformed, 401 auth, 403 forbidden) bubble up as hard errors
 * so config rot doesn't get masked.
 */
const RPC_RETRY_STATUSES = new Set([408, 500, 503, 504]);

/**
 * POST a hybrid-search RPC with one retry-then-empty fallback for transient
 * DB-tier failures (statement timeout, gateway timeout, server overload).
 *
 * Why this exists: on small Postgres compute tiers, concurrent search load
 * can saturate the instance — queries that complete in 3-5s at idle hit the
 * 60s statement_timeout when several race, surfacing as uncaught
 * `hybridSearchSessions: 500 statement timeout` errors.
 *
 * The fix is structural (not a perf improvement): same code as before, but
 * a single timeout no longer crashes the CLI. One retry after 1.5s — the
 * second attempt usually succeeds because by then the contending query has
 * released its locks. If even that fails, return an empty array + write a
 * stderr line so the degradation is observable in real time without
 * polluting stdout.
 *
 * Hard-fails on 4xx (auth, malformed) by NOT catching — same discipline as
 * DEEPSEEK_FALLBACK_STATUSES.
 */
async function rpcWithRetry<T>(
  env: Env,
  rpcName: string,
  body: unknown,
): Promise<T[]> {
  const url = restUrl(env, `rpc/${rpcName}`);
  const headers = makeSupabaseHeadersWithReturn(env);
  for (let attempt = 1; attempt <= 2; attempt++) {
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      // Network-level failure (EPIPE, DNS, connection reset, etc) —
      // treat like a 5xx for retry purposes
      if (attempt < 2) {
        process.stderr.write(
          `[${cfg.productName}] ${rpcName} fetch failed (${err instanceof Error ? err.message : String(err)}); retrying once after 1.5s\n`,
        );
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      process.stderr.write(
        `[${cfg.productName}] ${rpcName} fetch failed again; returning empty results\n`,
      );
      return [];
    }
    if (resp.ok) {
      return (await resp.json()) as T[];
    }
    if (RPC_RETRY_STATUSES.has(resp.status) && attempt < 2) {
      const detail = (await resp.text()).slice(0, 200);
      process.stderr.write(
        `[${cfg.productName}] ${rpcName} returned ${resp.status} (${detail}); retrying once after 1.5s\n`,
      );
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    if (RPC_RETRY_STATUSES.has(resp.status)) {
      process.stderr.write(
        `[${cfg.productName}] ${rpcName} returned ${resp.status} on retry; returning empty results\n`,
      );
      return [];
    }
    // 4xx (not in retry set) — surface as a real error
    throw new Error(
      `${rpcName}: ${resp.status} ${(await resp.text()).slice(0, 200)}`,
    );
  }
  return [];
}

export async function hybridSearchSessions(
  env: Env,
  query: string,
  opts: HybridSearchOptions = {},
): Promise<SessionChunkRow[]> {
  const embedding = await embedQuery(env, query);
  const resolved = resolveSearchMode(opts.searchMode ?? "balanced", query);
  const body = {
    query_text: query,
    query_embedding: pgVectorLiteral(embedding),
    match_count: opts.matchCount ?? 10,
    full_text_weight: opts.fullTextWeight ?? 1.0,
    semantic_weight: opts.semanticWeight ?? 1.0,
    recency_weight: opts.recencyWeight ?? recencyWeightFor(resolved),
    rrf_k: opts.rrfK ?? 60,
    owner_filter: opts.ownerFilter ?? env.defaultOwner,
  };
  return rpcWithRetry<SessionChunkRow>(env, "hybrid_search_sessions_recency", body);
}

export interface MemorySearchOptions extends HybridSearchOptions {
  sourceTypeFilter?:
    | "memory"
    | "observation"
    | "handoff"
    | "timeline"
    | "briefing"
    | "doctrine";
}

export async function hybridSearchMemory(
  env: Env,
  query: string,
  opts: MemorySearchOptions = {},
): Promise<MemoryChunkRow[]> {
  const embedding = await embedQuery(env, query);
  const resolved = resolveSearchMode(opts.searchMode ?? "balanced", query);
  const body = {
    query_text: query,
    query_embedding: pgVectorLiteral(embedding),
    match_count: opts.matchCount ?? 10,
    source_type_filter: opts.sourceTypeFilter ?? null,
    full_text_weight: opts.fullTextWeight ?? 1.0,
    semantic_weight: opts.semanticWeight ?? 1.0,
    recency_weight: opts.recencyWeight ?? recencyWeightFor(resolved),
    rrf_k: opts.rrfK ?? 60,
    owner_filter: opts.ownerFilter ?? env.defaultOwner,
  };
  return rpcWithRetry<MemoryChunkRow>(env, "hybrid_search_memory_recency", body);
}

// ─── Voyage reranker ──────────────────────────────────────────────

/** Hard ceiling on any single outbound call — a hung socket must not stall a query. */
const FETCH_TIMEOUT_MS = 30_000;
/** LLM synthesis can legitimately run long; use a separate, larger ceiling. */
const SYNTHESIS_TIMEOUT_MS = 120_000;

const VOYAGE_RERANK_URL = "https://api.voyageai.com/v1/rerank";

interface VoyageRerankResponse {
  data: Array<{ index: number; relevance_score: number }>;
  usage: { total_tokens: number };
}

/**
 * Rerank candidates against a query using voyage-rerank-2.5-lite.
 * Returns reordered indices (and scores) relative to the input array.
 */
export async function rerankCandidates(
  env: Env,
  query: string,
  candidates: string[],
  topK = 10,
): Promise<Array<{ index: number; score: number }>> {
  if (candidates.length === 0) return [];
  const body = {
    query,
    documents: candidates,
    model: env.rerankerModel,
    top_k: Math.min(topK, candidates.length),
  };
  const resp = await fetch(VOYAGE_RERANK_URL, {
    method: "POST",
    headers: makeVoyageHeaders(env),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) {
    throw new Error(
      `Voyage rerank ${resp.status}: ${(await resp.text()).slice(0, 200)}`,
    );
  }
  const data = (await resp.json()) as VoyageRerankResponse;
  return data.data.map((d) => ({ index: d.index, score: d.relevance_score }));
}

// ─── Direct table reads (no search) ───────────────────────────────

export interface SessionRow {
  session_id: string;
  source_machine: string;
  source_path: string;
  project_path: string | null;
  started_at: string | null;
  ended_at: string | null;
  message_count: number;
  byte_size: number;
  summary: string | null;
  topics: string[] | null;
  metadata: Record<string, unknown>;
}

export async function getSession(
  env: Env,
  sessionId: string,
): Promise<SessionRow | null> {
  const url = restUrl(
    env,
    `sessions?session_id=eq.${encodeURIComponent(sessionId)}&limit=1`,
  );
  const resp = await fetch(url, {
    method: "GET",
    headers: { ...makeSupabaseHeaders(env), Prefer: "" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) {
    throw new Error(
      `getSession: ${resp.status} ${(await resp.text()).slice(0, 200)}`,
    );
  }
  const rows = (await resp.json()) as SessionRow[];
  return rows[0] ?? null;
}

/**
 * Fetch ordered turns around a target chunk for replay context.
 * Returns turns from (around - window) to (around + window) inclusive.
 */
export async function replaySession(
  env: Env,
  sessionId: string,
  around: number,
  window = 5,
): Promise<SessionChunkRow[]> {
  const lo = Math.max(0, around - window);
  const hi = around + window;
  const url = restUrl(
    env,
    `session_chunks?session_id=eq.${encodeURIComponent(sessionId)}` +
      `&turn_index=gte.${lo}&turn_index=lte.${hi}` +
      `&select=chunk_id,session_id,turn_index,role,content,source_machine,occurred_at,metadata,owner` +
      `&order=turn_index.asc`,
  );
  const resp = await fetch(url, {
    method: "GET",
    headers: { ...makeSupabaseHeaders(env), Prefer: "" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) {
    throw new Error(
      `replaySession: ${resp.status} ${(await resp.text()).slice(0, 200)}`,
    );
  }
  return (await resp.json()) as SessionChunkRow[];
}

export interface ListSessionsOptions {
  since?: string;
  projectPath?: string;
  ownerFilter?: string;
  limit?: number;
  offset?: number;
}

export async function listSessions(
  env: Env,
  opts: ListSessionsOptions = {},
): Promise<SessionRow[]> {
  const filters: string[] = [
    `owner=eq.${encodeURIComponent(opts.ownerFilter ?? env.defaultOwner)}`,
  ];
  if (opts.since) {
    // Validate + encode: these filters are interpolated into the request URL,
    // and this query runs under the service-role key. An unencoded value
    // containing `&` would split into extra PostgREST params.
    if (Number.isNaN(Date.parse(opts.since))) {
      throw new Error(
        `listSessions: \`since\` must be an ISO timestamp, got ${JSON.stringify(opts.since)}`,
      );
    }
    filters.push(`started_at=gte.${encodeURIComponent(opts.since)}`);
  }
  if (opts.projectPath) {
    filters.push(`project_path=eq.${encodeURIComponent(opts.projectPath)}`);
  }
  const url = restUrl(
    env,
    `sessions?${filters.join("&")}&select=session_id,source_machine,source_path,project_path,started_at,ended_at,message_count,byte_size,summary,topics,metadata` +
      `&order=started_at.desc&limit=${opts.limit ?? 25}&offset=${opts.offset ?? 0}`,
  );
  const resp = await fetch(url, {
    method: "GET",
    headers: { ...makeSupabaseHeaders(env), Prefer: "" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) {
    throw new Error(
      `listSessions: ${resp.status} ${(await resp.text()).slice(0, 200)}`,
    );
  }
  return (await resp.json()) as SessionRow[];
}

// ─── Compact result shaping (3-layer pattern) ─────────────────────

/** Compact session-chunk summary for MCP responses (cheap on tokens). */
export interface CompactChunkResult {
  chunk_id: string;
  session_id: string;
  turn_index: number;
  role: string;
  occurred_at: string | null;
  source_machine: string;
  snippet: string; // first ~300 chars
  is_meta: boolean;
}

export function compactChunk(row: SessionChunkRow): CompactChunkResult {
  const meta = row.metadata as { is_meta_file?: boolean; is_meta_message?: boolean };
  return {
    chunk_id: row.chunk_id,
    session_id: row.session_id,
    turn_index: row.turn_index,
    role: row.role,
    occurred_at: row.occurred_at,
    source_machine: row.source_machine,
    snippet: row.content.slice(0, 300),
    is_meta: !!(meta.is_meta_file || meta.is_meta_message),
  };
}

export interface CompactMemoryResult {
  chunk_id: string;
  source_path: string;
  source_type: string;
  section_title: string | null;
  last_modified: string | null;
  snippet: string;
}

export function compactMemory(row: MemoryChunkRow): CompactMemoryResult {
  return {
    chunk_id: row.chunk_id,
    source_path: row.source_path,
    source_type: row.source_type,
    section_title: row.section_title,
    last_modified: row.last_modified,
    snippet: row.content.slice(0, 300),
  };
}

// ─── Synthesis (search → LLM-generated answer with citations) ─────

const DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions";
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

export interface SynthesizedAnswer {
  question: string;
  answer: string;
  citations: Array<{
    n: number;
    kind: "session" | "memory";
    session_id?: string;
    source_path?: string;
    turn_index?: number;
    occurred_at?: string | null;
    snippet: string;
  }>;
  cost_estimate_usd: number;
  ms: number;
  search_mode: "balanced" | "current";
}

const SYNTHESIS_SYSTEM_BALANCED = `You are answering ${cfg.ownerLabel}'s question by drawing on their Claude Code conversation history and memory artifacts. The chunks below are search results from their own past sessions — quote and paraphrase from them honestly. Cite chunks by their [N] marker when you use them. Be specific, concise, and direct. Don't pad. Don't apologize. If the chunks don't actually answer the question, say so — never confabulate.`;

const SYNTHESIS_SYSTEM_CURRENT = `You are answering ${cfg.ownerLabel}'s question about CURRENT STATE. The chunks below are sorted with recency-weighted relevance — chunks closer to today rank higher. Today's date appears at the top of the prompt; every chunk carries its own date.

Rules:
- Prefer the NEWEST chunks when summarizing current state.
- If older chunks contradict newer ones (e.g., "X is planned" in an old chunk vs "X shipped" in a newer chunk), defer to the newer with the explicit date and surface the transition.
- Never present old design-phase chatter as if it were the current state.
- Cite by [N] marker. Be specific, concise, direct. If the chunks don't answer, say so — don't confabulate.`;

function pickSynthesisSystem(mode: "balanced" | "current"): string {
  return mode === "current" ? SYNTHESIS_SYSTEM_CURRENT : SYNTHESIS_SYSTEM_BALANCED;
}

function buildSynthesisPrompt(
  question: string,
  hits: Array<{ kind: "session" | "memory"; row: SessionChunkRow | MemoryChunkRow }>,
  mode: "balanced" | "current",
): string {
  const chunks = hits.map((h, i) => {
    const r = h.row;
    if (h.kind === "session") {
      const s = r as SessionChunkRow;
      const date = s.occurred_at?.slice(0, 10) ?? "unknown-date";
      return `[${i + 1}] session=${s.session_id.slice(0, 8)} turn=${s.turn_index} role=${s.role} date=${date}\n${s.content.slice(0, 1500)}`;
    } else {
      const m = r as MemoryChunkRow;
      const mtime = m.last_modified?.slice(0, 10) ?? "unknown-mtime";
      return `[${i + 1}] memory source=${m.source_path} type=${m.source_type} mtime=${mtime}\n${m.content.slice(0, 1500)}`;
    }
  }).join("\n\n---\n\n");

  const header = mode === "current"
    ? `Today's date: ${new Date().toISOString().slice(0, 10)}\n\nQuestion (CURRENT STATE): ${question}`
    : `Question: ${question}`;

  return `${header}\n\n---\n\nRelevant chunks from past sessions:\n\n${chunks}\n\n---\n\nAnswer ${cfg.ownerLabel}'s question using these chunks. Cite chunks by [N] marker when used.`;
}

interface DeepseekChatResponse {
  choices: Array<{ message: { content: string } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  };
}

/**
 * DeepSeek HTTP statuses where falling back to Anthropic Haiku is the
 * right move (operational issues with DeepSeek itself, not bugs on our side):
 *   402  Insufficient Balance — known recurring issue, see memory.md gotchas
 *   429  Rate limit
 *   5xx  DeepSeek server errors
 * Statuses NOT in this set (400 malformed, 401 auth, 403 forbidden) surface
 * normally so we don't mask config bugs by silently re-routing.
 */
const DEEPSEEK_FALLBACK_STATUSES = new Set([402, 429, 500, 502, 503, 504]);

/** Extract the HTTP status code from a "Synthesis (deepseek) NNN: ..." error. */
function deepseekStatusFromError(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.match(/^Synthesis \(deepseek\) (\d{3}):/);
  return m ? Number.parseInt(m[1], 10) : null;
}

async function callSynthesisDeepseek(
  env: Env,
  system: string,
  prompt: string,
): Promise<{ text: string; cost: number }> {
  const resp = await fetch(DEEPSEEK_API_URL, {
    method: "POST",
    signal: AbortSignal.timeout(SYNTHESIS_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${env.deepseekApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: env.contextualDeepseekModel,
      max_tokens: 800,
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!resp.ok) {
    throw new Error(`Synthesis (deepseek) ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  const data = (await resp.json()) as DeepseekChatResponse;
  const text = data.choices[0]?.message?.content?.trim() ?? "";
  const cacheHit = data.usage?.prompt_cache_hit_tokens ?? 0;
  const cacheMiss = data.usage?.prompt_cache_miss_tokens ?? 0;
  const output = data.usage?.completion_tokens ?? 0;
  // DeepSeek V3.1/V4-flash rough pricing
  const cost =
    (cacheHit / 1_000_000) * 0.014 +
    (cacheMiss / 1_000_000) * 0.27 +
    (output / 1_000_000) * 0.28;
  return { text, cost };
}

async function callSynthesisAnthropic(
  env: Env,
  system: string,
  prompt: string,
): Promise<{ text: string; cost: number }> {
  const resp = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    signal: AbortSignal.timeout(SYNTHESIS_TIMEOUT_MS),
    headers: {
      "x-api-key": env.anthropicApiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: env.contextualHaikuModel,
      max_tokens: 800,
      system,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!resp.ok) {
    throw new Error(`Synthesis (anthropic) ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  const data = (await resp.json()) as {
    content: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const text = data.content.find((c) => c.type === "text")?.text?.trim() ?? "";
  const input = data.usage?.input_tokens ?? 0;
  const output = data.usage?.output_tokens ?? 0;
  const cost = (input / 1_000_000) * 0.25 + (output / 1_000_000) * 1.25;
  return { text, cost };
}

async function callSynthesisLLM(
  env: Env,
  question: string,
  hits: Array<{ kind: "session" | "memory"; row: SessionChunkRow | MemoryChunkRow }>,
  mode: "balanced" | "current",
): Promise<{ text: string; cost: number }> {
  const prompt = buildSynthesisPrompt(question, hits, mode);
  const system = pickSynthesisSystem(mode);

  // When DeepSeek is the configured provider, attempt it first and fall back
  // to Anthropic Haiku on operational failures (402 balance, 429 rate, 5xx).
  // Hard-fails on bugs we'd want to see (4xx auth/malformed) by NOT catching.
  if (env.contextualProvider === "deepseek") {
    try {
      return await callSynthesisDeepseek(env, system, prompt);
    } catch (err) {
      const status = deepseekStatusFromError(err);
      if (status !== null && DEEPSEEK_FALLBACK_STATUSES.has(status)) {
        process.stderr.write(
          `[${cfg.productName}] DeepSeek synthesis ${status}; falling back to Anthropic Haiku\n`,
        );
        return await callSynthesisAnthropic(env, system, prompt);
      }
      throw err;
    }
  }

  return await callSynthesisAnthropic(env, system, prompt);
}

export interface SynthesizeOptions {
  matchCount?: number;
  rerank?: boolean;
  sources?: "sessions" | "memory" | "all";
  hideMeta?: boolean;
  ownerFilter?: string;
  searchMode?: SearchMode;
}

export interface SynthesizedAnswerMeta {
  /** The resolved mode actually used (after auto-detect, if applicable). */
  search_mode: "balanced" | "current";
}

/**
 * The killer feature: search → LLM synthesizes a direct answer with citations.
 *
 * Pipeline:
 *   1. Run hybrid search across the requested sources (parallel where applicable)
 *   2. Optional rerank via voyage-rerank-2.5-lite
 *   3. Feed top hits + question to DeepSeek/Haiku
 *   4. Return synthesized answer + citation list
 *
 * Cost per answer: ~$0.001-0.005 depending on context size.
 * Same chunks data feeding both search_* tools and answer — no new data path.
 */
export async function synthesizeAnswer(
  env: Env,
  question: string,
  opts: SynthesizeOptions = {},
): Promise<SynthesizedAnswer> {
  const t0 = Date.now();
  const matchCount = opts.matchCount ?? 10;
  const rerank = opts.rerank !== false;
  const sources = opts.sources ?? "all";
  const hideMeta = opts.hideMeta !== false;
  const searchMode = opts.searchMode ?? "auto";
  const resolvedMode = resolveSearchMode(searchMode, question);

  // Fetch candidates from requested surfaces
  const fetchLimit = rerank ? Math.min(matchCount * 2, 30) : matchCount;
  const tasks: Promise<Array<{ kind: "session" | "memory"; row: SessionChunkRow | MemoryChunkRow }>>[] = [];

  if (sources === "sessions" || sources === "all") {
    tasks.push(
      hybridSearchSessions(env, question, {
        matchCount: fetchLimit,
        ownerFilter: opts.ownerFilter,
        searchMode: resolvedMode,
      })
        .then((rows) => {
          const filtered = hideMeta
            ? rows.filter((r) => {
                const m = r.metadata as { is_meta_file?: boolean; is_meta_message?: boolean };
                return !(m.is_meta_file || m.is_meta_message);
              })
            : rows;
          return filtered.map((row) => ({ kind: "session" as const, row }));
        }),
    );
  }
  if (sources === "memory" || sources === "all") {
    tasks.push(
      hybridSearchMemory(env, question, {
        matchCount: fetchLimit,
        ownerFilter: opts.ownerFilter,
        searchMode: resolvedMode,
      })
        .then((rows) => rows.map((row) => ({ kind: "memory" as const, row }))),
    );
  }

  const buckets = await Promise.all(tasks);
  // Round-robin interleave (rank-preserving within each bucket) so a full
  // sessions page can't starve memory hits when rerank is skipped
  // (current mode or rerank=false) and slice(0, matchCount) truncates.
  let combined: (typeof buckets)[number][number][] = [];
  const maxLen = Math.max(0, ...buckets.map((b) => b.length));
  for (let i = 0; i < maxLen; i++) {
    for (const b of buckets) {
      if (i < b.length) combined.push(b[i]);
    }
  }

  // Rerank if requested + there are enough candidates to reorder.
  // NOTE: For current-mode queries we intentionally skip rerank — the reranker
  // is recency-blind and re-imposes pure semantic similarity, which would
  // undo the recency bias we just paid for at the RPC layer. Recency-weighted
  // RPC ordering is the final ranking in current mode.
  if (rerank && combined.length > 1 && resolvedMode !== "current") {
    const ranked = await rerankCandidates(
      env,
      question,
      combined.map((c) => c.row.content),
      matchCount,
    );
    combined = ranked.map((r) => combined[r.index]);
  }

  const top = combined.slice(0, matchCount);
  if (top.length === 0) {
    return {
      question,
      answer: "No relevant chunks found in your corpus for this question.",
      citations: [],
      cost_estimate_usd: 0,
      ms: Date.now() - t0,
      search_mode: resolvedMode,
    };
  }

  const { text, cost } = await callSynthesisLLM(env, question, top, resolvedMode);

  const citations = top.map((h, i) => {
    if (h.kind === "session") {
      const s = h.row as SessionChunkRow;
      return {
        n: i + 1,
        kind: "session" as const,
        session_id: s.session_id,
        turn_index: s.turn_index,
        occurred_at: s.occurred_at,
        snippet: s.content.slice(0, 200),
      };
    } else {
      const m = h.row as MemoryChunkRow;
      return {
        n: i + 1,
        kind: "memory" as const,
        source_path: m.source_path,
        snippet: m.content.slice(0, 200),
      };
    }
  });

  return {
    question,
    answer: text,
    citations,
    cost_estimate_usd: cost,
    ms: Date.now() - t0,
    search_mode: resolvedMode,
  };
}
