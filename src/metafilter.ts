// src/metafilter.ts — Detect meta-conversations (sessions about this index itself).
//
// Two layers, adopted from akatz/cc-conversation-search:
//   1. File-level: skip whole JSONL files where this product was the topic OR
//      where its MCP tools were called heavily (auto-summarizers, sessions
//      explicitly testing the index itself)
//   2. Message-level: flag (don't drop) messages where its tools were called
//      incidentally, so they can be filtered at query time
//
// Filter at QUERY time, not ingest time. Preserves data; allows opt-in.
// "Meta" topic markers derive from the configured product name (src/config.ts).

import type {
  AssistantTranscriptEntry,
  TranscriptEntry,
  UserTranscriptEntry,
} from "./parser.js";
import { isAssistant, isUser } from "./parser.js";
import { projectAssistantMessage, projectUserMessage } from "./projection.js";
import { loadConfig } from "./config.js";

const cfg = loadConfig();
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The engine's own MCP tool names (generic; kept in sync with scripts/mcp-server.ts).
const OWN_TOOL_NAMES = new Set([
  "search_sessions",
  "search_memory",
  "search_all",
  "get_session",
  "replay_session",
  "list_sessions",
]);

// MCP tool names appear as `mcp__<server>__<tool>` once registered. Match a bare
// tool name, or a server-prefixed form whose server mentions the product name.
const SERVER_NAME_RE = new RegExp(escapeRe(cfg.productName), "i");
function isOwnToolName(name: string): boolean {
  if (OWN_TOOL_NAMES.has(name)) return true;
  if (name.startsWith("mcp__") && SERVER_NAME_RE.test(name)) return true;
  return false;
}

// Topic markers indicating a session is *about* this product itself — derived from
// the configured product name. Conservative; a distinctive product name works best.
const META_TOPIC_PATTERNS: RegExp[] = [
  new RegExp(`\\b${escapeRe(cfg.productName)}\\b`, "i"),
];

function textHasMetaTopic(text: string): boolean {
  return META_TOPIC_PATTERNS.some((p) => p.test(text));
}

/** Does this assistant message use one of the engine's own MCP tools? */
export function messageUsesOwnTool(entry: TranscriptEntry): boolean {
  if (!isAssistant(entry)) return false;
  const blocks = (entry as AssistantTranscriptEntry).message.content ?? [];
  for (const block of blocks) {
    if (block.type === "tool_use" && isOwnToolName(block.name)) {
      return true;
    }
  }
  return false;
}

interface FileMetaStats {
  toolCallCount: number;
  userMsgCount: number;
  userMsgWithMetaTopic: number;
}

function collectMetaStats(entries: TranscriptEntry[]): FileMetaStats {
  let toolCallCount = 0;
  let userMsgCount = 0;
  let userMsgWithMetaTopic = 0;

  for (const entry of entries) {
    if (messageUsesOwnTool(entry)) {
      toolCallCount++;
    }
    if (isUser(entry)) {
      userMsgCount++;
      const text = projectUserMessage(entry as UserTranscriptEntry);
      if (textHasMetaTopic(text)) userMsgWithMetaTopic++;
    }
  }

  return { toolCallCount, userMsgCount, userMsgWithMetaTopic };
}

/**
 * File-level meta-conversation check.
 *
 * Heuristic:
 *   - >= 3 of the engine's own tool calls anywhere in the session → meta
 *   - >= 50% of user messages reference this product by name (min 5 user msgs) → meta
 *   - A session that discusses the product extensively WILL be flagged as meta
 *     when ingested. That's correct behavior.
 */
export function isMetaConversationFile(entries: TranscriptEntry[]): boolean {
  const stats = collectMetaStats(entries);

  if (stats.toolCallCount >= 3) return true;

  if (
    stats.userMsgCount >= 5 &&
    stats.userMsgWithMetaTopic / stats.userMsgCount >= 0.5
  ) {
    return true;
  }

  return false;
}

/**
 * Message-level meta flag — NOT a filter, just metadata.
 * Sets metadata.is_meta = true on rows where the engine was used or mentioned.
 * Allows query-time filtering ("hide meta") or opt-in ("show only meta").
 */
export function isMetaConversationMessage(entry: TranscriptEntry): boolean {
  if (messageUsesOwnTool(entry)) return true;
  if (isUser(entry)) {
    const text = projectUserMessage(entry as UserTranscriptEntry);
    if (textHasMetaTopic(text)) return true;
  }
  if (isAssistant(entry)) {
    const text = projectAssistantMessage(entry as AssistantTranscriptEntry);
    if (textHasMetaTopic(text)) return true;
  }
  return false;
}
