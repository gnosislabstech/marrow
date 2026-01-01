// src/windowing.ts — Group transcript turns into embedding-target windows.
//
// Strategy (from 2026 best-practice research for conversational data):
//   - 3-8 consecutive turns per window
//   - Hard char cap ~3200 (~800 tokens at the default embedding model)
//   - 1 turn overlap between windows
//   - If a single turn exceeds the cap, sub-chunk via semantic boundaries
//
// One row per window. Windows record turn_index_start..turn_index_end for
// replay. Sub-chunks share their parent_turn_index for grouping.

import type {
  AssistantTranscriptEntry,
  ContentBlock,
  TranscriptEntry,
} from "./parser.js";
import { isContentBearing } from "./parser.js";
import { projectEntry } from "./projection.js";

/**
 * Lightweight per-turn record. Carries only what windowing + chunk-row-building
 * needs — does NOT retain the full entry, so we can stream millions of turns
 * without holding their nested content trees in memory.
 */
export interface ProjectedTurn {
  text: string;
  turn_index: number;
  role: "user" | "assistant" | "compaction";
  occurredAt: string | null;
  toolsCalled: string[]; // pre-extracted from assistant tool_use blocks
  isMetaMessage: boolean;
}

export interface TurnWindow {
  text: string; // joined embed-ready text of all turns in window
  startIndex: number;
  endIndex: number;
  turns: ProjectedTurn[];
  isSubChunk?: boolean; // true if this window came from sub-chunking one huge turn
  parentIndex?: number; // for sub-chunks, the source turn index
}

export interface WindowingOptions {
  minTurns: number;
  maxTurns: number;
  charCap: number;
  overlapTurns: number;
}

const DEFAULT_OPTIONS: WindowingOptions = {
  minTurns: 3,
  maxTurns: 8,
  charCap: 3200,
  overlapTurns: 1,
};

/** Extract tool names called by an assistant entry's content array. */
function extractToolsCalled(entry: TranscriptEntry): string[] {
  if (entry.type !== "assistant") return [];
  const blocks = ((entry as AssistantTranscriptEntry).message?.content ??
    []) as ContentBlock[];
  const out: string[] = [];
  for (const b of blocks) {
    if (b.type === "tool_use") out.push((b as { name: string }).name);
  }
  return out;
}

/** Convert a parsed entry into a lightweight ProjectedTurn (or null to skip). */
export function entryToTurn(
  entry: TranscriptEntry,
  turnIndex: number,
  isMetaMessage: boolean,
): ProjectedTurn | null {
  if (!isContentBearing(entry)) return null;
  const text = projectEntry(entry);
  if (!text || text.length === 0) return null;

  const role: "user" | "assistant" | "compaction" =
    entry.type === "summary"
      ? "compaction"
      : entry.type === "user"
        ? "user"
        : "assistant";

  return {
    text,
    turn_index: turnIndex,
    role,
    occurredAt: typeof entry.timestamp === "string" ? entry.timestamp : null,
    toolsCalled: extractToolsCalled(entry),
    isMetaMessage,
  };
}

/**
 * Project + filter transcript entries into a flat ProjectedTurn list.
 * Skips non-content-bearing entries (system, attachment, queue-operation).
 * Skips empty projections. NOTE: drops the entry reference — only the
 * minimal projected data is retained.
 */
export function projectTurns(entries: TranscriptEntry[]): ProjectedTurn[] {
  const turns: ProjectedTurn[] = [];
  let idx = 0;
  for (const entry of entries) {
    const turn = entryToTurn(entry, idx, false);
    if (turn) {
      turns.push(turn);
      idx++;
    }
  }
  return turns;
}

/**
 * Sub-chunk a single huge turn at semantic boundaries.
 * Prefer paragraph breaks (\n\n), fall back to single newlines,
 * fall back to hard cuts.
 */
function subChunkText(text: string, charCap: number, overlap = 200): string[] {
  if (text.length <= charCap) return [text];

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + charCap, text.length);

    if (end < text.length) {
      const lastPara = text.lastIndexOf("\n\n", end);
      if (lastPara > start + charCap * 0.5) {
        end = lastPara + 2;
      } else {
        const lastNl = text.lastIndexOf("\n", end);
        if (lastNl > start + charCap * 0.5) {
          end = lastNl + 1;
        }
      }
    }

    chunks.push(text.slice(start, end));

    // Hit the end of input — done. (This MUST come before the start-advance,
    // otherwise the overlap-rewind keeps us looping at the tail forever.)
    if (end >= text.length) break;

    // Advance start with overlap, but guard against zero/backwards progress
    const nextStart = end - overlap;
    start = nextStart > start ? nextStart : end;
  }
  return chunks;
}

/**
 * Group projected turns into windows.
 *   - 3-8 consecutive turns per window
 *   - ~3200 char cap (~800 tokens)
 *   - 1-turn overlap between successive windows
 *   - Single turn exceeding cap → sub-chunked into multiple windows,
 *     each marked isSubChunk=true with parentIndex set
 */
export function groupTurnsIntoWindows(
  turns: ProjectedTurn[],
  opts: Partial<WindowingOptions> = {},
): TurnWindow[] {
  const o = { ...DEFAULT_OPTIONS, ...opts };
  const windows: TurnWindow[] = [];

  let i = 0;
  while (i < turns.length) {
    const turn = turns[i];

    // Single oversized turn → sub-chunk it
    if (turn.text.length > o.charCap) {
      const subChunks = subChunkText(turn.text, o.charCap);
      for (const sub of subChunks) {
        windows.push({
          text: sub,
          startIndex: turn.turn_index,
          endIndex: turn.turn_index,
          turns: [turn],
          isSubChunk: true,
          parentIndex: turn.turn_index,
        });
      }
      i++;
      continue;
    }

    // Group 3-8 normal turns until char cap or maxTurns
    const window: ProjectedTurn[] = [];
    let charCount = 0;
    let j = i;
    while (j < turns.length && window.length < o.maxTurns) {
      const next = turns[j];
      const sep = window.length > 0 ? 2 : 0; // "\n\n" between turns
      // Stop if adding next would blow the cap AND we have minimum turns
      if (
        charCount + sep + next.text.length > o.charCap &&
        window.length >= o.minTurns
      ) {
        break;
      }
      // Don't fold an oversized turn into a multi-turn window — handle separately
      if (next.text.length > o.charCap && window.length > 0) break;

      window.push(next);
      charCount += sep + next.text.length;
      j++;
    }

    if (window.length === 0) {
      i++;
      continue;
    }

    windows.push({
      text: window.map((t) => t.text).join("\n\n"),
      startIndex: window[0].turn_index,
      endIndex: window[window.length - 1].turn_index,
      turns: window,
    });

    // Advance with overlap
    i = Math.max(i + 1, j - o.overlapTurns);
  }

  return windows;
}
