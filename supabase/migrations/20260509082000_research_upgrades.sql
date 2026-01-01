-- ===================================================================
-- Research-driven upgrades:
--   1. halfvec(1024) instead of vector(1024) — 50% storage, <1% recall loss
--   2. fts tsvector for hybrid search (lexical + semantic)
--   3. parent_chunk_id for parent-document retrieval
--   4. hybrid_search_sessions() + hybrid_search_memory() RPCs (RRF)
--   5. HNSW tuning: m=16, ef_construction=128
-- ===================================================================

-- ─── 1. Switch embeddings to halfvec ──────────────────────────────
-- Drop existing HNSW indexes (they reference vector_cosine_ops)
DROP INDEX IF EXISTS sessions_summary_embed_hnsw;
DROP INDEX IF EXISTS session_chunks_embed_hnsw;
DROP INDEX IF EXISTS memory_chunks_embed_hnsw;

-- Cast columns to halfvec
ALTER TABLE sessions
  ALTER COLUMN summary_embedding TYPE halfvec(1024)
  USING summary_embedding::halfvec(1024);

ALTER TABLE session_chunks
  ALTER COLUMN embedding TYPE halfvec(1024)
  USING embedding::halfvec(1024);

ALTER TABLE memory_chunks
  ALTER COLUMN embedding TYPE halfvec(1024)
  USING embedding::halfvec(1024);

-- Recreate HNSW indexes with halfvec_cosine_ops + tuning
CREATE INDEX sessions_summary_embed_hnsw ON sessions
  USING hnsw (summary_embedding halfvec_cosine_ops)
  WITH (m=16, ef_construction=128)
  WHERE summary_embedding IS NOT NULL;

CREATE INDEX session_chunks_embed_hnsw ON session_chunks
  USING hnsw (embedding halfvec_cosine_ops)
  WITH (m=16, ef_construction=128)
  WHERE embedding IS NOT NULL;

CREATE INDEX memory_chunks_embed_hnsw ON memory_chunks
  USING hnsw (embedding halfvec_cosine_ops)
  WITH (m=16, ef_construction=128)
  WHERE embedding IS NOT NULL;

-- ─── 2. fts tsvector for hybrid search ────────────────────────────
ALTER TABLE session_chunks
  ADD COLUMN fts tsvector
  GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;

ALTER TABLE memory_chunks
  ADD COLUMN fts tsvector
  GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;

CREATE INDEX session_chunks_fts_gin ON session_chunks USING GIN (fts);
CREATE INDEX memory_chunks_fts_gin  ON memory_chunks  USING GIN (fts);

-- ─── 3. Parent-document retrieval ─────────────────────────────────
-- Sub-chunks (when a single turn-window > 8000 chars) reference their parent.
-- Search returns matching child chunks; UI/MCP layer joins to fetch parent context.
ALTER TABLE session_chunks
  ADD COLUMN parent_chunk_id uuid
  REFERENCES session_chunks(chunk_id) ON DELETE SET NULL;

CREATE INDEX session_chunks_parent_idx ON session_chunks (parent_chunk_id)
  WHERE parent_chunk_id IS NOT NULL;

-- ─── 4. Hybrid search RPC: session_chunks ─────────────────────────
-- Reciprocal Rank Fusion (k=50) of semantic + lexical, owner-scoped.
-- MCP server calls this then optionally pipes top-30 through Voyage rerank-2.5-lite.
CREATE OR REPLACE FUNCTION hybrid_search_sessions(
  query_text text,
  query_embedding halfvec(1024),
  match_count int DEFAULT 10,
  full_text_weight float DEFAULT 1.0,
  semantic_weight float DEFAULT 1.0,
  rrf_k int DEFAULT 50,
  owner_filter text DEFAULT 'owner'
) RETURNS SETOF session_chunks
LANGUAGE sql STABLE AS $$
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
    SELECT chunk_id, row_number() OVER (
      ORDER BY embedding <=> query_embedding
    ) AS rank_ix
    FROM session_chunks
    WHERE owner = owner_filter
      AND embedding IS NOT NULL
    ORDER BY rank_ix
    LIMIT LEAST(match_count, 30) * 2
  )
  SELECT session_chunks.*
  FROM full_text
  FULL OUTER JOIN semantic ON full_text.chunk_id = semantic.chunk_id
  JOIN session_chunks ON COALESCE(full_text.chunk_id, semantic.chunk_id) = session_chunks.chunk_id
  ORDER BY
    COALESCE(1.0 / (rrf_k + full_text.rank_ix), 0.0) * full_text_weight
    + COALESCE(1.0 / (rrf_k + semantic.rank_ix), 0.0) * semantic_weight DESC
  LIMIT LEAST(match_count, 30);
$$;

-- ─── 5. Hybrid search RPC: memory_chunks ──────────────────────────
-- Same shape, plus optional source_type facet (memory/observation/handoff/timeline/briefing/doctrine)
CREATE OR REPLACE FUNCTION hybrid_search_memory(
  query_text text,
  query_embedding halfvec(1024),
  match_count int DEFAULT 10,
  source_type_filter text DEFAULT NULL,
  full_text_weight float DEFAULT 1.0,
  semantic_weight float DEFAULT 1.0,
  rrf_k int DEFAULT 50,
  owner_filter text DEFAULT 'owner'
) RETURNS SETOF memory_chunks
LANGUAGE sql STABLE AS $$
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
    SELECT chunk_id, row_number() OVER (
      ORDER BY embedding <=> query_embedding
    ) AS rank_ix
    FROM memory_chunks
    WHERE owner = owner_filter
      AND (source_type_filter IS NULL OR source_type = source_type_filter)
      AND embedding IS NOT NULL
    ORDER BY rank_ix
    LIMIT LEAST(match_count, 30) * 2
  )
  SELECT memory_chunks.*
  FROM full_text
  FULL OUTER JOIN semantic ON full_text.chunk_id = semantic.chunk_id
  JOIN memory_chunks ON COALESCE(full_text.chunk_id, semantic.chunk_id) = memory_chunks.chunk_id
  ORDER BY
    COALESCE(1.0 / (rrf_k + full_text.rank_ix), 0.0) * full_text_weight
    + COALESCE(1.0 / (rrf_k + semantic.rank_ix), 0.0) * semantic_weight DESC
  LIMIT LEAST(match_count, 30);
$$;
