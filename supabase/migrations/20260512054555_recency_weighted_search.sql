-- ===================================================================
-- Recency-weighted hybrid search
--
-- Why this exists:
--   The default RRF blend (semantic + lexical) is well-tuned for
--   historical retrieval but actively misleads on current-state
--   queries. Design-phase chatter outweighs resolutions because the
--   semantic similarity to "where are we on X" matches every prior
--   discussion of X equally. This migration adds a third
--   rank dimension — recency — so the synthesis layer can prefer
--   newest chunks when the query is about now.
--
-- Design choice: the recency rank is computed ONLY over the union
-- of full_text+semantic candidates, not the whole table. Otherwise
-- a "what's happening" query would pull in completely unrelated
-- newer chunks. Recency boosts within the relevance-matched set;
-- it does not replace relevance.
--
-- Backward compat: recency_weight defaults to 0.0, so when callers
-- don't request recency the new RPC produces identical results to
-- the original hybrid_search_*. The original RPCs are NOT dropped —
-- old client code keeps working. rrf_k default also bumped to 60 to
-- match what the client always passes.
-- ===================================================================

-- ─── 1. session_chunks recency-weighted RPC ───────────────────────
CREATE OR REPLACE FUNCTION hybrid_search_sessions_recency(
  query_text text,
  query_embedding halfvec(1024),
  match_count int DEFAULT 10,
  full_text_weight float DEFAULT 1.0,
  semantic_weight float DEFAULT 1.0,
  recency_weight float DEFAULT 0.0,
  rrf_k int DEFAULT 60,
  owner_filter text DEFAULT 'owner'
) RETURNS SETOF session_chunks
LANGUAGE sql STABLE AS $$
  WITH
  full_text AS (
    SELECT chunk_id, row_number() OVER (
      ORDER BY ts_rank_cd(fts, websearch_to_tsquery('english', query_text)) DESC
    ) AS rank_ix
    FROM session_chunks
    WHERE fts @@ websearch_to_tsquery('english', query_text)
      AND owner = owner_filter
    ORDER BY rank_ix
    LIMIT LEAST(match_count, 30) * 2
  ),
  semantic AS (
    SELECT chunk_id, row_number() OVER (
      ORDER BY embedding <=> query_embedding
    ) AS rank_ix
    FROM session_chunks
    WHERE owner = owner_filter
      AND embedding IS NOT NULL
    ORDER BY rank_ix
    LIMIT LEAST(match_count, 30) * 2
  ),
  candidates AS (
    SELECT chunk_id FROM full_text
    UNION
    SELECT chunk_id FROM semantic
  ),
  recency AS (
    SELECT c.chunk_id, row_number() OVER (
      ORDER BY COALESCE(sc.occurred_at, sc.created_at) DESC NULLS LAST
    ) AS rank_ix
    FROM candidates c
    JOIN session_chunks sc ON sc.chunk_id = c.chunk_id
  )
  SELECT session_chunks.*
  FROM candidates c
  LEFT JOIN full_text ft ON ft.chunk_id = c.chunk_id
  LEFT JOIN semantic  sm ON sm.chunk_id = c.chunk_id
  LEFT JOIN recency   rc ON rc.chunk_id = c.chunk_id
  JOIN session_chunks ON session_chunks.chunk_id = c.chunk_id
  ORDER BY
    COALESCE(1.0 / (rrf_k + ft.rank_ix), 0.0) * full_text_weight
    + COALESCE(1.0 / (rrf_k + sm.rank_ix), 0.0) * semantic_weight
    + COALESCE(1.0 / (rrf_k + rc.rank_ix), 0.0) * recency_weight
    DESC
  LIMIT LEAST(match_count, 30);
$$;

-- ─── 2. memory_chunks recency-weighted RPC ────────────────────────
CREATE OR REPLACE FUNCTION hybrid_search_memory_recency(
  query_text text,
  query_embedding halfvec(1024),
  match_count int DEFAULT 10,
  source_type_filter text DEFAULT NULL,
  full_text_weight float DEFAULT 1.0,
  semantic_weight float DEFAULT 1.0,
  recency_weight float DEFAULT 0.0,
  rrf_k int DEFAULT 60,
  owner_filter text DEFAULT 'owner'
) RETURNS SETOF memory_chunks
LANGUAGE sql STABLE AS $$
  WITH
  full_text AS (
    SELECT chunk_id, row_number() OVER (
      ORDER BY ts_rank_cd(fts, websearch_to_tsquery('english', query_text)) DESC
    ) AS rank_ix
    FROM memory_chunks
    WHERE fts @@ websearch_to_tsquery('english', query_text)
      AND owner = owner_filter
      AND (source_type_filter IS NULL OR source_type = source_type_filter)
    ORDER BY rank_ix
    LIMIT LEAST(match_count, 30) * 2
  ),
  semantic AS (
    SELECT chunk_id, row_number() OVER (
      ORDER BY embedding <=> query_embedding
    ) AS rank_ix
    FROM memory_chunks
    WHERE owner = owner_filter
      AND (source_type_filter IS NULL OR source_type = source_type_filter)
      AND embedding IS NOT NULL
    ORDER BY rank_ix
    LIMIT LEAST(match_count, 30) * 2
  ),
  candidates AS (
    SELECT chunk_id FROM full_text
    UNION
    SELECT chunk_id FROM semantic
  ),
  recency AS (
    SELECT c.chunk_id, row_number() OVER (
      ORDER BY COALESCE(mc.last_modified, mc.created_at) DESC NULLS LAST
    ) AS rank_ix
    FROM candidates c
    JOIN memory_chunks mc ON mc.chunk_id = c.chunk_id
  )
  SELECT memory_chunks.*
  FROM candidates c
  LEFT JOIN full_text ft ON ft.chunk_id = c.chunk_id
  LEFT JOIN semantic  sm ON sm.chunk_id = c.chunk_id
  LEFT JOIN recency   rc ON rc.chunk_id = c.chunk_id
  JOIN memory_chunks ON memory_chunks.chunk_id = c.chunk_id
  ORDER BY
    COALESCE(1.0 / (rrf_k + ft.rank_ix), 0.0) * full_text_weight
    + COALESCE(1.0 / (rrf_k + sm.rank_ix), 0.0) * semantic_weight
    + COALESCE(1.0 / (rrf_k + rc.rank_ix), 0.0) * recency_weight
    DESC
  LIMIT LEAST(match_count, 30);
$$;
