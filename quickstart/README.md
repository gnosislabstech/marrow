# Quickstart — zero-key local demo

A throwaway local stack (pgvector + PostgREST) seeded with a small synthetic
corpus, so you can see the engine's retrieval — the real `hybrid_search_sessions`
RPC, the same path it uses against Supabase — with **no API key and no external
service**.

## Prerequisites

- Docker + Docker Compose
- Node ≥ 22 (for the seed/demo scripts) and the repo's dev deps (`npm install`)

## Run it

```bash
npm run demo:up      # start pgvector + PostgREST (waits for health)
npm run demo:seed    # apply schema + load the synthetic corpus
npm run demo         # query it
npm run demo:down    # tear down (drops the volume — the demo is disposable)
```

`npm run demo` prints a **lexical** result for a full-text query, e.g.:

```
LEXICAL   "flaky integration test under parallelism"
  [demo-flaky-test · turn 0] Our checkout integration test passes locally but fails about one run in five on CI…
  [demo-flaky-test · turn 3] That's the leak. Give each worker its own connection and transaction…
```

Every hit cites its source (`session_id` + turn) — that's the engine's contract:
**no answer without a traceable chunk.**

## Enabling the semantic demo (one-time, keyed)

The lexical demo needs no key. The semantic demo needs real embeddings, which
must come from the embedding provider (you can't fabricate vectors that match a
query). Generate them once and commit them — the demo is keyless for everyone
after:

```bash
npm run demo:prep    # needs a Voyage key in env (via run.sh); ~fractions of a cent
npm run demo:seed    # reloads the corpus with the committed vectors
npm run demo         # now also prints a SEMANTIC result
```

`demo:prep` writes `corpus-embeddings.json` + `demo-query.json` (synthetic-content
vectors — safe to commit). With them present, `npm run demo` adds:

```
SEMANTIC  "what makes a database query slow and how do I make it faster"
  [demo-slow-query · turn 1] Run EXPLAIN ANALYZE on it. Look for a sequential scan…
  [demo-slow-query · turn 3] Add a composite index on (customer_id, created_at)…
```

— note the query words never appear in those chunks. That's vector retrieval.

## Point it at your own corpus (BYO)

The demo is a toy. For real use, ingest your own Claude Code sessions into your
own database and search them. See the root `README` — in short: configure a
Supabase project (or any PostgREST + pgvector), set the env vars, and run
`npm run bootstrap`. The default source is `~/.claude/projects`; override it with
`src/sources.config.ts` (copy `src/sources.config.ts.example`).
