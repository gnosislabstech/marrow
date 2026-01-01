// scripts/distill-summaries.ts — backfill sessions.summary + summary_embedding
// (the coarse-to-fine search fix's distillation step).
//
//   ./run.sh scripts/distill-summaries.ts --dry-run [--sample=N]
//   ./run.sh scripts/distill-summaries.ts --apply --limit=3     (SMOKE: 3 sessions, inspect)
//   ./run.sh scripts/distill-summaries.ts --apply               (FULL backfill — see --dry-run for cost)
//
// --dry-run (SAFE): estimate the full-backfill DeepSeek+Voyage cost from a sample.
// --apply: for each session lacking a summary_embedding, sample its chunks, distill
//   a retrieval summary (DeepSeek, Haiku fallback), embed it (Voyage), and PATCH
//   sessions.summary + summary_embedding. Idempotent: the `summary_embedding is null`
//   filter means a re-run resumes; a per-session failure leaves it null for next time.
//   NOT scrubbed (consistent with the unscrubbed corpus; the identityScrub re-embed
//   is a separate decision).

import { loadEnv, type Env } from "../src/env.js";
import { makeSupabaseHeaders } from "../src/env.js";
import { embedBatch, embeddingToPostgresArray } from "../src/embedding.js";
import { selectDistillationSample, type DistillChunk } from "../src/analytics/distill-sample.js";

const APPROX_CHARS_PER_TOKEN = 3.5;
const DEEPSEEK_IN_PER_M = 0.27, DEEPSEEK_OUT_PER_M = 0.28, VOYAGE_PER_M = 0.12;
const PROMPT_OVERHEAD_TOKENS = 120, EST_SUMMARY_TOKENS = 220;
const MAX_DOC_CHARS = 24000;       // cap the distill input per session
const CONCURRENCY = 6;
const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const FALLBACK_STATUSES = new Set([402, 429, 500, 502, 503, 504]);

function rest(env: Env, path: string): string {
  return `${env.supabaseUrl.replace(/\/$/, "")}/rest/v1/${path}`;
}
async function count(env: Env, filter: string): Promise<number> {
  const r = await fetch(rest(env, `sessions?select=session_id&limit=1&${filter}`), {
    headers: { ...makeSupabaseHeaders(env), Prefer: "count=exact", "Range-Unit": "items", Range: "0-0" },
    signal: AbortSignal.timeout(60_000),
  });
  return Number(((r.headers.get("content-range") ?? "/0").split("/")[1]) || 0);
}
async function fetchChunks(env: Env, sessionId: string): Promise<DistillChunk[]> {
  const r = await fetch(
    rest(env, `session_chunks?session_id=eq.${encodeURIComponent(sessionId)}&select=turn_index,content&order=turn_index.asc&limit=2000`),
    { headers: { ...makeSupabaseHeaders(env), Prefer: "" }, signal: AbortSignal.timeout(60_000) },
  );
  return r.ok ? ((await r.json()) as DistillChunk[]) : [];
}

const DISTILL_INSTRUCTION =
  "Summarize this Claude Code session in 2-4 sentences for semantic retrieval. " +
  "Capture the concrete topic, the project/system involved, the key decisions or outcomes, " +
  "and any notable problem solved or bug fixed. Be specific and factual. No preamble, no markdown.";

function buildDistillPrompt(sample: DistillChunk[]): string {
  const doc = sample.map((c) => `[turn ${c.turn_index}] ${c.content}`).join("\n\n").slice(0, MAX_DOC_CHARS);
  return `${DISTILL_INSTRUCTION}\n\n<session>\n${doc}\n</session>\n\nSummary:`;
}

/** DeepSeek chat with Anthropic-Haiku fallback on operational failures. */
async function distillLLM(env: Env, prompt: string): Promise<string> {
  try {
    const r = await fetch(DEEPSEEK_URL, {
      method: "POST",
      signal: AbortSignal.timeout(60_000),
      headers: { Authorization: `Bearer ${env.deepseekApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: env.contextualDeepseekModel, max_tokens: 320, temperature: 0.2,
        messages: [{ role: "user", content: prompt }] }),
    });
    if (!r.ok) throw new Error(`deepseek ${r.status}: ${(await r.text()).slice(0, 120)}`);
    const d = (await r.json()) as { choices: Array<{ message: { content: string } }> };
    return d.choices[0]?.message?.content?.trim() ?? "";
  } catch (err) {
    const m = String(err instanceof Error ? err.message : err).match(/deepseek (\d{3})/);
    const status = m ? Number(m[1]) : 0;
    if (!FALLBACK_STATUSES.has(status)) throw err;
    process.stderr.write(`[distill] DeepSeek ${status}; falling back to Haiku\n`);
    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      signal: AbortSignal.timeout(60_000),
      headers: { "x-api-key": env.anthropicApiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({ model: env.contextualHaikuModel, max_tokens: 320,
        messages: [{ role: "user", content: prompt }] }),
    });
    if (!r.ok) throw new Error(`anthropic ${r.status}: ${(await r.text()).slice(0, 120)}`);
    const d = (await r.json()) as { content: Array<{ type: string; text?: string }> };
    return d.content.find((c) => c.type === "text")?.text?.trim() ?? "";
  }
}

interface SessionRow { session_id: string }

/** Distill + embed + write ONE session. Returns the summary (for smoke inspection) or null. */
async function distillOne(env: Env, sessionId: string, write: boolean): Promise<string | null> {
  const chunks = await fetchChunks(env, sessionId);
  if (chunks.length === 0) return null;
  const sample = selectDistillationSample(chunks);
  const summary = await distillLLM(env, buildDistillPrompt(sample));
  if (!summary) return null;
  const { embeddings } = await embedBatch(env, [summary], "document");
  if (!embeddings[0]) return null;
  if (write) {
    const r = await fetch(rest(env, `sessions?session_id=eq.${encodeURIComponent(sessionId)}`), {
      method: "PATCH",
      signal: AbortSignal.timeout(60_000),
      headers: { ...makeSupabaseHeaders(env), Prefer: "return=minimal" },
      body: JSON.stringify({ summary, summary_embedding: embeddingToPostgresArray(embeddings[0]) }),
    });
    if (!r.ok) throw new Error(`PATCH ${sessionId}: ${r.status} ${(await r.text()).slice(0, 120)}`);
  }
  return summary;
}

async function applyBackfill(env: Env, limit: number | null, smoke: boolean): Promise<void> {
  const total = await count(env, "summary_embedding=is.null");
  if (total === 0) { console.log("nothing to backfill."); return; }
  console.log(`${total.toLocaleString()} sessions need a summary; ${smoke ? "SMOKE — writing+inspecting" : "full backfill"}${limit ? ` (limit ${limit})` : ""}`);

  // Paginate: PostgREST caps any single fetch at ~1000 rows. Re-query the
  // `summary_embedding is null` set each page — processed sessions flip non-null
  // and drop out. A `seen` set guards the tail: empty (no-chunk) sessions never
  // flip null, so without it the loop would spin on them forever.
  const PAGE = 1000;
  const seen = new Set<string>();
  let done = 0, failed = 0, empty = 0, attempted = 0;

  while (true) {
    if (limit && attempted >= limit) break;
    const pageSize = limit ? Math.min(PAGE, limit - attempted) : PAGE;
    const r = await fetch(
      rest(env, `sessions?select=session_id&summary_embedding=is.null&order=started_at.desc&limit=${pageSize}`),
      { headers: { ...makeSupabaseHeaders(env), Prefer: "" } },
    );
    const page = ((await r.json()) as SessionRow[]).filter((s) => !seen.has(s.session_id));
    if (page.length === 0) break; // exhausted (only already-seen empties remain)
    for (const s of page) seen.add(s.session_id);
    attempted += page.length;

    for (let i = 0; i < page.length; i += CONCURRENCY) {
      const batch = page.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(batch.map((s) => distillOne(env, s.session_id, true)));
      results.forEach((res, j) => {
        if (res.status === "rejected") { failed++; console.error(`  FAIL ${batch[j].session_id}: ${res.reason}`); }
        else if (res.value === null) { empty++; }
        else { done++; if (smoke) console.log(`\n  [${batch[j].session_id.slice(0, 8)}] ${res.value}`); }
      });
    }
    console.log(`  progress: ${done} done, ${empty} empty, ${failed} failed (${attempted} attempted)`);
  }
  console.log(`\nDONE: ${done} summarized+embedded, ${failed} failed, ${empty} empty (skipped).`);
}

async function dryRun(env: Env, sampleSize: number): Promise<void> {
  const total = await count(env, "summary_embedding=is.null");
  console.log(`sessions needing a summary_embedding: ${total.toLocaleString()}`);
  if (total === 0) { console.log("nothing to backfill."); return; }
  const n = Math.min(sampleSize, total);
  const r = await fetch(rest(env, `sessions?select=session_id&summary_embedding=is.null&order=started_at.desc&limit=${n}`),
    { headers: { ...makeSupabaseHeaders(env), Prefer: "" }, signal: AbortSignal.timeout(60_000) });
  const sample = (await r.json()) as SessionRow[];
  let sumIn = 0, measured = 0;
  for (const s of sample) {
    const chunks = await fetchChunks(env, s.session_id);
    if (!chunks.length) continue;
    const chars = selectDistillationSample(chunks).reduce((a, c) => a + (c.content?.length ?? 0), 0);
    sumIn += Math.ceil(chars / APPROX_CHARS_PER_TOKEN) + PROMPT_OVERHEAD_TOKENS;
    measured++;
  }
  if (!measured) { console.log("no measurable sessions."); return; }
  const avg = sumIn / measured, projIn = avg * total, projOut = EST_SUMMARY_TOKENS * total;
  const cost = (projIn / 1e6) * DEEPSEEK_IN_PER_M + (projOut / 1e6) * DEEPSEEK_OUT_PER_M + (projOut / 1e6) * VOYAGE_PER_M;
  console.log(`\nDRY RUN — avg ${Math.round(avg)} input tok/session over ${measured} sampled; ESTIMATED TOTAL ~$${cost.toFixed(2)} for ${total.toLocaleString()} sessions (±50%).`);
}

async function main(): Promise<void> {
  const env = loadEnv();
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const limitArg = args.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number.parseInt(limitArg.slice("--limit=".length), 10) : null;
  const sampleArg = args.find((a) => a.startsWith("--sample="));
  const sample = sampleArg ? Number.parseInt(sampleArg.slice("--sample=".length), 10) : 150;

  if (apply) {
    const smoke = limit !== null && limit <= 10;
    await applyBackfill(env, limit, smoke);
  } else {
    await dryRun(env, Number.isFinite(sample) ? sample : 150);
  }
}

main().catch((e) => { console.error(`FATAL: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; });
