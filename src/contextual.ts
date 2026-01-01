// src/contextual.ts — Anthropic Contextual Retrieval prefix generation.
//
// Per session, we cache the WHOLE projected session text once, then iterate
// each chunk to produce a 50-100 token contextual prefix.
// We concatenate `prefix + "\n\n" + chunk` before embedding.
//
// Two providers supported (env.contextualProvider):
//   - "anthropic" — Haiku 4.5 with explicit cache_control markers (5-min TTL)
//   - "deepseek"  — DeepSeek V3.1 with auto-detected prefix caching (cheaper, faster wall-clock at scale)
//
// Reference: https://www.anthropic.com/news/contextual-retrieval (Sep 2024)

import type { Env } from "./env.js";
import { makeAnthropicHeaders, makeDeepseekHeaders } from "./env.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions";

/** Hard ceiling per CR call — a hung socket must not stall ingest. */
const CR_TIMEOUT_MS = 60_000;

const CHUNK_PROMPT_TEMPLATE = (chunkContent: string) =>
  `Here is the chunk we want to situate within the whole document\n` +
  `<chunk>\n${chunkContent}\n</chunk>\n` +
  `Please give a short succinct context to situate this chunk within the overall document for the purposes of improving search retrieval of the chunk.\n` +
  `Answer only with the succinct context and nothing else.`;

export interface ContextualPrefix {
  prefix: string;
  cacheRead: number;
  cacheCreate: number;
  inputTokens: number;
  outputTokens: number;
}

// ─── Anthropic provider ───────────────────────────────────────────

interface AnthropicMessageResponse {
  content: Array<{ type: string; text?: string }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

async function generateAnthropic(
  env: Env,
  documentText: string,
  chunkContent: string,
  retries: number,
): Promise<ContextualPrefix> {
  const body = {
    model: env.contextualHaikuModel,
    max_tokens: 200,
    messages: [
      {
        role: "user" as const,
        content: [
          {
            type: "text" as const,
            text: `<document>\n${documentText}\n</document>`,
            cache_control: { type: "ephemeral" as const },
          },
          {
            type: "text" as const,
            text: CHUNK_PROMPT_TEMPLATE(chunkContent),
          },
        ],
      },
    ],
  };

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const resp = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: makeAnthropicHeaders(env),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CR_TIMEOUT_MS),
      });

      if (resp.status === 429 || resp.status === 529 || resp.status === 503) {
        const wait = Math.pow(2, attempt) * 1000;
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Anthropic ${resp.status}: ${text.slice(0, 200)}`);
      }

      const data = (await resp.json()) as AnthropicMessageResponse;
      const textBlock = data.content.find((c) => c.type === "text");
      const prefix = textBlock?.text?.trim() ?? "";

      return {
        prefix,
        cacheRead: data.usage?.cache_read_input_tokens ?? 0,
        cacheCreate: data.usage?.cache_creation_input_tokens ?? 0,
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
      };
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (attempt < retries - 1) {
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 500));
      }
    }
  }
  throw lastErr ?? new Error("Anthropic CR failed after retries");
}

// ─── DeepSeek provider ────────────────────────────────────────────

interface DeepseekChatResponse {
  choices: Array<{ message: { content: string } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  };
}

async function generateDeepseek(
  env: Env,
  documentText: string,
  chunkContent: string,
  retries: number,
): Promise<ContextualPrefix> {
  // DeepSeek auto-detects repeated prefixes. The document goes first
  // (unchanged across chunks) so it gets cached automatically.
  const body = {
    model: env.contextualDeepseekModel,
    max_tokens: 200,
    temperature: 0,
    messages: [
      {
        role: "user" as const,
        content:
          `<document>\n${documentText}\n</document>\n\n` +
          CHUNK_PROMPT_TEMPLATE(chunkContent),
      },
    ],
  };

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const resp = await fetch(DEEPSEEK_API_URL, {
        method: "POST",
        headers: makeDeepseekHeaders(env),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CR_TIMEOUT_MS),
      });

      if (resp.status === 429 || resp.status === 503 || resp.status === 502) {
        const wait = Math.pow(2, attempt) * 1000;
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`DeepSeek ${resp.status}: ${text.slice(0, 200)}`);
      }

      const data = (await resp.json()) as DeepseekChatResponse;
      const prefix = data.choices[0]?.message?.content?.trim() ?? "";

      // Map DeepSeek usage shape onto our ContextualPrefix telemetry shape.
      const cacheHit = data.usage?.prompt_cache_hit_tokens ?? 0;
      const cacheMiss = data.usage?.prompt_cache_miss_tokens ?? 0;
      return {
        prefix,
        cacheRead: cacheHit,
        cacheCreate: cacheMiss, // DeepSeek doesn't separate cache writes — count misses as creates for cost tracking
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      };
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (attempt < retries - 1) {
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 500));
      }
    }
  }
  throw lastErr ?? new Error("DeepSeek CR failed after retries");
}

// ─── Public API ───────────────────────────────────────────────────

/**
 * Generate a contextual prefix for a chunk against its parent document.
 * Routes to the configured provider (env.contextualProvider).
 */
export async function generateContextualPrefix(
  env: Env,
  documentText: string,
  chunkContent: string,
  retries = 3,
): Promise<ContextualPrefix> {
  if (env.contextualProvider === "deepseek") {
    return generateDeepseek(env, documentText, chunkContent, retries);
  }
  return generateAnthropic(env, documentText, chunkContent, retries);
}

// Haiku 4.5 supports 200K context. DeepSeek V3.1 supports 128K context.
// Cap document at 400K chars (~100K tokens) — fits both with margin for chunk + prompt.
const MAX_DOCUMENT_CHARS = 400_000;

/**
 * Truncate a session document to fit either provider's context window with margin.
 * For very long sessions, keep beginning + end + ellipsis marker.
 */
export function truncateDocumentForContext(documentText: string): string {
  if (documentText.length <= MAX_DOCUMENT_CHARS) return documentText;
  const half = MAX_DOCUMENT_CHARS / 2;
  return (
    documentText.slice(0, half) +
    "\n\n[...session truncated for context...]\n\n" +
    documentText.slice(-half)
  );
}

/**
 * Concatenate prefix + chunk per Anthropic's recommended pattern.
 * Output is what gets fed to Voyage for embedding.
 */
export function concatPrefixWithChunk(prefix: string, chunk: string): string {
  if (!prefix) return chunk;
  return `${prefix}\n\n${chunk}`;
}
