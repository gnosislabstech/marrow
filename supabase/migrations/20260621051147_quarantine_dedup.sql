-- Quarantine dedup: collapse re-quarantine duplicates + prevent recurrence.
--
-- Root cause: the quarantine insert already uses
-- `Prefer: resolution=ignore-duplicates` (env.ts → insertBatch), but the table had NO
-- unique constraint, so any periodic re-ingest re-quarantined the same benign
-- over-fires on every run — in one observed deployment the table grew to ~14x its
-- distinct (source_path, content) count. No code change needed: the
-- ignore-duplicates header makes re-quarantines no-ops once a unique index exists.
-- Self-contained: on a fresh DB the DELETE below is a no-op and the index creates clean.

-- 1) one-time dedup: keep the earliest row per (source_path, md5(content)).
--    LOCK first — without it, a concurrent ingest can commit a new dup between the DELETE
--    and the index build (under READ COMMITTED, CREATE INDEX gets a newer snapshot than the
--    DELETE), which fails the index. SHARE ROW EXCLUSIVE blocks writers but allows reads.
LOCK TABLE quarantine IN SHARE ROW EXCLUSIVE MODE;
DELETE FROM quarantine q
USING (
  SELECT quarantine_id,
         row_number() OVER (PARTITION BY source_path, md5(content)
                            ORDER BY created_at, quarantine_id) AS rn
  FROM quarantine
) d
WHERE q.quarantine_id = d.quarantine_id AND d.rn > 1;

-- 2) prevent recurrence. md5(content) keeps the btree key small regardless of content length;
--    PostgREST's ignore-duplicates emits ON CONFLICT DO NOTHING (no target), which honors
--    any unique index — including this expression index.
CREATE UNIQUE INDEX IF NOT EXISTS quarantine_dedup_uk ON quarantine (source_path, md5(content));
