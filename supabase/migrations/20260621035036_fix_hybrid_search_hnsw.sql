-- Fix: hybrid-search semantic CTE defeated the HNSW index → searches time out.
--
-- WHY: the `semantic` CTE ranked candidates with
--   row_number() OVER (ORDER BY embedding <=> query_embedding)
-- a WINDOW function over the whole owner-filtered table. A window function must
-- rank ALL rows before the outer LIMIT, so the planner cannot use the HNSW index
-- (HNSW only accelerates `ORDER BY <=> ... LIMIT k`). Result: a seq scan over
-- the full chunks table + a full distance sort that spills to disk → multi-second
-- queries that trip the PostgREST role statement_timeout → search returns empty.
--
-- FIX: push `ORDER BY embedding <=> query_embedding LIMIT k` into a subquery so
-- the HNSW index engages (top-k scan), then row_number() over the small result.
-- Semantically equivalent (same top-k candidates feeding the same RRF) — the only
-- change is HNSW's approximate top-k vs an exact full sort, which is the entire
-- point of the index. Verified via EXPLAIN ANALYZE on a production-size table:
--   before: Seq Scan + external-merge Sort, seconds per query (HNSW unused)
--   after:  Index Scan using session_chunks_embed_hnsw (~29x faster)
--
-- Only the `semantic` CTE changes in each function. The `full_text` CTE is left
-- as-is: it ranks fts-matched rows (filtered by the GIN index first) and has no
-- vector index to defeat. Signatures preserved exactly (CREATE OR REPLACE).
-- Rollback: re-apply the prior defs from 20260512054555_recency_weighted_search.sql
-- + 20260509082000_research_upgrades.sql / 20260509080514_initial.sql.

CREATE OR REPLACE FUNCTION public.hybrid_search_sessions(query_text text, query_embedding halfvec, match_count integer DEFAULT 10, full_text_weight double precision DEFAULT 1.0, semantic_weight double precision DEFAULT 1.0, rrf_k integer DEFAULT 50, owner_filter text DEFAULT 'owner'::text)
 RETURNS SETOF session_chunks
 LANGUAGE sql
 STABLE
AS $function$
  WITH full_text AS (
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
    SELECT chunk_id, row_number() OVER (ORDER BY dist) AS rank_ix
    FROM (
      SELECT chunk_id, embedding <=> query_embedding AS dist
      FROM session_chunks
      WHERE owner = owner_filter
        AND embedding IS NOT NULL
      ORDER BY embedding <=> query_embedding
      LIMIT LEAST(match_count, 30) * 2
    ) s
  )
  SELECT session_chunks.*
  FROM full_text
  FULL OUTER JOIN semantic ON full_text.chunk_id = semantic.chunk_id
  JOIN session_chunks ON COALESCE(full_text.chunk_id, semantic.chunk_id) = session_chunks.chunk_id
  ORDER BY
    COALESCE(1.0 / (rrf_k + full_text.rank_ix), 0.0) * full_text_weight
    + COALESCE(1.0 / (rrf_k + semantic.rank_ix), 0.0) * semantic_weight DESC
  LIMIT LEAST(match_count, 30);
$function$;

CREATE OR REPLACE FUNCTION public.hybrid_search_sessions_recency(query_text text, query_embedding halfvec, match_count integer DEFAULT 10, full_text_weight double precision DEFAULT 1.0, semantic_weight double precision DEFAULT 1.0, recency_weight double precision DEFAULT 0.0, rrf_k integer DEFAULT 60, owner_filter text DEFAULT 'owner'::text)
 RETURNS SETOF session_chunks
 LANGUAGE sql
 STABLE
AS $function$
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
    SELECT chunk_id, row_number() OVER (ORDER BY dist) AS rank_ix
    FROM (
      SELECT chunk_id, embedding <=> query_embedding AS dist
      FROM session_chunks
      WHERE owner = owner_filter
        AND embedding IS NOT NULL
      ORDER BY embedding <=> query_embedding
      LIMIT LEAST(match_count, 30) * 2
    ) s
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
$function$;

CREATE OR REPLACE FUNCTION public.hybrid_search_memory(query_text text, query_embedding halfvec, match_count integer DEFAULT 10, source_type_filter text DEFAULT NULL::text, full_text_weight double precision DEFAULT 1.0, semantic_weight double precision DEFAULT 1.0, rrf_k integer DEFAULT 50, owner_filter text DEFAULT 'owner'::text)
 RETURNS SETOF memory_chunks
 LANGUAGE sql
 STABLE
AS $function$
  WITH full_text AS (
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
    SELECT chunk_id, row_number() OVER (ORDER BY dist) AS rank_ix
    FROM (
      SELECT chunk_id, embedding <=> query_embedding AS dist
      FROM memory_chunks
      WHERE owner = owner_filter
        AND (source_type_filter IS NULL OR source_type = source_type_filter)
        AND embedding IS NOT NULL
      ORDER BY embedding <=> query_embedding
      LIMIT LEAST(match_count, 30) * 2
    ) s
  )
  SELECT memory_chunks.*
  FROM full_text
  FULL OUTER JOIN semantic ON full_text.chunk_id = semantic.chunk_id
  JOIN memory_chunks ON COALESCE(full_text.chunk_id, semantic.chunk_id) = memory_chunks.chunk_id
  ORDER BY
    COALESCE(1.0 / (rrf_k + full_text.rank_ix), 0.0) * full_text_weight
    + COALESCE(1.0 / (rrf_k + semantic.rank_ix), 0.0) * semantic_weight DESC
  LIMIT LEAST(match_count, 30);
$function$;

CREATE OR REPLACE FUNCTION public.hybrid_search_memory_recency(query_text text, query_embedding halfvec, match_count integer DEFAULT 10, source_type_filter text DEFAULT NULL::text, full_text_weight double precision DEFAULT 1.0, semantic_weight double precision DEFAULT 1.0, recency_weight double precision DEFAULT 0.0, rrf_k integer DEFAULT 60, owner_filter text DEFAULT 'owner'::text)
 RETURNS SETOF memory_chunks
 LANGUAGE sql
 STABLE
AS $function$
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
    SELECT chunk_id, row_number() OVER (ORDER BY dist) AS rank_ix
    FROM (
      SELECT chunk_id, embedding <=> query_embedding AS dist
      FROM memory_chunks
      WHERE owner = owner_filter
        AND (source_type_filter IS NULL OR source_type = source_type_filter)
        AND embedding IS NOT NULL
      ORDER BY embedding <=> query_embedding
      LIMIT LEAST(match_count, 30) * 2
    ) s
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
$function$;
