// quickstart/prep-embeddings.ts — ONE-TIME keyed prep that makes the semantic
// demo zero-key for everyone after.
//
//   ./run.sh quickstart/prep-embeddings.ts        (needs a Voyage key in env)
//
// Embeds the synthetic corpus (input_type=document) + one canned query
// (input_type=query) with the engine's configured model, writing:
//   quickstart/corpus-embeddings.json   sha256(content) -> vector
//   quickstart/demo-query.json          { text, embedding }
// Commit both; the demo then runs with no key. Cost is a few fractions of a cent
// (a dozen short chunks). Corpus + query are embedded with the SAME model in one
// run, so the committed vectors are internally consistent regardless of model.

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadEnv } from "../src/env.js";
import { embedBatch } from "../src/embedding.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const env = loadEnv();
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

interface Chunk { content: string }
interface Session { chunks: Chunk[] }
const corpus = JSON.parse(readFileSync(join(HERE, "corpus.json"), "utf8")) as { sessions: Session[] };

const texts: string[] = [];
const hashes: string[] = [];
for (const s of corpus.sessions) {
  for (const c of s.chunks) {
    texts.push(c.content);
    hashes.push(sha256(c.content));
  }
}

console.log(`Embedding ${texts.length} corpus chunks with ${env.embeddingModel} (input_type=document)...`);
const { embeddings } = await embedBatch(env, texts, "document");
const out: Record<string, number[]> = {};
embeddings.forEach((e, i) => { out[hashes[i]] = e; });
writeFileSync(join(HERE, "corpus-embeddings.json"), JSON.stringify(out));

const queryText = "what makes a database query slow and how do I make it faster";
console.log(`Embedding the canned demo query (input_type=query)...`);
const { embeddings: qe } = await embedBatch(env, [queryText], "query");
writeFileSync(join(HERE, "demo-query.json"), JSON.stringify({ text: queryText, embedding: qe[0] }));

console.log(
  `\nWrote quickstart/corpus-embeddings.json (${texts.length} chunks) + demo-query.json.\n` +
    `Commit both, then re-run:  npm run demo:seed  &&  npm run demo`,
);
