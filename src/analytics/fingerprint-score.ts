// src/analytics/fingerprint-score.ts — operator-profile ranking score.
//
// Computes the auditable ranking score
// frequency_norm × fixability × recency_factor that orders failure signatures
// for the "do these 3 things this month" capstone.

export interface FingerprintInput {
  affectedSessions: number;
  totalSessions: number;
  /** 1.0 = has an authored remedy, 0.5 = unmatched-but-clustered, 0.0 = excluded class. */
  fixability: number;
  daysSinceLast: number;
  /** monthly trend slope, already normalized to roughly [0,1]. */
  monthlySlope: number;
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** score = frequency_norm × fixability × recency_factor (all defined in the item). */
export function scoreFingerprint(input: FingerprintInput): number {
  const { affectedSessions, totalSessions, fixability, daysSinceLast, monthlySlope } = input;
  const frequency_norm = totalSessions > 0 ? affectedSessions / totalSessions : 0;
  const recency_factor = 0.6 * Math.exp(-daysSinceLast / 30) + 0.4 * clamp01(monthlySlope);
  return frequency_norm * fixability * recency_factor;
}
