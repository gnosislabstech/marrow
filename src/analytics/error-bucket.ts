// src/analytics/error-bucket.ts — assign a normalized error signature to a seed bucket.
//
// STUB: everything UNMATCHED. The implementation matches a normalized signature
// against the seed patterns (case-insensitive substring) and returns the seed
// key, or the UNMATCHED sentinel (the first-class "new failure class" pile).

export const UNMATCHED = "UNMATCHED";

/** seedKey → list of substring patterns that indicate that failure class. */
export type SeedMap = Record<string, string[]>;

/**
 * Return the seed key whose pattern the signature matches, else UNMATCHED.
 * First matching seed (object insertion order) wins.
 */
export function bucketSignature(normalized: string, seeds: SeedMap): string {
  const haystack = normalized.toLowerCase();
  for (const [key, patterns] of Object.entries(seeds)) {
    if (patterns.some((p) => haystack.includes(p.toLowerCase()))) {
      return key;
    }
  }
  return UNMATCHED;
}
