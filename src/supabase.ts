// src/supabase.ts — PostgREST helpers for the corpus schema.
//
// Direct fetch() to the PostgREST endpoint, service-role auth.
// All inserts honor schema-level UNIQUE constraints (idempotent re-ingest).
//
// Patterns (battle-tested in prior projects):
//   - statement-timeout (SQLSTATE 57014) → recursive batch split
//   - 50-batch ceiling on .in() filter (Postgres URL length limit)
//   - Prefer: return=minimal,resolution=ignore-duplicates for idempotency

import type { Env } from "./env.js";
import { makeSupabaseHeaders, makeSupabaseHeadersWithReturn } from "./env.js";

/** Hard ceiling on any single outbound call — a hung socket must not stall ingest. */
const FETCH_TIMEOUT_MS = 30_000;

interface InsertResult {
  inserted: number;
  failed: number;
}

function restUrl(env: Env, path: string): string {
  return `${env.supabaseUrl.replace(/\/$/, "")}/rest/v1/${path}`;
}

/**
 * Insert a batch of rows into a Supabase table.
 * Recursively splits the batch on statement-timeout (57014).
 * UNIQUE constraint conflicts are silently ignored (idempotent ingest).
 */
export async function insertBatch(
  env: Env,
  table: string,
  rows: Record<string, unknown>[],
): Promise<InsertResult> {
  if (rows.length === 0) return { inserted: 0, failed: 0 };

  const resp = await fetch(restUrl(env, table), {
    method: "POST",
    headers: makeSupabaseHeaders(env),
    body: JSON.stringify(rows),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!resp.ok) {
    const text = await resp.text();
    // Split-and-retry on statement timeout (57014) OR UNIQUE collision (23505).
    // 23505 fires when a batch contains a (session_id, content_hash) that
    // already exists in the DB — Prefer: resolution=ignore-duplicates fails the
    // WHOLE batch rather than skipping the offending row. Splitting isolates it
    // so the rest of the batch still lands. (In-process sessionSeenHashes
    // dedups intra-session dups; this handles the already-in-DB case.)
    if (
      (text.includes('"code":"57014"') || text.includes('"code":"23505"')) &&
      rows.length > 1
    ) {
      const mid = Math.floor(rows.length / 2);
      const left = await insertBatch(env, table, rows.slice(0, mid));
      const right = await insertBatch(env, table, rows.slice(mid));
      return {
        inserted: left.inserted + right.inserted,
        failed: left.failed + right.failed,
      };
    }
    // A single row that 23505s is already present — not new, not a failure.
    if (text.includes('"code":"23505"')) {
      return { inserted: 0, failed: 0 };
    }
    console.error(
      `insertBatch[${table}] (${rows.length} rows): ${resp.status} ${text.slice(0, 200)}`,
    );
    return { inserted: 0, failed: rows.length };
  }
  return { inserted: rows.length, failed: 0 };
}

/**
 * Upsert a session row.
 * Returns the session_id (which the caller already provided — confirmation only).
 */
export async function upsertSession(
  env: Env,
  row: Record<string, unknown>,
): Promise<{ session_id: string } | null> {
  const resp = await fetch(restUrl(env, "sessions?on_conflict=session_id"), {
    method: "POST",
    headers: makeSupabaseHeadersWithReturn(env),
    body: JSON.stringify(row),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text();
    console.error(`upsertSession: ${resp.status} ${text.slice(0, 200)}`);
    return null;
  }
  const rows = (await resp.json()) as Array<{ session_id: string }>;
  return rows[0] ?? null;
}

/** Begin a new ingest_runs row — returns the assigned ingest_batch UUID. */
export async function beginIngestRun(
  env: Env,
  sourceLabel: string,
): Promise<string> {
  const resp = await fetch(restUrl(env, "ingest_runs"), {
    method: "POST",
    headers: makeSupabaseHeadersWithReturn(env),
    body: JSON.stringify({ source_label: sourceLabel, status: "running" }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) {
    throw new Error(`beginIngestRun: ${resp.status} ${await resp.text()}`);
  }
  const rows = (await resp.json()) as Array<{ ingest_batch: string }>;
  if (!rows[0]?.ingest_batch) {
    throw new Error("beginIngestRun: no ingest_batch in response");
  }
  return rows[0].ingest_batch;
}

/** Update an in-progress ingest_runs row with stats. Failure is non-fatal. */
export async function updateIngestRun(
  env: Env,
  ingestBatch: string,
  stats: Partial<{
    files_total: number;
    files_done: number;
    files_failed: number;
    chunks_inserted: number;
    chunks_quarantined: number;
    error_summary: string;
  }>,
): Promise<void> {
  const resp = await fetch(
    restUrl(env, `ingest_runs?ingest_batch=eq.${ingestBatch}`),
    {
      method: "PATCH",
      headers: makeSupabaseHeaders(env),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      body: JSON.stringify(stats),
    },
  );
  if (!resp.ok) {
    console.warn(
      `updateIngestRun (non-fatal): ${resp.status} ${await resp.text()}`,
    );
  }
}

/** Mark an ingest_runs row complete (or failed). Failure is non-fatal. */
export async function finishIngestRun(
  env: Env,
  ingestBatch: string,
  status: "completed" | "failed" | "partial",
  errorSummary?: string,
): Promise<void> {
  const body: Record<string, unknown> = {
    status,
    ended_at: new Date().toISOString(),
  };
  if (errorSummary) body.error_summary = errorSummary;

  const resp = await fetch(
    restUrl(env, `ingest_runs?ingest_batch=eq.${ingestBatch}`),
    {
      method: "PATCH",
      headers: makeSupabaseHeaders(env),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      body: JSON.stringify(body),
    },
  );
  if (!resp.ok) {
    console.warn(
      `finishIngestRun (non-fatal): ${resp.status} ${await resp.text()}`,
    );
  }
}

/**
 * Look up which content_hashes already exist in a chunk table.
 * Honors the 50-batch ceiling on `.in()` filter (Postgres URL length limit).
 *
 * When `scopeColumn` is given ("session_id" for session_chunks, "source_path"
 * for memory_chunks), the returned set contains `␣`-joined `scope hash` keys
 * instead of bare hashes — dedup then matches the table's UNIQUE constraint
 * (session_id, content_hash) / (source_path, content_hash) instead of being
 * global, so identical text in a DIFFERENT session/file is no longer dropped.
 */
export async function getExistingHashes(
  env: Env,
  table: "session_chunks" | "memory_chunks",
  hashes: string[],
  scopeColumn?: "session_id" | "source_path",
): Promise<Set<string>> {
  if (hashes.length === 0) return new Set();
  const existing = new Set<string>();
  const select = scopeColumn ? `content_hash,${scopeColumn}` : "content_hash";
  for (let i = 0; i < hashes.length; i += 50) {
    const batch = hashes.slice(i, i + 50);
    const quoted = batch.map((h) => `"${h}"`).join(",");
    const url = restUrl(
      env,
      `${table}?select=${select}&content_hash=in.(${quoted})`,
    );
    const headers = { ...makeSupabaseHeaders(env), Prefer: "" };
    const resp = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (resp.ok) {
      const rows = (await resp.json()) as Array<Record<string, string>>;
      for (const r of rows) {
        existing.add(scopeColumn ? `${r[scopeColumn]} ${r.content_hash}` : r.content_hash);
      }
    }
  }
  return existing;
}

/** Quick liveness probe — confirms creds + URL work. */
export async function pingSupabase(env: Env): Promise<boolean> {
  const resp = await fetch(restUrl(env, "ingest_runs?select=ingest_batch&limit=1"), {
    method: "GET",
    headers: { ...makeSupabaseHeaders(env), Prefer: "" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return resp.ok;
}
