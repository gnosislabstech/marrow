-- ===================================================================
-- Initial schema — sessions, chunks, memory, quarantine, ingest runs
-- ===================================================================

CREATE EXTENSION IF NOT EXISTS vector;

-- ─── sessions ──────────────────────────────────────────────────────
-- One row per Claude Code session (or Claude.ai web conversation)
CREATE TABLE sessions (
  session_id      text PRIMARY KEY,
  source_machine  text NOT NULL,           -- ingest source label (e.g. 'local', 'archive', 'web')
  source_path     text NOT NULL,           -- full original path
  project_path    text,                    -- decoded project (e.g., "/home/<user>/<project>")
  ingest_batch    uuid NOT NULL,

  started_at      timestamptz,
  ended_at        timestamptz,
  message_count   integer NOT NULL DEFAULT 0,
  byte_size       bigint  NOT NULL DEFAULT 0,

  -- Distillation hooks (NULL until v0.2)
  summary             text,
  summary_embedding   vector(1024),
  topics              text[],

  owner           text NOT NULL DEFAULT 'owner',
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sessions_started_at_idx       ON sessions (started_at DESC);
CREATE INDEX sessions_source_machine_idx   ON sessions (source_machine);
CREATE INDEX sessions_project_path_idx     ON sessions (project_path);
CREATE INDEX sessions_owner_idx            ON sessions (owner);
CREATE INDEX sessions_topics_gin           ON sessions USING GIN (topics);
CREATE INDEX sessions_metadata_gin         ON sessions USING GIN (metadata);
CREATE INDEX sessions_summary_embed_hnsw   ON sessions USING hnsw (summary_embedding vector_cosine_ops)
                                           WHERE summary_embedding IS NOT NULL;

-- ─── session_chunks ────────────────────────────────────────────────
-- One row per "turn" within a session — primary search target
CREATE TABLE session_chunks (
  chunk_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      text NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,

  turn_index      integer NOT NULL,        -- ordering for replay
  role            text NOT NULL,           -- 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'compaction'
  content         text NOT NULL,
  content_hash    text NOT NULL,           -- sha256 — idempotency anchor
  embedding       vector(1024),            -- embedding (model per config; default voyage-4)

  source_machine  text NOT NULL,
  ingest_batch    uuid NOT NULL,
  occurred_at     timestamptz,             -- the turn's own timestamp

  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {tools_called: [...], file_paths_read: [...]}
  owner           text NOT NULL DEFAULT 'owner',
  created_at      timestamptz NOT NULL DEFAULT now(),

  UNIQUE (session_id, content_hash)
);

CREATE INDEX session_chunks_session_idx       ON session_chunks (session_id, turn_index);
CREATE INDEX session_chunks_occurred_at_idx   ON session_chunks (occurred_at DESC);
CREATE INDEX session_chunks_role_idx          ON session_chunks (role);
CREATE INDEX session_chunks_source_idx        ON session_chunks (source_machine);
CREATE INDEX session_chunks_owner_idx         ON session_chunks (owner);
CREATE INDEX session_chunks_metadata_gin      ON session_chunks USING GIN (metadata);
CREATE INDEX session_chunks_embed_hnsw        ON session_chunks USING hnsw (embedding vector_cosine_ops)
                                              WHERE embedding IS NOT NULL;

-- ─── memory_chunks ─────────────────────────────────────────────────
-- Memory files, observations, handoffs, timelines, briefings, doctrine
CREATE TABLE memory_chunks (
  chunk_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  source_path     text NOT NULL,           -- "memory/architect-handoff-..."
  source_type     text NOT NULL,           -- 'memory' | 'observation' | 'handoff' | 'timeline' | 'briefing' | 'doctrine'
  section_title   text,
  content         text NOT NULL,
  content_hash    text NOT NULL,
  embedding       vector(1024),

  source_machine  text NOT NULL DEFAULT 'local',
  ingest_batch    uuid NOT NULL,
  last_modified   timestamptz,

  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  owner           text NOT NULL DEFAULT 'owner',
  created_at      timestamptz NOT NULL DEFAULT now(),

  UNIQUE (source_path, content_hash)
);

CREATE INDEX memory_chunks_source_type_idx    ON memory_chunks (source_type);
CREATE INDEX memory_chunks_source_path_idx    ON memory_chunks (source_path);
CREATE INDEX memory_chunks_last_modified_idx  ON memory_chunks (last_modified DESC);
CREATE INDEX memory_chunks_owner_idx          ON memory_chunks (owner);
CREATE INDEX memory_chunks_metadata_gin       ON memory_chunks USING GIN (metadata);
CREATE INDEX memory_chunks_embed_hnsw         ON memory_chunks USING hnsw (embedding vector_cosine_ops)
                                              WHERE embedding IS NOT NULL;

-- ─── quarantine ───────────────────────────────────────────────────
-- Chunks rejected by privacy pre-scan — held for review, NOT embedded
CREATE TABLE quarantine (
  quarantine_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  source_table    text NOT NULL,           -- 'session_chunks' | 'memory_chunks'
  source_path     text NOT NULL,
  session_id      text,                    -- nullable; present for session quarantines

  content         text NOT NULL,           -- original content (NOT embedded — never reaches Voyage)
  reason          text NOT NULL,           -- 'op_ref' | 'api_key' | 'secret' | 'password' | 'bearer_token' | 'env_path'
  matched_pattern text,                    -- the regex that hit

  ingest_batch    uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX quarantine_reason_idx       ON quarantine (reason);
CREATE INDEX quarantine_source_path_idx  ON quarantine (source_path);
CREATE INDEX quarantine_created_at_idx   ON quarantine (created_at DESC);

-- ─── ingest_runs ──────────────────────────────────────────────────
-- DB-backed batch tracking. Replaces file checkpoint when v0.2 SessionEnd hook lands.
CREATE TABLE ingest_runs (
  ingest_batch    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_label    text NOT NULL,           -- ingest source label

  started_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz,
  status          text NOT NULL DEFAULT 'running',  -- 'running' | 'completed' | 'failed' | 'partial'

  files_total         integer DEFAULT 0,
  files_done          integer DEFAULT 0,
  files_failed        integer DEFAULT 0,
  chunks_inserted     integer DEFAULT 0,
  chunks_quarantined  integer DEFAULT 0,

  error_summary   text,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX ingest_runs_source_label_idx  ON ingest_runs (source_label);
CREATE INDEX ingest_runs_status_idx        ON ingest_runs (status);

-- ─── RLS — enable on all, zero anon policies (deny by default) ────
ALTER TABLE sessions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_chunks  ENABLE ROW LEVEL SECURITY;
ALTER TABLE quarantine     ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingest_runs    ENABLE ROW LEVEL SECURITY;
-- service_role bypasses RLS automatically; anon has no policies = denied.

-- ─── updated_at trigger for sessions ──────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sessions_updated_at
BEFORE UPDATE ON sessions
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
