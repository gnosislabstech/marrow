// scripts/mcp-server.ts — MCP server exposing the corpus over stdio.
//
// Exposes the corpus to any Claude Code session via MCP stdio.
//
// Tools (3-layer pattern: compact summaries → ID lookup → full content):
//   - search_sessions    Hybrid search across CC session chunks
//   - search_memory      Hybrid search across memory_chunks (with source_type facet)
//   - search_all         Combined search across both surfaces
//   - get_session        Fetch session metadata + summary
//   - replay_session     Ordered turns around a chunk for context
//   - list_sessions      Browse sessions by date/project
//
// Wired into ~/.claude/settings.json so it's available in every Claude Code session.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import { loadEnv } from "../src/env.js";
import {
  clampInt,
  MAX_REPLAY_WINDOW,
  validateReplayArgs,
} from "../src/mcp-validate.js";
import {
  compactChunk,
  compactMemory,
  getSession,
  hybridSearchMemory,
  hybridSearchSessions,
  listSessions,
  rerankCandidates,
  replaySession,
  resolveSearchMode,
  synthesizeAnswer,
  type SearchMode,
  type SessionChunkRow,
} from "../src/search.js";

const env = loadEnv();

// ─── Tool definitions ─────────────────────────────────────────────

const TOOLS: Tool[] = [
  {
    name: "search_sessions",
    description:
      "Hybrid (semantic + lexical) search across your Claude Code session transcripts. " +
      "Returns compact chunk summaries with snippets. Use replay_session to fetch surrounding context for a hit. " +
      "Set hide_meta=true (default) to exclude chunks where the tool itself was the topic. " +
      "Set search_mode='current' (or 'auto', the default) when asking about current/recent state — " +
      "biases ranking toward newer chunks so resolutions outrank stale design-phase chatter.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language search query" },
        limit: { type: "integer", default: 10, minimum: 1, maximum: 30 },
        rerank: {
          type: "boolean",
          default: true,
          description: "Apply voyage-rerank-2.5-lite over candidates for sharper ordering",
        },
        hide_meta: {
          type: "boolean",
          default: true,
          description: "Filter out chunks flagged as tool self-references",
        },
        search_mode: {
          type: "string",
          enum: ["balanced", "current", "auto"],
          default: "auto",
          description:
            "balanced=pure RRF; current=adds recency rank dimension; auto=detect from query keywords (now/current/today/latest/status/etc).",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "search_memory",
    description:
      "Hybrid search across memory artifacts (memory files, observations, handoffs, timelines, briefings, doctrine). " +
      "Use the source_type filter to narrow to one tier. " +
      "search_mode='current' biases toward newer files (useful for 'what's the latest decision on X').",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer", default: 10, minimum: 1, maximum: 30 },
        source_type: {
          type: "string",
          enum: ["memory", "observation", "handoff", "timeline", "briefing", "doctrine"],
          description: "Optional facet — restrict to one memory tier",
        },
        rerank: { type: "boolean", default: true },
        search_mode: {
          type: "string",
          enum: ["balanced", "current", "auto"],
          default: "auto",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "search_all",
    description:
      "Combined search across both session_chunks and memory_chunks. Returns interleaved compact results, " +
      "labeled by source. Useful when you don't know which surface holds the answer.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer", default: 15, minimum: 1, maximum: 30 },
        rerank: { type: "boolean", default: true },
        search_mode: {
          type: "string",
          enum: ["balanced", "current", "auto"],
          default: "auto",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_session",
    description:
      "Fetch a single session's metadata (started/ended, message count, project path, summary, source).",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session UUID from a search result" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "replay_session",
    description:
      "Fetch ordered turns around a target chunk for replay context. " +
      "Use after search_sessions returns a hit you want to read in flow.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        around: {
          type: "integer",
          description: "Turn index to center on (from search result)",
        },
        window: {
          type: "integer",
          default: 5,
          description: "Number of turns before+after to include",
        },
      },
      required: ["session_id", "around"],
    },
  },
  {
    name: "list_sessions",
    description:
      "Browse sessions by date / project. Returns compact session metadata. " +
      "Useful for 'what was I working on last Tuesday' queries.",
    inputSchema: {
      type: "object",
      properties: {
        since: {
          type: "string",
          description: "ISO timestamp — only return sessions started after this",
        },
        project_path: {
          type: "string",
          description: "Filter to one project (e.g., '/home/<user>/<project>')",
        },
        limit: { type: "integer", default: 25, minimum: 1, maximum: 100 },
        offset: { type: "integer", default: 0 },
      },
    },
  },
  {
    name: "answer",
    description:
      "Ask a question of your Claude Code history + memory. Searches corpus, picks top-K relevant chunks, " +
      "feeds them with the question to an LLM (DeepSeek or Haiku), returns a synthesized answer with [N] " +
      "citations referencing specific chunks. Use when you want a DIRECT ANSWER rather than raw search hits. " +
      "Each citation includes session_id+turn_index (for replay_session) or source_path (for memory). " +
      "For 'current state' or 'where are we' questions, search_mode='current' (or 'auto') biases retrieval " +
      "toward newer chunks AND tells the synthesizer to prefer the newest, surface contradictions between " +
      "old design-phase chatter and newer resolutions.",
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "Natural-language question — e.g. 'how did I configure DeepSeek prompt caching?'",
        },
        sources: {
          type: "string",
          enum: ["sessions", "memory", "all"],
          default: "all",
          description: "Which surfaces to search across",
        },
        match_count: {
          type: "integer",
          default: 10,
          minimum: 3,
          maximum: 20,
          description: "How many top chunks to feed the synthesizer",
        },
        rerank: {
          type: "boolean",
          default: true,
          description:
            "Apply voyage-rerank-2.5-lite over candidates before synthesis. Auto-disabled in current mode " +
            "(reranker is recency-blind and would undo the recency bias).",
        },
        hide_meta: {
          type: "boolean",
          default: true,
          description: "Filter out tool self-reference sessions (recommended)",
        },
        search_mode: {
          type: "string",
          enum: ["balanced", "current", "auto"],
          default: "auto",
          description:
            "balanced=pure semantic/lexical RRF (best for historical queries). " +
            "current=adds recency rank dimension + synthesis prompt biased toward newest chunks. " +
            "auto=detect from query keywords (now/current/today/latest/status/where are we/etc).",
        },
      },
      required: ["question"],
    },
  },
];

// ─── Handlers ─────────────────────────────────────────────────────

const server = new Server(
  { name: env.cliName, version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, unknown>;

  try {
    switch (name) {
      case "search_sessions": {
        const query = String(a.query);
        const limit = clampInt(a.limit, 1, 100, "limit", 10);
        const rerank = a.rerank !== false;
        const hideMeta = a.hide_meta !== false;
        const searchMode = (a.search_mode as SearchMode | undefined) ?? "auto";
        const resolvedMode = resolveSearchMode(searchMode, query);

        // Fetch 2x candidates if reranking, so rerank has room to reorder
        const fetchLimit = rerank ? Math.min(limit * 2, 30) : limit;
        let rows = await hybridSearchSessions(env, query, {
          matchCount: fetchLimit,
          searchMode: resolvedMode,
        });

        if (hideMeta) {
          rows = rows.filter((r: SessionChunkRow) => {
            const m = r.metadata as { is_meta_file?: boolean; is_meta_message?: boolean };
            return !(m.is_meta_file || m.is_meta_message);
          });
        }

        let final = rows;
        // Skip rerank in current mode (reranker is recency-blind, would undo bias)
        if (rerank && rows.length > 1 && resolvedMode !== "current") {
          const ranked = await rerankCandidates(
            env,
            query,
            rows.map((r) => r.content),
            limit,
          );
          final = ranked.map((r) => rows[r.index]);
        }

        const compact = final.slice(0, limit).map(compactChunk);
        return {
          content: [{ type: "text", text: JSON.stringify({ search_mode: resolvedMode, hits: compact }, null, 2) }],
        };
      }

      case "search_memory": {
        const query = String(a.query);
        const limit = clampInt(a.limit, 1, 100, "limit", 10);
        const rerank = a.rerank !== false;
        const sourceType = a.source_type as
          | "memory"
          | "observation"
          | "handoff"
          | "timeline"
          | "briefing"
          | "doctrine"
          | undefined;
        const searchMode = (a.search_mode as SearchMode | undefined) ?? "auto";
        const resolvedMode = resolveSearchMode(searchMode, query);

        const fetchLimit = rerank ? Math.min(limit * 2, 30) : limit;
        const rows = await hybridSearchMemory(env, query, {
          matchCount: fetchLimit,
          sourceTypeFilter: sourceType,
          searchMode: resolvedMode,
        });

        let final = rows;
        if (rerank && rows.length > 1 && resolvedMode !== "current") {
          const ranked = await rerankCandidates(
            env,
            query,
            rows.map((r) => r.content),
            limit,
          );
          final = ranked.map((r) => rows[r.index]);
        }

        const compact = final.slice(0, limit).map(compactMemory);
        return {
          content: [{ type: "text", text: JSON.stringify({ search_mode: resolvedMode, hits: compact }, null, 2) }],
        };
      }

      case "search_all": {
        const query = String(a.query);
        const limit = clampInt(a.limit, 1, 100, "limit", 15);
        const rerank = a.rerank !== false;
        const searchMode = (a.search_mode as SearchMode | undefined) ?? "auto";
        const resolvedMode = resolveSearchMode(searchMode, query);

        // Fetch from both surfaces in parallel
        const halfLimit = Math.ceil(limit / 2);
        const fetchLimit = rerank ? Math.min(halfLimit * 2, 30) : halfLimit;
        const [sessionRows, memoryRows] = await Promise.all([
          hybridSearchSessions(env, query, { matchCount: fetchLimit, searchMode: resolvedMode }),
          hybridSearchMemory(env, query, { matchCount: fetchLimit, searchMode: resolvedMode }),
        ]);

        // Tag and combine
        const tagged = [
          ...sessionRows.map((r) => ({ kind: "session" as const, row: r })),
          ...memoryRows.map((r) => ({ kind: "memory" as const, row: r })),
        ];

        let final = tagged;
        if (rerank && tagged.length > 1 && resolvedMode !== "current") {
          const ranked = await rerankCandidates(
            env,
            query,
            tagged.map((t) => t.row.content),
            limit,
          );
          final = ranked.map((r) => tagged[r.index]);
        }

        const compact = final.slice(0, limit).map((t) =>
          t.kind === "session"
            ? { kind: "session", ...compactChunk(t.row as SessionChunkRow) }
            : { kind: "memory", ...compactMemory(t.row as never) },
        );
        return {
          content: [{ type: "text", text: JSON.stringify({ search_mode: resolvedMode, hits: compact }, null, 2) }],
        };
      }

      case "get_session": {
        const sessionId = String(a.session_id);
        const session = await getSession(env, sessionId);
        if (!session) {
          return {
            content: [{ type: "text", text: `No session found: ${sessionId}` }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify(session, null, 2) }],
        };
      }

      case "replay_session": {
        const sessionId = String(a.session_id);
        const { around, window } = validateReplayArgs(a);
        const turns = await replaySession(
          env, sessionId, around, Math.min(window, MAX_REPLAY_WINDOW),
        );
        return {
          content: [{ type: "text", text: JSON.stringify(turns, null, 2) }],
        };
      }

      case "list_sessions": {
        const sessions = await listSessions(env, {
          since: a.since as string | undefined,
          projectPath: a.project_path as string | undefined,
          limit: clampInt(a.limit, 1, 100, "limit", 25),
          offset: clampInt(a.offset, 0, 1_000_000, "offset", 0),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(sessions, null, 2) }],
        };
      }

      case "answer": {
        const question = String(a.question);
        const sources = (a.sources as "sessions" | "memory" | "all" | undefined) ?? "all";
        const matchCount = clampInt(a.match_count, 1, 50, "match_count", 10);
        const rerank = a.rerank !== false;
        const hideMeta = a.hide_meta !== false;
        const searchMode = (a.search_mode as SearchMode | undefined) ?? "auto";

        const result = await synthesizeAnswer(env, question, {
          sources,
          matchCount,
          rerank,
          hideMeta,
          searchMode,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Full detail stays server-side: upstream (PostgREST/provider) error
    // bodies can carry internal schema/SQLSTATE detail that MCP clients —
    // potentially prompt-injected agents — should not receive verbatim.
    console.error(`[${env.productName}] tool ${name} failed: ${msg}`);
    return {
      content: [
        { type: "text", text: `Error: ${name} failed — detail logged on the server.` },
      ],
      isError: true,
    };
  }
});

// ─── Boot ─────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[${env.productName}] MCP server listening on stdio`);
