// src/analytics/error-signature.ts — normalize a tool-error string to a stable signature.
//
// Strips the volatile parts (digits, absolute paths, quoted strings,
// UUIDs/hashes) so the same failure CLASS collapses to one signature for the
// recurring-error-signature recommender.

/**
 * Normalize a raw `[Tool error]` body to a stable failure signature.
 * Same failure class → identical signature regardless of specific values.
 */
export function normalizeErrorSignature(raw: string): string {
  return raw
    // quoted strings (single or double) → one token. Done first so a quoted
    // path/id collapses as a string, not re-split by the rules below.
    .replace(/"[^"]*"|'[^']*'/g, "<STR>")
    // UUIDs → one token (before the digit rule, which would shred them).
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<ID>")
    // long hex / hash-like ids → one token (also before the digit rule).
    .replace(/\b[0-9a-f]{16,}\b/gi, "<ID>")
    // absolute paths → one token (before the digit rule strips numeric segments).
    .replace(/\/[^\s'"]+/g, "<PATH>")
    // any remaining run of digits → one token.
    .replace(/\d+/g, "<NUM>")
    // collapse whitespace and trim.
    .replace(/\s+/g, " ")
    .trim();
}
