# Security

This document describes the security model honestly: what the engine protects,
what it deliberately does not, and how to report a vulnerability. It claims only
controls that exist in the code.

## Threat model in one line

The engine indexes your own corpus into your own database and answers questions
over it with citations. The sensitive asset is **your corpus**. The controls
below keep it in your control and keep secrets out of the index.

## Controls that exist

- **No phone-home.** The engine has no telemetry and makes no network calls to
  the project or its authors. The only outbound calls are to the embedding /
  LLM / database providers **you configure, with your own API keys** — Voyage
  for embeddings, optionally Anthropic or DeepSeek for retrieval-prefix
  generation, and your Postgres/PostgREST (e.g. Supabase). Your corpus content
  is sent to *those* providers (your choice of vendor), and nowhere else.

- **Your data stays in your database.** Sessions, chunks, and memory live in the
  Postgres instance you point the engine at. There is no shared backend.

- **RLS deny-by-default.** Every table has Row Level Security enabled with zero
  permissive policies (`supabase/migrations/...initial.sql`). The service role
  is the only path that reads or writes; an anonymous client sees nothing.

- **Secrets are quarantined before they can be embedded.** A regex pre-scan runs
  on every chunk *before* it reaches an embedding provider. Anything matching a
  secret shape (API keys, private key blocks, bearer tokens, `op://` references,
  env-path patterns, etc.) is routed to a `quarantine` table that has **no
  embedding column** — so it never reaches the embedding network. Quarantined
  content is stored as a **salted SHA-256 fingerprint plus a short prefix, not
  the raw value** (`src/privacy.ts`), so the quarantine log itself is not a
  secret store.

- **Quarantined content is also excluded from Contextual Retrieval.** The CR
  prefix step sends a whole-session `<document>` to the prefix provider
  (Anthropic or DeepSeek). That document is built **only from windows that
  passed the privacy pre-scan**, so a secret quarantined out of one chunk never
  rides to the prefix provider inside another chunk's context
  (`scripts/bootstrap.ts`).

## What this does NOT do (no overclaim)

- **It is not a multi-tenant or access-controlled service.** Anyone with the
  service-role key to your database has full access. Protect that key.
- **It does not encrypt your corpus at rest beyond what your database provides.**
- **The identity scrubber is opt-in, not a security boundary.** A
  config-driven `identityScrub` utility exists (`src/scrub.ts`) that can replace
  home paths / usernames / project refs with placeholders. It is **not wired
  into the default pipeline and is not claimed as a control**: the corpus never
  becomes public, so scrubbing your own identity from your own private database
  defends nothing. It is provided as an optional convenience for operators who
  want it; wire it at your own discretion.

## Reporting a vulnerability

Please do **not** open a public issue for security problems.

- Open a private security advisory via the repository's **Security → Report a
  vulnerability** (GitHub Private Vulnerability Reporting), **or**
- email the maintainer (see the contact in the repository's `README` /
  organization profile).

We aim to acknowledge reports within a few business days and will coordinate a
fix and disclosure timeline with you. There is no bug-bounty program.
