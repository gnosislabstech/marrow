// src/embedding.ts — Voyage embedding batch wrapper.
//
// Patterns (battle-tested in prior projects):
//   - sanitizeUtf8 strips control chars + lone surrogates Voyage rejects
//   - validateEmbedding checks expected dimension (catches truncation/corruption)
//   - Batch of 128 inputs/request (under Voyage's 120K token limit)
//   - Exponential backoff on 429/503

import type { Env } from "./env.js";
import { makeVoyageHeaders } from "./env.js";

const VOYAGE_API_URL = "https://api.voyageai.com/v1/embeddings";

export const EMBED_BATCH_SIZE = 128;

// Voyage hard limit: 120,000 tokens per batch. Stay under with margin.
const VOYAGE_MAX_TOKENS_PER_BATCH = 100_000;
const APPROX_CHARS_PER_TOKEN = 3.5;

/**
 * Split a list of texts into batches that respect both the chunk-count cap
 * (EMBED_BATCH_SIZE) AND the token-count cap (VOYAGE_MAX_TOKENS_PER_BATCH).
 *
 * Without this, a batch of 128 chunks averaging ~1000 tokens each = 128K tokens
 * → Voyage rejects with HTTP 400 (observed on large live ingests: sessions
 * failed with batches of 130-145K tokens).
 */
export function splitIntoVoyageBatches(texts: string[]): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let currentTokens = 0;

  for (const text of texts) {
    const tokens = Math.ceil(text.length / APPROX_CHARS_PER_TOKEN);

    // Close current batch if adding this text would exceed either cap
    if (
      current.length > 0 &&
      (current.length >= EMBED_BATCH_SIZE ||
        currentTokens + tokens > VOYAGE_MAX_TOKENS_PER_BATCH)
    ) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }

    current.push(text);
    currentTokens += tokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** Strip lone surrogates and control chars Voyage rejects. */
export function sanitizeUtf8(text: string): string {
  return (
    text
      // toWellFormed() replaces only LONE surrogates with U+FFFD — valid
      // surrogate pairs (emoji, non-BMP chars) are preserved. A naive
      // surrogate-range strip would delete every non-BMP character.
      .toWellFormed()
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
      .replace(/�/g, "")
  );
}

/** Validate that a returned embedding is the expected dimension. */
export function validateEmbedding(
  embedding: number[],
  expectedDim: number,
): boolean {
  return Array.isArray(embedding) && embedding.length === expectedDim;
}

interface VoyageResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  usage: { total_tokens: number };
}

export interface EmbedResult {
  embeddings: number[][];
  totalTokens: number;
}

/**
 * Embed a batch of texts via Voyage. Returns embeddings in the same order
 * as inputs. Throws on persistent API errors or dimension mismatches.
 *
 * inputType:
 *   - "document" at ingest (asymmetric retrieval, this side stored)
 *   - "query" at search time (asymmetric retrieval, this side transient)
 */
export async function embedBatch(
  env: Env,
  texts: string[],
  inputType: "document" | "query" = "document",
  retries = 3,
): Promise<EmbedResult> {
  if (texts.length === 0) {
    return { embeddings: [], totalTokens: 0 };
  }
  if (texts.length > EMBED_BATCH_SIZE) {
    throw new Error(
      `embedBatch called with ${texts.length} texts; max is ${EMBED_BATCH_SIZE}`,
    );
  }

  const sanitized = texts.map(sanitizeUtf8);
  const headers = makeVoyageHeaders(env);
  const body = {
    input: sanitized,
    model: env.embeddingModel,
    input_type: inputType,
    output_dimension: env.embeddingDimensions,
  };

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const resp = await fetch(VOYAGE_API_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });

      if (resp.status === 429 || resp.status === 503) {
        const wait = Math.pow(2, attempt) * 1000;
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Voyage API ${resp.status}: ${text.slice(0, 200)}`);
      }

      const data = (await resp.json()) as VoyageResponse;
      const embeddings = new Array<number[]>(data.data.length);
      for (const d of data.data) {
        if (!validateEmbedding(d.embedding, env.embeddingDimensions)) {
          throw new Error(
            `Voyage returned wrong-dim embedding at index ${d.index}: ` +
              `expected ${env.embeddingDimensions}, got ${d.embedding?.length}`,
          );
        }
        embeddings[d.index] = d.embedding;
      }
      return { embeddings, totalTokens: data.usage.total_tokens };
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (attempt < retries - 1) {
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 500));
      }
    }
  }
  throw lastErr ?? new Error("embedBatch failed after retries");
}

/**
 * Format a halfvec(1024) for PostgREST insertion.
 * pgvector's halfvec accepts the same `[0.1,0.2,...]` text form as vector.
 */
export function embeddingToPostgresArray(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}
