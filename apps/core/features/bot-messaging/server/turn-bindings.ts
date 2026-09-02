import type { SourceId } from "@assistant-hub-swarm/contracts";

import "server-only";

import { getClassifierRuntime, getLlmRuntime } from "@/features/settings/server/service";
import {
  buildTaskTriggerDirective,
  taskLendsOwnerRights,
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
  /** Which source the turn belongs to — the namespace of every id here, and the tool traces' kind. */
  source: SourceId;
  chatId: string;
  /** The turn's assistant (from the inbound event) — bound onto tool calls. */
  assistantId: string;
  /** Numeric sender id as a string, or null (no sender identity). */
  senderId: string | null;
  /** Source-local sub-thread (forum topic), or null. */
  threadId: number | null;
  /** The turn's correlation id — every tool call's own trace carries it. */
  correlationId: string;
  /** The current turn's effective text (message text / caption / transcript). */
  messageText: string;
  chatType: string;
  /**
   * Whether the sender holds owner rights, as the owning source stamped it on
   * the inbound event (`sender.isOwner`) — authoritative since the split; the
   * core compares no user ids of its own.
   */
  senderIsOwner: boolean;
  /** The chat's enabled prompt tasks: all of them + the turn-opening subset. */
  tasks: { prompt: Task[]; message: Task[] };
  /** Sink the `image_generate` tool fills; delivered after the reply. */
  collectImage: (base64: string) => void;
  /** Runs `browse_web` enqueued this turn (ack handling is the caller's). */
  onBrowserRunEnqueued: (runId: string) => void;
  /**
   * The message this turn is answering, so a task-opened turn's reply lands
   * under it. Travels to the source app with the delivery call; the model
   * never names a target.
   */
  replyToMessageId?: number | null;
  /**
   * Actions-started hook, run before ANY tool executes (and awaited): the
   * queue consumer's retry gate — a turn that ran a tool must never re-run.
   * Absent on the v1 path (no queue, no retry).
   */
  onBeforeToolCall?: (toolName: string) => Promise<void>;
  /** Test seam: inject a deterministic generator instead of the LLM. */
  overrideGenerateReply?: BotMessagingDeps["generateReply"];
}

export interface TurnBindings {
  generateReply: BotMessagingDeps["generateReply"];
  applyStandingTasks: BotMessagingDeps["applyStandingTasks"];
}

export function createTurnBindings(input: TurnBindingsInput): TurnBindings {
  const {
    source,
    chatId,
    assistantId,
    senderId,
    threadId,
    correlationId,
    messageText,
    chatType,
    senderIsOwner,
    tasks: { prompt: promptTasks, message: messageTasks },
  } = input;

  /**
   * Whether a matched standing task lent this turn owner rights, set by
   * `applyStandingTasks` and read when the tool context is bound. Scoped to
   * this one turn's bindings — the service awaits the match before
   * generating, so it is settled before any tool runs.
   */
  let taskAuthorityIsOwner = false;
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
  const canElevate = !senderIsOwner && taskLendsOwnerRights(promptTasks);

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
      // ordinary reply turn is offered no delivery tool at all. The turn's
      // source and assistant come along: they decide which tool connections
      // this turn may call (Phase 5 scoping).
      const toolset = await getToolset({
        ...(taskOpenedTurn ? { delivery: "reply" as const } : {}),
        source,
        assistantId,
      });
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
            // The tool's name travels with the hook: the turn marks itself as
            // having acted, and the owning source hears WHAT it is doing —
            // a typing indicator ignores it, a web thread shows it.
            await input.onBeforeToolCall?.(name);
            return toolset.callTool(name, args);
          }
        : toolset.callTool;
      // Run the tool-call loop with the current chat bound, so tools only
      // ever read this conversation's data. See the v1 dep-builder notes.
      return runWithToolContext(
        {
          source,
          chatId,
          assistantId,
          userId: senderId,
          correlationId,
          // The sender's own owner status, as the source stamped it.
          senderIsOwner,
          // Permissions only, and only when a standing task drove this turn.
          authorityIsOwner: taskAuthorityIsOwner,
          // Hard data extracted in code — `browse_web` takes links from here,
          // never from the goal text (the model has corrupted re-typed URLs).
          messageUrls: extractMessageUrls(messageText),
          threadId: threadId ?? undefined,
          replyToMessageId: input.replyToMessageId ?? null,
          collectImage: input.collectImage,
          // A task-opened turn sends nothing of its own: the source app's
          // `reply_to_message` tool is the only way it reaches the chat, and
          // it lands under the message that opened the turn. What stays here
          // is the stamping — the wording-variation block a task's next match
          // composes is about the task, not about the platform.
          ...(taskOpenedTurn
            ? {
                deliveryKind: "reply" as const,
                onDelivered: async ({ ok, text }) => {
                  if (ok) await recordTaskDeliveries(openingTaskIds, text);
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
          const labels = await getUserLabels(source, [
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
          const lendsOwner = taskLendsOwnerRights(matched);
          taskAuthorityIsOwner = lendsOwner;
          await replyTrace.event({
            type: "step",
            level: matched.length > 0 ? "success" : "info",
            message: "task match",
            data: {
              offered: matchable,
              matchedIds: verdict.matchedIds,
              reason: verdict.reason,
              authorityIsOwner: lendsOwner,
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
