// src/mcp-validate.ts — input validation for MCP tool args.
//
// Rejects non-integer / negative / missing numeric args BEFORE they reach
// PostgREST (the replay_session NaN bug: `Number(undefined)` → NaN →
// `turn_index=gte.NaN` → 22P02 server-side), and clamps bounded knobs so the
// MCP SDK's unenforced schema maximums can't be abused for cost amplification.

export interface ReplayArgs {
  around: number;
  window: number;
}

/** replay_session `window` is capped — an unbounded window dumps whole sessions. */
export const MAX_REPLAY_WINDOW = 50;

/**
 * Validate + coerce replay_session args. Throws a clear Error if `around` is
 * not a finite non-negative integer. `window` defaults to 5 and must also be a
 * finite non-negative integer when provided.
 */
export function validateReplayArgs(args: { around?: unknown; window?: unknown }): ReplayArgs {
  const around = requireNonNegativeInt(args.around, "around");
  const window = args.window === undefined ? 5 : requireNonNegativeInt(args.window, "window");
  return { around, window };
}

/**
 * Coerce a numeric MCP arg to an integer in [min, max]. `undefined` yields
 * `fallback`; non-finite values (NaN, Infinity, junk strings) throw — a bad
 * arg must fail loudly here, not as a PostgREST 400 echoed to the client.
 */
export function clampInt(
  value: unknown,
  min: number,
  max: number,
  name: string,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`\`${name}\` must be a finite number, got ${String(value)}`);
  }
  return Math.min(Math.max(Math.trunc(n), min), max);
}

/**
 * Coerce `value` to a finite non-negative integer or throw. Guards the
 * replay_session path so a bad arg fails loudly here instead of as a
 * `turn_index=gte.NaN` → 22P02 from PostgREST.
 */
function requireNonNegativeInt(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`replay_session: \`${name}\` must be a finite number, got ${String(value)}`);
  }
  if (!Number.isInteger(value)) {
    throw new Error(`replay_session: \`${name}\` must be an integer, got ${value}`);
  }
  if (value < 0) {
    throw new Error(`replay_session: \`${name}\` must be non-negative, got ${value}`);
  }
  return value;
}
