import { loadEnvConfig } from "@next/env";
import { afterAll, beforeAll, expect } from "vitest";

import { closePool } from "@/db/pool";
import { buildSystemPrompt, buildTimeContext } from "@/features/bot-messaging/server/prompt";
import { getToolset } from "@/features/mcp-tools/server/service";
import { getLlmRuntime, getTimezone } from "@/features/settings/server/service";
import type { ChatMessage } from "@/server/llm/client";
import { chatCompletionWithTools } from "@/server/llm/tool-loop";
import type { McpToolCallResult } from "@/server/mcp/tool-result";

/**
 * Live tool-selection harness. Drives the REAL configured LLM with the REAL
 * registered MCP tool schemas + descriptions and the production system prompt, to
 * assert that a given natural-language request makes the model call the proper
 * tool with sensible arguments.
 *
 * The point is to test *tool selection*, not tool execution: the tools are never
 * actually run. Every tool call is intercepted, recorded, and answered with a
 * canned result — so no browsing run is enqueued, no headless browser launches,
 * and no DB mutation happens. The model sees the same tool contract it sees in production
 * (schemas come straight through {@link getToolset}), so its choice is faithful.
 *
 * Canned results let multi-step flows proceed: e.g. "cancel my reminder" makes the
 * model call `tasks_list`, whose canned result carries a task id it then passes to
 * `tasks_delete`. Override any tool's result per case via `cannedResults`.
 *
 * Needs the real `DATABASE_URL` (for the DB-stored LLM connection) — the caller
 * loads `.env` and gates on `LLM_LIVE` exactly like the live-flow test.
 */

/** Realistic canned results so a chosen tool "succeeds" and the loop can continue. */
const DEFAULT_CANNED: Record<string, McpToolCallResult> = {
  // The only web tool: a background run that reports to the chat itself, so the
  // canned result carries no findings for the model to relay.
  browse_web: {
    text:
      "Browsing run started in the background. Tell the user you're on it and will report back " +
      "here with what you find. Do not make up results — the run posts them itself.",
    structuredContent: { ok: true, runId: "run_demo_1" },
  },
  history_search: {
    text: "[#42] [2026-07-01T10:00:00Z] user: I drive a blue Volvo.",
    structuredContent: { ok: true, count: 1, messages: [] },
  },
  history_get_in_range: {
    text: "[#42] [2026-07-01T10:00:00Z] user: We talked about the trip.",
    structuredContent: { ok: true, count: 1, messages: [] },
  },
  history_get_by_message_ids: {
    text: "[#500] [2026-07-01T09:00:00Z] user: The meeting is at noon on Friday.",
    structuredContent: { ok: true, count: 1, messages: [] },
  },
  // A recalled topic carrying message ids, so a "recall then read the originals"
  // two-step flow has ids to follow.
  history_recall_topics: {
    text: "[2026-06-02] The team argued about the database migration and settled on Drizzle.\n  message_ids: 311, 312",
    structuredContent: {
      ok: true,
      count: 1,
      topics: [
        {
          date: "2026-06-02",
          content: "The team argued about the database migration and settled on Drizzle.",
          message_ids: [311, 312],
        },
      ],
    },
  },
  update_user_aliases: {
    text: 'Noted "Sasha" as an alias for Alex.',
  },
  // Mirrors the real success text: the image is already delivered and the model
  // never saw it, so it must not describe the contents.
  image_generate: {
    text:
      "Generated 1 image (1024x1024) and delivered it to the chat. You have NOT seen it — " +
      "do not describe or claim anything about the contents. Just briefly acknowledge the image " +
      "in your reply.",
    structuredContent: { ok: true, count: 1, size: [1024, 1024] },
  },
  // A single existing task, so a "change/cancel my reminder" flow has an id to act on.
  tasks_list: {
    text: "task_demo_1 [every day at 09:00]: remind me to drink water",
    structuredContent: {
      ok: true,
      count: 1,
      tasks: [
        {
          id: "task_demo_1",
          instruction: "remind me to drink water",
          trigger: "schedule",
          time: "09:00",
          created_by_user_id: "100",
        },
      ],
    },
  },
  tasks_get: {
    text: "task_demo_1 [every day at 09:00]: remind me to drink water\ncontext: (none saved)",
    structuredContent: { ok: true },
  },
  tasks_create: {
    text: "Task saved for this chat (every day at 09:00): remind me to drink water",
    structuredContent: { ok: true, task: { id: "task_demo_1" } },
  },
  tasks_update: {
    text: "Task updated (every day at 09:00): remind me to drink water",
    structuredContent: { ok: true, task: { id: "task_demo_1" } },
  },
  tasks_delete: {
    text: "Task task_demo_1 deleted — it no longer applies here.",
    structuredContent: { ok: true, id: "task_demo_1" },
  },
};

/** One recorded tool call the model chose to make. */
export interface RecordedToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ToolSelectionCase {
  /** The current user message to answer — the thing under test. */
  userText: string;
  /**
   * Persona instructions composed into the system prompt exactly as in production
   * (below the base prompt, as "Additional instructions"). For cases where the
   * failure mode only appears in character — e.g. a joke-framed request the model
   * is tempted to role-play instead of act on.
   */
  personalityPrompt?: string;
  /** Extra system messages to inject after the base prompt (identity/roster context). */
  systemContext?: string[];
  /** Prior conversation turns to inject before the current message (history window). */
  priorTurns?: ChatMessage[];
  /** Per-tool canned results, merged over {@link DEFAULT_CANNED}. */
  cannedResults?: Record<string, McpToolCallResult>;
  /** Hard cap on model rounds (default 4 — enough for a list→act flow, bounds cost). */
  maxRounds?: number;
}

export interface ToolSelectionRun {
  /** Every tool call the model made, in order. */
  toolCalls: RecordedToolCall[];
  /** The tool names, in order (convenience for assertions). */
  toolNames: string[];
  /** The final reply text, or null when the loop produced none. */
  content: string | null;
  /** The error message when the loop threw (e.g. empty/stalled), else null. */
  error: string | null;
}

/**
 * Run one tool-selection case against the real LLM + real tools. Resolves the LLM
 * connection from DB settings (throws a clear error when unconfigured). Never
 * executes a real tool — records the calls and returns canned results.
 */
export async function runToolSelection(testCase: ToolSelectionCase): Promise<ToolSelectionRun> {
  const runtime = await getLlmRuntime();
  if (!runtime) {
    throw new Error(
      "LLM is not configured in DB settings — set an endpoint + model on /settings first.",
    );
  }
  const toolset = await getToolset();
  if (!toolset) throw new Error("No MCP tools are registered — cannot test tool selection.");

  const canned = { ...DEFAULT_CANNED, ...(testCase.cannedResults ?? {}) };
  const toolCalls: RecordedToolCall[] = [];

  const callTool = async (name: string, args: Record<string, unknown>): Promise<McpToolCallResult> => {
    toolCalls.push({ name, args });
    return canned[name] ?? { text: `(${name} completed)` };
  };

  // Mirror production: give the model a concrete "now" (in the operator timezone),
  // so relative/named-time requests like "remind me in 5 minutes" are resolvable.
  const timezone = await getTimezone().catch(() => "UTC");
  const timeContext = buildTimeContext(new Date(), timezone);

  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt({ personalityPrompt: testCase.personalityPrompt }) },
    ...(testCase.systemContext ?? []).map((content) => ({ role: "system" as const, content })),
    ...(testCase.priorTurns ?? []),
    { role: "system", content: timeContext },
    { role: "user", content: testCase.userText },
  ];

  let content: string | null = null;
  let error: string | null = null;
  try {
    const result = await chatCompletionWithTools(
      { baseUrl: runtime.baseUrl, apiKey: runtime.apiKey, backend: runtime.backend },
      {
        model: runtime.model,
        messages,
        tools: toolset.tools,
        callTool,
        maxRounds: testCase.maxRounds ?? 4,
      },
    );
    content = result.content;
  } catch (err) {
    // A stalled/empty loop still recorded its tool calls — the selection is what we
    // assert on, so surface the error rather than failing the harness.
    error = err instanceof Error ? err.message : String(err);
  }

  return { toolCalls, toolNames: toolCalls.map((c) => c.name), content, error };
}

/**
 * Whether the opt-in live tool-selection suites should run. Off by default so CI
 * never spends tokens or needs a live backend; gate each feature's suite with
 * `describe.skipIf(!LLM_LIVE)`.
 */
export const LLM_LIVE = process.env.LLM_LIVE === "1";

/** Generous per-case timeout: a real round-trip, possibly a list→act two-step. */
export const TOOL_SELECTION_TIMEOUT = 120_000;

/**
 * Shared lifecycle for a feature's live tool-selection suite: load `.env` (for
 * `DATABASE_URL` → the DB-stored LLM connection), fail fast if the LLM is not
 * configured, and close the pool afterward. Call inside the `describe` body.
 */
export function useLiveLlm(): void {
  beforeAll(async () => {
    loadEnvConfig(process.cwd());
    const runtime = await getLlmRuntime();
    if (!runtime) {
      throw new Error(
        "LLM is not configured in DB settings — set an endpoint + model on /settings first.",
      );
    }
  });
  afterAll(async () => {
    await closePool();
  });
}

/** Assert the model chose `tool` for this request (order-independent), with context. */
export function expectToolCalled(run: ToolSelectionRun, tool: string): void {
  expect(
    run.toolNames,
    `expected the model to call "${tool}", but it called: [${run.toolNames.join(", ")}]` +
      (run.content ? `\nreply: ${run.content}` : "") +
      (run.error ? `\nerror: ${run.error}` : ""),
  ).toContain(tool);
}

/** Assert the model did NOT choose `tool` (e.g. no browsing run for general knowledge). */
export function expectToolNotCalled(run: ToolSelectionRun, tool: string): void {
  expect(
    run.toolNames,
    `expected the model NOT to call "${tool}", but it called: [${run.toolNames.join(", ")}]`,
  ).not.toContain(tool);
}
