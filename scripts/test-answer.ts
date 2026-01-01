// scripts/test-answer.ts — Smoke test the synthesis pipeline.
// Usage: ./run.sh scripts/test-answer.ts "your question here"
// Validates: query embedding → hybrid search → rerank → LLM synthesis → cited answer

import { loadEnv } from "../src/env.js";
import { synthesizeAnswer } from "../src/search.js";

const env = loadEnv();
const q = process.argv[2] ?? "How did I configure DeepSeek for Contextual Retrieval and what cache hit rate did I observe?";
console.log(`\nQ: ${q}\n`);
const r = await synthesizeAnswer(env, q, { matchCount: 8, rerank: true });
console.log(`A (${r.ms}ms, $${r.cost_estimate_usd.toFixed(5)}):\n${r.answer}`);
console.log(`\n--- citations (${r.citations.length}) ---`);
for (const c of r.citations) {
  if (c.kind === "session") {
    console.log(`[${c.n}] session=${c.session_id?.slice(0,8)} turn=${c.turn_index} ${c.occurred_at?.slice(0,10)}`);
  } else {
    console.log(`[${c.n}] memory=${c.source_path}`);
  }
}
