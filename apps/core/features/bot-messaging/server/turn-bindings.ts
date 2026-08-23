import "server-only";

import type { BotPolicy } from "@/features/settings/server/service";
import { getClassifierRuntime, getLlmRuntime } from "@/features/settings/server/service";
import {
  buildTaskTriggerDirective,
  resolveTaskAuthority,
} from "@/features/tasks/format";
import {
  buildTaskMatchMessages,
  parseTaskMatchVerdict,
} from "@/features/tasks/server/matcher";
import type { Task } from "@/features/tasks/types";
import { recordTaskDeliveries } from "@/features/tasks/server/service";
import { getUserLabels } from "@/features/known-users/server/service";
import { getToolset } from "@/features/mcp-tools/server/service";
import { extractMessageUrls } from "@/features/browser-agent/urls";
import { ApiError } from "@/lib/api-error";
import { FEATURES } from "@/lib/features";
import { runClassifier, type ClassifierBudget } from "@/server/llm/classifier";
import {
  chatCompletion,
  REPLY_CHAT_COMPLETION_TIMEOUT_MS,
  type ChatMessage,
  type LlmCallTrace,
} from "@/server/llm/client";
import { chatCompletionWithTools } from "@/server/llm/tool-loop";
import { runWithToolContext } from "@/server/mcp/context";

import type { BotMessagingDeps } from "./service";

/**
 * The `generateReply` and `applyStandingTasks` collaborators, extracted from
 * the telegram runtime's dep-builder (`server/telegram/process-update.ts`)
 * so the queue-consumer path (redesign Phase 2) runs the exact same
 * implementation — the tool loop, the tool-context binding, the standing-task
 * match, and the authority/opened-turn state the two share. Callers differ
 * only in what they inject: how a task-opened turn's message is delivered,
 * and (consumer only) the actions-started hook that runs before any tool.
 *
 * See the v1 dep-builder for the full reasoning behind each block — the
 * comments there are the source of truth and were moved here with the code.
 */

/**
 * Hard stop on tokens generated per reply round (thinking included). A guard
 * against runaway generation, not a style guide. Sized well above the largest
 * completions observed on the live bot (user decision, 2026-08-01).
 */
const REPLY_MAX_TOKENS = 4_096;

/**
 * One per-message classification on the **classifier role** — the addressing
 * analyzer, its verifier, the honesty gate, and the standing-rule match. The
 * runtime is read per call, so a role change applies without a restart; the
 * role falls back to the chat backend/model when unconfigured.
 */
export async function runTurnClassifier(
  messages: ChatMessage[],
  budget?: ClassifierBudget,
  trace?: LlmCallTrace,
) {
  const runtime = await getClassifierRuntime();
  if (!runtime) {
    throw ApiError.serviceUnavailable(
      "LLM is not configured — set the endpoint and model in Settings",
    );
  }
  return runClassifier(runtime, messages, budget, trace);
}

export interface TurnBindingsInput {
  chatId: string;
  /** Numeric sender id as a string, or null (no sender identity). */
  senderId: string | null;
  /** Source-local sub-thread (forum topic), or null. */
  threadId: number | null;
  /** The turn's correlation id — every tool call's own trace carries it. */
  correlationId: string;
  /** The current turn's effective text (message text / caption / transcript). */
  messageText: string;
  chatType: string;
  policy: BotPolicy;
  /** The chat's enabled prompt tasks: all of them + the turn-opening subset. */
  tasks: { prompt: Task[]; message: Task[] };
  /** Sink the `image_generate` tool fills; delivered after the reply. */
  collectImage: (base64: string) => void;
  /** Runs `browse_web` enqueued this turn (ack handling is the caller's). */
  onBrowserRunEnqueued: (runId: string) => void;
  /**
   * Deliver a task-opened turn's message (the `reply_to_message` tool): the
   * telegram runtime sends + mirrors; the queue consumer publishes a
   * reply-delivery event. The binding stamps task deliveries either way.
   */
  deliverTaskReply: (text: string) => Promise<{ messageId: number | null }>;
  /**
   * Actions-started hook, run before ANY tool executes (and awaited): the
   * queue consumer's retry gate — a turn that ran a tool must never re-run.
   * Absent on the v1 path (no queue, no retry).
   */
  onBeforeToolCall?: () => Promise<void>;
  /** Test seam: inject a deterministic generator instead of the LLM. */
  overrideGenerateReply?: BotMessagingDeps["generateReply"];
}

export interface TurnBindings {
  generateReply: BotMessagingDeps["generateReply"];
  applyStandingTasks: BotMessagingDeps["applyStandingTasks"];
}

export function createTurnBindings(input: TurnBindingsInput): TurnBindings {
  const {
    chatId,
    senderId,
    threadId,
    correlationId,
    messageText,
    chatType,
    policy,
    tasks: { prompt: promptTasks, message: messageTasks },
  } = input;

  /**
   * Whose rights this turn's tool calls carry, set by `applyStandingTasks`
   * when a standing task matched and read when the tool context is bound.
   * Scoped to this one turn's bindings — the service awaits the match before
   * generating, so it is settled before any tool runs.
   */
  let taskAuthorityUserId: string | null = null;
  /** Whether a `message` task opened this turn — decides the delivery shape. */
  let taskOpenedTurn = false;
  /** The `message` tasks that opened this turn (their deliveries are stamped). */
  let openingTaskIds: string[] = [];
  /** A matched `message` task can open a turn nobody addressed the bot in. */
  const canOpenTurn = messageTasks.length > 0;

  /**
   * A matched task can lend rights only if its author had rights to lend, and
   * only to somebody who does not already have them.
   */
  const canElevate =
    policy.ownerUserId != null &&
    senderId !== policy.ownerUserId &&
    promptTasks.some(
      (task) => task.source === "dashboard" || task.createdByUserId === policy.ownerUserId,
    );

  const generateReply: BotMessagingDeps["generateReply"] =
    input.overrideGenerateReply ??
    (async (messages: ChatMessage[], callTrace, onToolCall) => {
      const runtime = await getLlmRuntime();
      if (!runtime) {
        throw ApiError.serviceUnavailable(
          "LLM is not configured — set the endpoint and model in Settings",
        );
      }
      const conn = { baseUrl: runtime.baseUrl, apiKey: runtime.apiKey, backend: runtime.backend };
      // No tools registered → a single inference (cache-friendly path). A turn
      // a `message` task opened delivers through `reply_to_message`; an
      // ordinary reply turn is offered no delivery tool at all.
      const toolset = await getToolset(taskOpenedTurn ? { delivery: "reply" } : undefined);
      if (!toolset) {
        return chatCompletion(conn, {
          model: runtime.model,
          messages,
          maxTokens: REPLY_MAX_TOKENS,
          timeoutMs: REPLY_CHAT_COMPLETION_TIMEOUT_MS,
          trace: callTrace,
        });
      }
      // The actions-started hook wraps every tool execution: once a tool has
      // begun, the turn has acted and must never be re-run by a retry.
      const callTool: typeof toolset.callTool = input.onBeforeToolCall
        ? async (name, args) => {
            await input.onBeforeToolCall?.();
            return toolset.callTool(name, args);
          }
        : toolset.callTool;
      // Run the tool-call loop with the current chat bound, so tools only
      // ever read this conversation's data. See the v1 dep-builder notes.
      return runWithToolContext(
        {
          chatId,
          userId: senderId,
          correlationId,
          // Permissions only, and only when a standing task drove this turn.
          authorityUserId: taskAuthorityUserId,
          // Hard data extracted in code — `browse_web` takes links from here,
          // never from the goal text (the model has corrupted re-typed URLs).
          messageUrls: extractMessageUrls(messageText),
          threadId: threadId ?? undefined,
          collectImage: input.collectImage,
          // A task-opened turn sends nothing of its own; this binding is the
          // only way it reaches the chat, under the triggering message.
          ...(taskOpenedTurn
            ? {
                deliveryKind: "reply" as const,
                deliver: async (text: string) => {
                  const sent = await input.deliverTaskReply(text);
                  // Stamp the delivery onto the tasks that opened this turn,
                  // feeding the wording-variation block their next match
                  // composes. Best-effort inside — the message is out.
                  await recordTaskDeliveries(openingTaskIds, text);
                  return { messageId: sent.messageId ?? 0 };
                },
              }
            : {}),
          onBrowserRunEnqueued: input.onBrowserRunEnqueued,
        },
        () =>
          chatCompletionWithTools(conn, {
            model: runtime.model,
            messages,
            tools: toolset.tools,
            callTool,
            maxTokens: REPLY_MAX_TOKENS,
            timeoutMs: REPLY_CHAT_COMPLETION_TIMEOUT_MS,
            trace: callTrace,
            onToolCall: (rec) =>
              onToolCall?.({ name: rec.name, args: rec.args, result: rec.result, ok: rec.ok }),
          }),
      );
    });

  // Standing tasks: which of them does this message trigger? Wired only when
  // an answer could open a turn or lend rights, so ordinary traffic in a
  // chat without such tasks pays nothing. See the v1 dep-builder notes.
  const applyStandingTasks: BotMessagingDeps["applyStandingTasks"] =
    canOpenTurn || canElevate
      ? async (replyTrace, { addressed }) => {
          if (addressed ? !canElevate : !canOpenTurn) return null;
          // A message with no words has nothing for a task to quote.
          const text = messageText.trim();
          if (!text) return null;
          const runtime = await getClassifierRuntime();
          if (!runtime) return null;

          // Every enabled prompt task is offered on an addressed turn (an
          // `on-reply` task lends rights there); only `message` tasks on an
          // unaddressed one.
          const offered = addressed ? promptTasks : messageTasks;
          // Names for the people involved — a task conditioned on *who is
          // speaking* is unjudgeable without them. Degrades to no names.
          const labels = await getUserLabels([
            ...(senderId ? [senderId] : []),
            ...offered.flatMap((task) => task.targetUserIds),
          ]).catch(() => new Map<string, string>());
          const matchable = offered.map((task) => ({
            id: task.id,
            instruction: task.instruction,
            targetLabels: task.targetUserIds.map((id) => labels.get(id) ?? `User ${id}`),
          }));
          const messages = buildTaskMatchMessages({
            tasks: matchable,
            text,
            chatType,
            senderLabel: senderId ? labels.get(senderId) : null,
          });
          const result = await runClassifier(runtime, messages, undefined, {
            recorder: replyTrace,
            callKind: "task-match",
            label: "task match",
          });

          const verdict = parseTaskMatchVerdict(result.content, { tasks: matchable, text });
          const matched = offered.filter((task) => verdict.matchedIds.includes(task.id));
          // A task is its author's standing order: its actions run with the
          // author's rights, not the sender's.
          const authority = resolveTaskAuthority(matched, policy.ownerUserId ?? null);
          taskAuthorityUserId = authority;
          await replyTrace.event({
            type: "step",
            level: matched.length > 0 ? "success" : "info",
            message: "task match",
            data: {
              offered: matchable,
              matchedIds: verdict.matchedIds,
              reason: verdict.reason,
              authorityUserId: authority,
            },
          });
          if (matched.length === 0) return null;
          // This turn is now these tasks' run — relate their ids so the
          // per-task Debug view finds the replies they produced.
          replyTrace.relate(FEATURES.tasks.relatedIdsKey, verdict.matchedIds);
          // Only a `message` task may open a turn nobody addressed.
          const opening = matched.filter((task) => task.triggerKind === "message");
          taskOpenedTurn = opening.length > 0;
          openingTaskIds = opening.map((task) => task.id);
          return {
            taskIds: verdict.matchedIds,
            directive: opening.length > 0 ? buildTaskTriggerDirective(opening) : null,
          };
        }
      : undefined;

  return { generateReply, applyStandingTasks };
}
