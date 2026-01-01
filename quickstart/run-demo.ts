// quickstart/run-demo.ts — query the seeded demo corpus through the SAME
// retrieval path the engine uses against Supabase: the hybrid_search_sessions
// RPC over PostgREST. No API key: the lexical demo needs none, and the semantic
// demo uses a pre-computed query vector (committed by `npm run demo:prep`).

import { readFileSync, existsSync } from "node:fs";
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REST = process.env.DEMO_REST_URL ?? "http://localhost:54330";

// Mint a service_role JWT signed with the demo stack's JWT secret — it MUST match
// PGRST_JWT_SECRET in docker-compose.yml, so we sign it here rather than hardcode a
// token (a mismatched token is the classic JWSInvalidSignature 401). service_role
// bypasses RLS exactly like a real Supabase service key. Local-only; not sensitive.
const JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";
function mintJwt(role: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const header = b64({ alg: "HS256", typ: "JWT" });
  const payload = b64({ role });
  const sig = createHmac("sha256", JWT_SECRET).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}
const SERVICE_KEY = mintJwt("service_role");

const ZERO_VEC = "[" + Array(1024).fill(0).join(",") + "]";

interface Hit { session_id: string; turn_index: number; role: string; content: string }

async function search(opts: {
  queryText: string;
  embedding: string;
  fullTextWeight: number;
  semanticWeight: number;
}): Promise<Hit[]> {
  const res = await fetch(`${REST}/rpc/hybrid_search_sessions`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      query_text: opts.queryText,
      query_embedding: opts.embedding,
      match_count: 3,
      full_text_weight: opts.fullTextWeight,
      semantic_weight: opts.semanticWeight,
      rrf_k: 60,
      owner_filter: "owner",
    }),
  });
  if (!res.ok) {
    throw new Error(`PostgREST ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return (await res.json()) as Hit[];
}

function show(title: string, hits: Hit[]): void {
  console.log(`\n${title}`);
  if (hits.length === 0) {
    console.log("  (no matches)");
    return;
  }
  for (const h of hits) {
    const snippet = h.content.replace(/\s+/g, " ").slice(0, 110);
    console.log(`  [${h.session_id} · turn ${h.turn_index}] ${snippet}${h.content.length > 110 ? "…" : ""}`);
  }
}

async function waitForRest(timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${REST}/`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
      });
      if (r.ok) return;
    } catch {
      /* not reachable yet */
    }
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error(`PostgREST not reachable at ${REST} after ${timeoutMs}ms — is the stack up + seeded?`);
}

await waitForRest();

// Show the capability the corpus state supports, each kept clean:
//   vectors committed → SEMANTIC retrieval (the headline: matched by meaning)
//   keyless           → LEXICAL retrieval (full-text; with no embeddings the
//                       semantic CTE is empty, so results stay precise)
const qPath = join(HERE, "demo-query.json");
if (existsSync(qPath)) {
  const q = JSON.parse(readFileSync(qPath, "utf8")) as { text: string; embedding: number[] };
  show(`SEMANTIC  "${q.text}"`, await search({
    queryText: q.text,
    embedding: `[${q.embedding.join(",")}]`,
    fullTextWeight: 0.0,
    semanticWeight: 1.0,
  }));
  console.log(
    "\n  ↑ the query words never appear in those chunks — matched by meaning, each cited.\n" +
      "    Lexical full-text search also works (it's the keyless path; see the README).",
  );
} else {
  const lexQuery = "flaky integration test";
  show(`LEXICAL   "${lexQuery}"`, await search({
    queryText: lexQuery,
    embedding: ZERO_VEC,
    fullTextWeight: 1.0,
    semanticWeight: 0.0,
  }));
  console.log(
    "\n  Every hit cites its source. Semantic (match-by-meaning) search needs vectors —\n" +
      "  run `npm run demo:prep` once with a Voyage key to enable it.",
  );
}

console.log();
