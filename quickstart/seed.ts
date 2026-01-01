// quickstart/seed.ts — apply the schema + load the synthetic demo corpus into the
// local pgvector stack, using psql INSIDE the db container (no host deps beyond docker).
//
//   1. role scaffolding (init-roles.sql) — PostgREST authenticator/anon/service_role
//   2. every migration in supabase/migrations, in timestamp order
//   3. the synthetic corpus from corpus.json (+ committed vectors if prep has run)
//   4. reload PostgREST's schema cache
//
// Embeddings are OPTIONAL: with corpus-embeddings.json present the semantic demo
// works; without it the corpus loads with NULL embeddings and the lexical demo
// still works fully (no API key either way).

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const COMPOSE = join(HERE, "docker-compose.yml");
const DEMO_BATCH = "00000000-0000-0000-0000-0000000000d1";

const lit = (s: string) => "'" + s.replace(/'/g, "''") + "'";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// 1) + 2) DDL: role scaffolding, then every migration in order.
const migrationsDir = join(REPO, "supabase", "migrations");
const migrations = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
// Clean slate so `demo:seed` is idempotent (migrations are CREATE, not CREATE IF
// NOT EXISTS). Roles are created at db boot (init-roles.sql via initdb.d); the
// SCHEMA-level grants are re-applied here because we recreate public. DROP also
// removes the pgvector extension — initial.sql's CREATE EXTENSION recreates it.
// The whole script runs in ONE transaction (psql -1) so the quarantine_dedup
// migration's LOCK TABLE is valid and the seed is all-or-nothing.
let script =
  "DROP SCHEMA IF EXISTS public CASCADE;\n" +
  "CREATE SCHEMA public;\n" +
  "GRANT USAGE ON SCHEMA public TO anon, service_role;\n" +
  "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO anon, service_role;\n" +
  "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT INSERT, UPDATE, DELETE ON TABLES TO service_role;\n" +
  "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, service_role;\n";
for (const m of migrations) {
  script += `\n-- migration: ${m}\n` + readFileSync(join(migrationsDir, m), "utf8") + "\n";
}

// 3) corpus rows.
interface Chunk { turn_index: number; role: string; content: string; occurred_at: string }
interface Session { session_id: string; summary: string; started_at: string; chunks: Chunk[] }
const corpus = JSON.parse(readFileSync(join(HERE, "corpus.json"), "utf8")) as {
  owner?: string;
  sessions: Session[];
};
const embPath = join(HERE, "corpus-embeddings.json");
const embeddings: Record<string, number[]> = existsSync(embPath)
  ? JSON.parse(readFileSync(embPath, "utf8"))
  : {};
const owner = corpus.owner ?? "owner";

let chunkCount = 0;
let withVectors = 0;
for (const s of corpus.sessions) {
  script +=
    `\nINSERT INTO sessions (session_id, source_machine, source_path, ingest_batch, started_at, message_count, byte_size, summary, owner) ` +
    `VALUES (${lit(s.session_id)}, 'local', ${lit("demo://" + s.session_id)}, '${DEMO_BATCH}', ${lit(s.started_at)}, ${s.chunks.length}, 0, ${lit(s.summary)}, ${lit(owner)});\n`;
  for (const c of s.chunks) {
    const h = sha256(c.content);
    const vec = embeddings[h];
    let embSql = "NULL";
    if (Array.isArray(vec) && vec.length > 0) {
      embSql = `'[${vec.join(",")}]'::halfvec(${vec.length})`;
      withVectors++;
    }
    script +=
      `INSERT INTO session_chunks (session_id, turn_index, role, content, content_hash, embedding, source_machine, ingest_batch, occurred_at, owner) ` +
      `VALUES (${lit(s.session_id)}, ${c.turn_index}, ${lit(c.role)}, ${lit(c.content)}, ${lit(h)}, ${embSql}, 'local', '${DEMO_BATCH}', ${lit(c.occurred_at)}, ${lit(owner)});\n`;
    chunkCount++;
  }
}

console.log(
  `Seeding ${corpus.sessions.length} sessions / ${chunkCount} chunks ` +
    `(embeddings: ${withVectors > 0 ? `${withVectors} present — semantic enabled` : "none — lexical-only demo"}).`,
);

execFileSync(
  "docker",
  ["compose", "-f", COMPOSE, "exec", "-T", "db", "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-1", "-q"],
  { input: script, stdio: ["pipe", "inherit", "inherit"] },
);

console.log("Reloading PostgREST schema cache...");
execFileSync("docker", ["compose", "-f", COMPOSE, "restart", "rest"], { stdio: "inherit" });
console.log("\nSeed complete. Try:  npm run demo");
