// src/config.ts — genericization layer.
//
// Everything owner-, brand-, or infra-specific that the engine must NOT hardcode
// lives here with NEUTRAL public defaults, overridable via env. The private overlay
// sets the real values through env (e.g. DEFAULT_OWNER=alice, CB_PRODUCT_NAME=Acme,
// EMBEDDING_MODEL=voyage-4); the public tree ships the neutral defaults below.
//
// The product name is deliberately NOT load-bearing: no code branches on its value,
// and nothing derives a path, identifier, or behavior from it. Renaming is a config
// flip, never a refactor.

export interface AppConfig {
  /** Product display name — banners, log prefixes, prompts. Neutral by default. */
  productName: string;
  /** CLI binary name used in help/usage text. */
  cliName: string;
  /** Human label for the corpus owner, used in synthesis prompts. */
  ownerLabel: string;
  /** Owner key scoping rows in the DB `owner` column. */
  defaultOwner: string;
  /** Embedding model id (public default flips to voyage-4). */
  embeddingModel: string;
  /** Reranker model id. */
  rerankerModel: string;
  /** Placeholder used where a real project ref must never appear (scrubbing). */
  projectRefPlaceholder: string;
}

export const DEFAULT_CONFIG: AppConfig = {
  productName: "Marrow",
  cliName: "cb",
  ownerLabel: "the operator",
  defaultOwner: "owner",
  embeddingModel: "voyage-4",
  rerankerModel: "rerank-2.5-lite",
  projectRefPlaceholder: "<project-ref>",
};

function opt(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim().length > 0 ? v.trim() : fallback;
}

/**
 * Resolve the app config: env overrides layered over the neutral defaults.
 * Reads only OPTIONAL env vars (no secrets) — safe to call without `run.sh`.
 */
export function loadConfig(): AppConfig {
  return {
    productName: opt("CB_PRODUCT_NAME", DEFAULT_CONFIG.productName),
    cliName: opt("CB_CLI_NAME", DEFAULT_CONFIG.cliName),
    ownerLabel: opt("CB_OWNER_LABEL", DEFAULT_CONFIG.ownerLabel),
    defaultOwner: opt("DEFAULT_OWNER", DEFAULT_CONFIG.defaultOwner),
    embeddingModel: opt("EMBEDDING_MODEL", DEFAULT_CONFIG.embeddingModel),
    rerankerModel: opt("RERANKER_MODEL", DEFAULT_CONFIG.rerankerModel),
    projectRefPlaceholder: DEFAULT_CONFIG.projectRefPlaceholder,
  };
}
