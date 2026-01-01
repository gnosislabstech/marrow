// src/analytics/distill-sample.ts — pick which chunks of a session get distilled
// into its summary (the coarse-to-fine search fix's recall-critical kernel).
//
// Short sessions distill whole. Long sessions sample EVENLY across turn_index
// (endpoints included) so mid-session work isn't lost, and ALWAYS keep any
// marker-bearing chunk (tool error / decision) — those are the high-signal turns.

export interface DistillChunk {
  turn_index: number;
  content: string;
}

export interface DistillSampleOpts {
  maxChunks?: number;
  threshold?: number;
  markerRe?: RegExp;
}

const DEFAULTS = {
  maxChunks: 12,
  threshold: 40,
  markerRe: /\[Tool error\]|\bdecided\b|\bdecision\b/i,
};

/** Select the chunks to feed the distiller (stratified + marker-preserving). */
export function selectDistillationSample(
  chunks: DistillChunk[],
  opts: DistillSampleOpts = {},
): DistillChunk[] {
  const maxChunks = opts.maxChunks ?? DEFAULTS.maxChunks;
  const threshold = opts.threshold ?? DEFAULTS.threshold;
  const markerRe = opts.markerRe ?? DEFAULTS.markerRe;

  const sorted = [...chunks].sort((a, b) => a.turn_index - b.turn_index);
  if (sorted.length <= threshold) return sorted;

  const n = sorted.length;
  const keep = new Set<number>(); // positions in `sorted`

  // Even-spaced grid across the whole session, endpoints included.
  const slots = Math.max(2, Math.min(maxChunks, n));
  for (let i = 0; i < slots; i++) {
    keep.add(Math.round((i * (n - 1)) / (slots - 1)));
  }
  // Always keep marker-bearing chunks — the high-signal turns must survive.
  for (let i = 0; i < n; i++) {
    if (markerRe.test(sorted[i].content)) keep.add(i);
  }

  return [...keep].sort((a, b) => a - b).map((i) => sorted[i]);
}
