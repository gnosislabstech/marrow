// src/env.ts — Environment configuration loader + validator.
//
// Values are resolved by `op run --env-file=.env.tmpl` (via run.sh wrapper)
// and arrive in process.env. We validate eagerly and never log values.
//
// Fails fast with a useful message if a required key is missing.

import { loadConfig } from "./config.js";

type ContextualProvider = "anthropic" | "deepseek";

interface RequiredEnv {
  supabaseUrl: string;
  supabaseServiceKey: string;
  supabaseAnonKey: string;
  supabaseProjectRef: string;
  voyageApiKey: string;
  anthropicApiKey: string;
  deepseekApiKey: string;
  embeddingModel: string;
  embeddingDimensions: number;
  contextualProvider: ContextualProvider;
  contextualHaikuModel: string;
  contextualDeepseekModel: string;
  contextualParallel: number;
  rerankerModel: string;
  defaultOwner: string;
  /** Genericization layer (src/config.ts) — neutral public defaults, env-overridable. */
  productName: string;
  cliName: string;
  ownerLabel: string;
}

interface RuntimeFlags {
  dryRun: boolean;
}

export type Env = RequiredEnv & RuntimeFlags;

function readRequired(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(
      `Missing required env var: ${name}. Run via './run.sh' to load creds from 1Password.`
    );
  }
  return value.trim();
}

function readOptional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value.trim() : fallback;
}

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Env var ${name} is not a valid integer: "${raw}"`);
  }
  return parsed;
}

export function loadEnv(): Env {
  const dryRun =
    process.env.DRY_RUN === "1" ||
    process.env.DRY_RUN === "true" ||
    process.argv.includes("--dry-run");

  const provider = readOptional("CONTEXTUAL_PROVIDER", "deepseek").toLowerCase();
  if (provider !== "anthropic" && provider !== "deepseek") {
    throw new Error(
      `Invalid CONTEXTUAL_PROVIDER: "${provider}". Must be "anthropic" or "deepseek".`,
    );
  }

  const cfg = loadConfig();

  return {
    // Required secrets
    supabaseUrl: readRequired("SUPABASE_URL"),
    supabaseServiceKey: readRequired("SUPABASE_SERVICE_KEY"),
    supabaseAnonKey: readRequired("SUPABASE_ANON_KEY"),
    supabaseProjectRef: readRequired("SUPABASE_PROJECT_REF"),
    voyageApiKey: readRequired("VOYAGE_API_KEY"),
    anthropicApiKey: readRequired("ANTHROPIC_API_KEY"),
    deepseekApiKey: readRequired("DEEPSEEK_API_KEY"),

    // Genericizable config (owner / brand / models) — neutral public defaults from
    // src/config.ts, overridable via env (the private overlay sets the real values).
    embeddingModel: cfg.embeddingModel,
    embeddingDimensions: readNumber("EMBEDDING_DIMENSIONS", 1024),
    contextualProvider: provider as ContextualProvider,
    contextualHaikuModel: readOptional("CONTEXTUAL_HAIKU_MODEL", "claude-haiku-4-5-20251001"),
    contextualDeepseekModel: readOptional("CONTEXTUAL_DEEPSEEK_MODEL", "deepseek-chat"),
    contextualParallel: readNumber("CONTEXTUAL_PARALLEL", 8),
    rerankerModel: cfg.rerankerModel,
    defaultOwner: cfg.defaultOwner,
    productName: cfg.productName,
    cliName: cfg.cliName,
    ownerLabel: cfg.ownerLabel,

    // Runtime flags
    dryRun,
  };
}

/** Build PostgREST headers for service-role writes. */
export function makeSupabaseHeaders(env: Env): Record<string, string> {
  return {
    apikey: env.supabaseServiceKey,
    Authorization: `Bearer ${env.supabaseServiceKey}`,
    "Content-Type": "application/json",
    // Idempotent inserts: rely on UNIQUE constraints, silently skip duplicates
    Prefer: "return=minimal,resolution=ignore-duplicates",
  };
}

/** Build PostgREST headers that return the inserted/updated rows. */
export function makeSupabaseHeadersWithReturn(env: Env): Record<string, string> {
  return {
    apikey: env.supabaseServiceKey,
    Authorization: `Bearer ${env.supabaseServiceKey}`,
    "Content-Type": "application/json",
    Prefer: "return=representation,resolution=merge-duplicates",
  };
}

/** Voyage API headers. */
export function makeVoyageHeaders(env: Env): Record<string, string> {
  return {
    Authorization: `Bearer ${env.voyageApiKey}`,
    "Content-Type": "application/json",
  };
}

/** Anthropic API headers (for Haiku contextual prefix generation). */
export function makeAnthropicHeaders(env: Env): Record<string, string> {
  return {
    "x-api-key": env.anthropicApiKey,
    "anthropic-version": "2023-06-01",
    "Content-Type": "application/json",
  };
}

/** DeepSeek API headers (OpenAI-compatible, for Contextual Retrieval prefix). */
export function makeDeepseekHeaders(env: Env): Record<string, string> {
  return {
    Authorization: `Bearer ${env.deepseekApiKey}`,
    "Content-Type": "application/json",
  };
}
