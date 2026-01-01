// src/projection.ts — TranscriptEntry → embedding-ready text.
//
// Patterns adopted:
//   - tool_use one-liners from lee-fuhr/claude-session-index (verbatim)
//   - keep `thinking` blocks (reasoning is gold for retrieval) — corrects
//     the akatz/cc-conversation-search anti-pattern of dropping them
//   - tool_result first ~200 chars (preserves substance, caps noise)

import type {
  AssistantTranscriptEntry,
  ContentBlock,
  SummaryTranscriptEntry,
  TextContent,
  ThinkingContent,
  ToolResultContent,
  ToolUseContent,
  UserTranscriptEntry,
} from "./parser.js";

const TOOL_RESULT_TRUNCATE = 200;

/**
 * Project a tool_use into a single readable line.
 * Adopted verbatim from lee-fuhr/claude-session-index/analyzer.py.
 *
 * Truncation chars (40/60) matter — they keep tool noise from drowning
 * real signal in the embedding text.
 */
export function toolUseToOneLiner(
  name: string,
  input: Record<string, unknown>,
): string {
  const get = (k: string): string => String(input[k] ?? "?");

  switch (name) {
    case "Read":
      return `[Read: ${get("file_path")}]`;
    case "Edit": {
      const fp = get("file_path");
      const old = String(input.old_string ?? "").slice(0, 40);
      return `[Edit: ${fp} (${old}...)]`;
    }
    case "Write":
      return `[Write: ${get("file_path")}]`;
    case "Bash": {
      const cmd = String(input.command ?? "").slice(0, 60);
      return `[Bash: ${cmd}]`;
    }
    case "Task": {
      const desc = String(input.description ?? "").slice(0, 50);
      const atype = String(input.subagent_type ?? "general-purpose");
      return `[Task: "${desc}" → ${atype}]`;
    }
    case "Grep":
      return `[Grep: ${get("pattern")}]`;
    case "Glob":
      return `[Glob: ${get("pattern")}]`;
    case "WebFetch": {
      const url = String(input.url ?? "?").slice(0, 60);
      return `[WebFetch: ${url}]`;
    }
    case "WebSearch":
      return `[WebSearch: ${get("query")}]`;
    case "TodoWrite":
      return `[TodoWrite]`;
    default:
      return `[${name}]`;
  }
}

/**
 * Project a single content block to embedding text.
 * Returns null for blocks we choose not to embed (image content for v0.1).
 */
function projectContentBlock(block: ContentBlock): string | null {
  switch (block.type) {
    case "text":
      return (block as TextContent).text;
    case "thinking":
      return `[thinking] ${(block as ThinkingContent).thinking}`;
    case "tool_use": {
      const tu = block as ToolUseContent;
      return toolUseToOneLiner(tu.name, tu.input);
    }
    case "tool_result": {
      const tr = block as ToolResultContent;
      const errPrefix = tr.is_error ? "[Tool error] " : "[Tool result] ";
      let body = "";
      if (typeof tr.content === "string") {
        body = tr.content;
      } else if (Array.isArray(tr.content)) {
        body = tr.content
          .map((c) => (c.type === "text" && c.text ? c.text : ""))
          .filter(Boolean)
          .join("\n");
      }
      return errPrefix + body.slice(0, TOOL_RESULT_TRUNCATE);
    }
    case "image":
      // Skip images for v0.1 (no multimodal embeddings)
      return null;
    default:
      return null;
  }
}

/** Project an assistant message's full content array to embedding text. */
export function projectAssistantMessage(
  entry: AssistantTranscriptEntry,
): string {
  const blocks = entry.message.content ?? [];
  return blocks
    .map(projectContentBlock)
    .filter((s): s is string => s !== null && s.length > 0)
    .join("\n");
}

/** Project a user message — handles both string content and array (for tool_result). */
export function projectUserMessage(entry: UserTranscriptEntry): string {
  const content = entry.message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map(projectContentBlock)
      .filter((s): s is string => s !== null && s.length > 0)
      .join("\n");
  }
  return "";
}

/** Project a summary entry. */
export function projectSummary(entry: SummaryTranscriptEntry): string {
  return `[Compaction Summary] ${entry.summary}`;
}

/**
 * Generic dispatcher — project any content-bearing entry to text.
 * Returns empty string for entries that shouldn't be embedded.
 */
export function projectEntry(
  entry:
    | UserTranscriptEntry
    | AssistantTranscriptEntry
    | SummaryTranscriptEntry,
): string {
  if (entry.type === "user") return projectUserMessage(entry);
  if (entry.type === "assistant") return projectAssistantMessage(entry);
  if (entry.type === "summary") return projectSummary(entry);
  return "";
}

/**
 * Derive the role label we'll store on a chunk row.
 * Maps entry type → DB `role` column value.
 */
export function entryRole(
  entry:
    | UserTranscriptEntry
    | AssistantTranscriptEntry
    | SummaryTranscriptEntry,
): "user" | "assistant" | "compaction" {
  if (entry.type === "summary") return "compaction";
  return entry.type;
}
