-- ===================================================================
-- session_chunks.has_cr_prefix — track Contextual Retrieval status per chunk
--
-- Why this exists:
--   When the CR provider errors (402 Insufficient Balance, 429, 5xx),
--   the ingest pipeline catches per-chunk in src/contextual.ts:catch and
--   falls through to embed-WITHOUT-prefix, so chunks still land. Until
--   this migration, nothing distinguished those degraded chunks from
--   fully-CR'd ones — a provider outage could degrade retrieval quality
--   invisibly for weeks. This column makes the degradation durable and
--   SQL-queryable, so a backfill can find exactly the chunks that need
--   a CR re-attempt.
--
-- Tristate semantic:
--   true   — CR call succeeded; chunk embedded with `prefix \n\n content`
--   false  — CR call failed (402/429/5xx/timeout/etc); chunk embedded
--            with raw content, no prefix; retrieval quality degraded
--   NULL   — legacy chunk (ingested before this migration); CR status
--            unknown; treat as "needs verification, may or may not have
--            prefix"
--
-- Index strategy: sparse index on `IS DISTINCT FROM TRUE` covers exactly
-- the rows that backfill needs to find. Rows where has_cr_prefix = true
-- are the happy case and don't need an index entry.
-- ===================================================================

ALTER TABLE session_chunks
  ADD COLUMN has_cr_prefix BOOLEAN;

COMMENT ON COLUMN session_chunks.has_cr_prefix IS
  'Tri-state: true = CR succeeded, false = CR failed (chunk embedded without prefix, degraded retrieval), NULL = legacy/unknown (pre-2026-05-28 ingest).';

-- Sparse index: only covers rows needing backfill (false or NULL)
CREATE INDEX session_chunks_needs_backfill_idx ON session_chunks (has_cr_prefix)
  WHERE has_cr_prefix IS DISTINCT FROM TRUE;
