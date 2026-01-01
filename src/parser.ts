// src/parser.ts — Claude Code JSONL → typed discriminated unions.
//
// Schema ported from daaain/claude-code-log models.py — the cleanest
// map of CC's JSONL format in the wild. Streaming via Node createInterface
// for OOM-safe processing of any session size.

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

// ─── Content blocks (inside message.content arrays) ────────────────

export interface TextContent {
  type: "text";
  text: string;
}

export interface ToolUseContent {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultContent {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<{ type: string; text?: string }>;
  is_error?: boolean;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  signature?: string;
}

export interface ImageContent {
  type: "image";
  source: {
    type: "base64" | "url";
    media_type?: string;
    data?: string;
    url?: string;
  };
}

export type ContentBlock =
  | TextContent
  | ToolUseContent
  | ToolResultContent
  | ThinkingContent
  | ImageContent;

// ─── Message wrappers ──────────────────────────────────────────────

export interface UserMessage {
  role: "user";
  content: string | ContentBlock[];
}

export interface AssistantMessage {
  role: "assistant";
  content: ContentBlock[];
  id?: string;
  model?: string;
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

// ─── Top-level transcript entries (one per JSONL line) ────────────

interface BaseEntry {
  uuid: string;
  parentUuid?: string | null;
  logicalParentUuid?: string | null;
  timestamp: string;
  sessionId?: string | null;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  isSidechain?: boolean;
  userType?: string;
  isMeta?: boolean;
  forkedFrom?: string;
}

export interface UserTranscriptEntry extends BaseEntry {
  type: "user";
  message: UserMessage;
  toolUseResult?: unknown; // tool result attached on the next user turn
  sourceToolUseID?: string; // links to the tool_use id in prior assistant
  isCompactSummary?: boolean; // user-typed compaction summary
}

export interface AssistantTranscriptEntry extends BaseEntry {
  type: "assistant";
  message: AssistantMessage;
  requestId?: string;
}

export interface SummaryTranscriptEntry extends BaseEntry {
  type: "summary";
  summary: string;
  leafUuid?: string;
  sessionId: null; // summaries never carry sessionId
}

export interface AiTitleTranscriptEntry extends BaseEntry {
  type: "ai-title";
  aiTitle: string;
}

export interface SystemTranscriptEntry extends BaseEntry {
  type: "system";
  subtype?: string;
  level?: string;
  content?: unknown;
  hasOutput?: boolean;
  hookErrors?: unknown;
  hookInfos?: unknown;
  preventedContinuation?: boolean;
  compactMetadata?: unknown;
}

export interface QueueOperationTranscriptEntry extends BaseEntry {
  type: "queue-operation";
  subtype?: string;
}

export interface AttachmentTranscriptEntry extends BaseEntry {
  type: "attachment";
  subtype?: string;
  content?: unknown;
}

export interface PassthroughTranscriptEntry extends BaseEntry {
  type: string;
  [key: string]: unknown;
}

export type TranscriptEntry =
  | UserTranscriptEntry
  | AssistantTranscriptEntry
  | SummaryTranscriptEntry
  | AiTitleTranscriptEntry
  | SystemTranscriptEntry
  | QueueOperationTranscriptEntry
  | AttachmentTranscriptEntry
  | PassthroughTranscriptEntry;

// ─── Format normalization (legacy → modern) ───────────────────────
//
// Legacy CC format (early 2026 archives) wraps everything
// in `type: "message"` with role nested in `message.role`, and uses `id`/`parentId`
// instead of `uuid`/`parentUuid`.
//
// Modern format (current) puts role at top-level type.
//
// We normalize legacy → modern on parse so downstream code never branches.

interface LegacyMessageEnvelope {
  type: "message";
  id?: string;
  parentId?: string;
  timestamp: string;
  message?: { role?: string; content?: unknown; timestamp?: string };
  [key: string]: unknown;
}

function isLegacyMessageEnvelope(raw: unknown): raw is LegacyMessageEnvelope {
  if (!raw || typeof raw !== "object") return false;
  const r = raw as Record<string, unknown>;
  if (r.type !== "message") return false;
  const m = r.message as { role?: unknown } | undefined;
  return !!m && typeof m === "object" && typeof m.role === "string";
}

function normalizeEntry(raw: unknown): TranscriptEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.type !== "string") return null;

  if (isLegacyMessageEnvelope(raw)) {
    // Rewrite legacy → modern shape so downstream code is uniform
    const role = (raw.message as { role: string }).role;
    return {
      ...raw,
      type: role,
      uuid: (r.uuid as string | undefined) ?? (r.id as string | undefined) ?? "",
      parentUuid:
        (r.parentUuid as string | undefined) ??
        (r.parentId as string | undefined) ??
        null,
    } as unknown as TranscriptEntry;
  }

  return raw as TranscriptEntry;
}

// ─── Parser ───────────────────────────────────────────────────────

/**
 * Stream-parse a Claude Code JSONL file.
 *
 * Yields one TranscriptEntry per non-empty line. Malformed lines are
 * skipped silently (unless an onMalformed callback is provided).
 * Memory-safe for any file size — uses readline + readstream, never
 * loads the whole file.
 *
 * Legacy CC format (events of `type: "message"` with role nested) is
 * normalized to modern shape transparently — downstream code never
 * has to branch on format era.
 */
/**
 * Hard cap on a single JSONL line length. Lines beyond this are degenerate
 * tool_result dumps (file contents, web fetch output, etc.) that V8's JSON
 * parser + downstream string ops can choke on, and that aren't useful for
 * retrieval anyway. Logged + skipped.
 */
const MAX_LINE_BYTES = 2_000_000;

export async function* parseJsonlFile(
  filePath: string,
  onMalformed?: (line: string, err: Error) => void,
): AsyncGenerator<TranscriptEntry, void, unknown> {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  let lineNum = 0;
  for await (const line of rl) {
    lineNum++;
    if (!line.trim()) continue;

    // Pathologically long line — skip with warning rather than risk JSON.parse OOM
    if (line.length > MAX_LINE_BYTES) {
      console.warn(
        `[parser] ${filePath}:${lineNum} skipping ${(line.length / 1_000_000).toFixed(1)}MB line (>${MAX_LINE_BYTES / 1_000_000}MB cap)`,
      );
      continue;
    }

    try {
      const entry = normalizeEntry(JSON.parse(line));
      if (!entry || typeof entry.type !== "string") continue;
      yield entry;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      if (onMalformed) {
        onMalformed(line, e);
      } else {
        // Log the error class for diagnostics — silent skip hides systemic issues
        console.warn(
          `[parser] ${filePath}:${lineNum} parse failed (${e.name}): ${e.message.slice(0, 100)}`,
        );
      }
    }
  }
}

/** Buffered parse — returns full array. Use only when total memory is bounded. */
export async function parseJsonlFileToArray(filePath: string): Promise<TranscriptEntry[]> {
  const out: TranscriptEntry[] = [];
  for await (const entry of parseJsonlFile(filePath)) {
    out.push(entry);
  }
  return out;
}

// ─── Type guards (handy for downstream consumers) ─────────────────

export function isUser(e: TranscriptEntry): e is UserTranscriptEntry {
  return e.type === "user";
}
export function isAssistant(e: TranscriptEntry): e is AssistantTranscriptEntry {
  return e.type === "assistant";
}
export function isSummary(e: TranscriptEntry): e is SummaryTranscriptEntry {
  return e.type === "summary";
}
export function isAiTitle(e: TranscriptEntry): e is AiTitleTranscriptEntry {
  return e.type === "ai-title";
}
export function isSystem(e: TranscriptEntry): e is SystemTranscriptEntry {
  return e.type === "system";
}
export function isAttachment(e: TranscriptEntry): e is AttachmentTranscriptEntry {
  return e.type === "attachment";
}

/** Should this entry be embedded as content (vs. metadata-only or skip)? */
export function isContentBearing(
  e: TranscriptEntry,
): e is UserTranscriptEntry | AssistantTranscriptEntry | SummaryTranscriptEntry {
  return isUser(e) || isAssistant(e) || isSummary(e);
}
