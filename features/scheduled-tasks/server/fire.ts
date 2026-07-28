import "server-only";

import type { DrizzleDb } from "@/db/drizzle";
import { formatReply } from "@/features/bot-messaging/server/reply";
import { buildSystemPrompt } from "@/features/bot-messaging/server/prompt";
import { FEATURES } from "@/lib/features";
import { buildLanguageInstruction } from "@/lib/language";
import type { ChatCompletionResult, ChatMessage } from "@/server/llm/client";
import { llmUsageOf, sanitizeMessagesForTrace } from "@/server/llm/client";
import { runWithToolContext } from "@/server/mcp/context";
import type { McpToolCallResult } from "@/server/mcp/tool-result";
import { startTrace } from "@/server/trace";

import type { ScheduledTask } from "../types";

/**
 * Firing a scheduled task: compose an out-of-band prompt (base system prompt +
 * active persona + the firing chat's active specialist + the task directive),
 * have the LLM write an in-character chat message that *performs* the directive,
 * deliver it, mirror it into history, and record the whole pass as a trace under
 * the `scheduled-tasks` feature.
 *
 * The fire composes the firing chat's specialist context exactly like the live
 * reply path (the load-bearing integration — user decision, 2026-07-27):
 * instructions stack into the system prompt, and the completion runs with the
 * task's chat bound as the tool context, so a tool-capable `complete` (the real
 * scheduler binding) lets a specialist check-in read/write its own entries
 * instead of waking up as the generic bot.
 *
 * Collaborators (LLM completion, delivery, history mirror) are injected so the
 * fire is unit-testable without a live LLM or Telegram, and so the scheduler can
 * bind them once per run. Advancing the schedule (`next_run_at`) and the capped
 * `recent_deliveries` is the caller's job — {@link fireScheduledTask} only
 * returns the delivered text.
 */

const FEATURE = FEATURES["scheduled-tasks"];

/** One tool call executed during a fire, reported for trace recording. */
export interface FireToolCall {
  name: string;
  args: Record<string, unknown>;
  result: McpToolCallResult;
  ok: boolean;
}

/** Collaborators the fire needs. */
export interface FireDeps {
  /** The active personality prompt to compose into the system prompt, or null. */
  personalityPrompt: string | null;
  /**
   * The firing chat's active specialist instructions, stacked into the system
   * prompt like the live reply path. Null/absent → no specialist block.
   */
  specialistInstructions?: string | null;
  /**
   * The reply language required for this task's chat (operator-configured, or the
   * default). Injected as a strict directive before the task directive so the
   * fired message is in the chat's language. Null/absent → no directive.
   */
  requiredLanguage?: string | null;
  /**
   * Generate the task message. Throws on provider/config failure. Runs inside
   * the task chat's tool context; a tool-capable implementation reports each
   * executed tool call via `onToolCall` so the fire trace records it.
   */
  complete: (
    messages: ChatMessage[],
    onToolCall?: (call: FireToolCall) => void | Promise<void>,
  ) => Promise<ChatCompletionResult>;
  /** Deliver the message to the chat; resolves the delivered Telegram message id. */
  send: (text: string) => Promise<{ messageId: number }>;
  /** Mirror the delivered message into history (best-effort). */
  recordReply?: (input: {
    chatId: string;
    telegramMessageId: number;
    content: string;
  }) => Promise<void>;
  db?: DrizzleDb;
}

/** Outcome of a fire: whether a message was delivered, and its text/id if so. */
export interface FireResult {
  ok: boolean;
  text?: string;
  messageId?: number;
}

/** True when the text has at least one letter or digit (not just punctuation). */
function hasVisibleContent(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

/**
 * Build the directive user message. Recurring tasks get their recent deliveries
 * fed back so the model varies its wording; a one-shot has none. Grounded in the
 * MVP `features/tasks/fire.ts` `buildTaskUserMessage`, trimmed for this project's
 * plain-text (no chat-tag) delivery.
 *
 * A fire carries **no transcript** — the directive is the model's whole world.
 * When the directive points at something instead of stating it ("remind him who
 * X is"), the message that comes out is the pointer, not the reminder (observed
 * in production, 2026-07-28). `tasks_create` now pushes the facts into the
 * instruction at creation time; this block is the second line of defence, telling
 * the fire it may look the reference up in history before writing, and to be
 * honest rather than parrot the directive when it cannot. The fire runs with the
 * full toolset bound to the task's chat, so the lookup is actually available.
 */
export function buildTaskDirectiveMessage(
  instruction: string,
  recentDeliveries: string[],
): string {
  const previousBlock =
    recentDeliveries.length > 0
      ? `\n\nYou have delivered this recurring task before. Your most recent messages for it (newest first):\n` +
        recentDeliveries.map((text, i) => `${i + 1}. ${text}`).join("\n") +
        `\nSay the same thing a DIFFERENT way this time — fresh wording, angle, or phrasing. Do not reuse a sentence from the list above.`
      : "";
  return (
    `[SCHEDULED TASK] A standing task set up for this chat is now due. Deliver it now.\n` +
    `Directive: ${instruction}\n\n` +
    `Write ONE short, natural, in-character chat message that *performs* this directive right now. ` +
    `The message IS the reminder/nudge itself, spoken to the people it concerns.\n` +
    `- Do NOT restate the directive as an instruction. Never write "remind X to …" — instead say what you would actually tell them (e.g. directive "remind me to call mom" → "Hey, don't forget to call your mom").\n` +
    `- Address people by name when you know it; if it concerns the person who set it up, address them directly ("you").\n` +
    `- You have no chat transcript here — the directive above is all you were given. If it names a person, event, joke, or topic without saying what it is, search this chat's history for it first (search for the name, then read the surrounding messages if the matches are thin) and put what you find into the message. The reminder must carry the substance, not point at it.\n` +
    `- If the lookup turns up nothing, say plainly what the directive was about and that you cannot recall the details — do not invent them, and do not just repeat the directive back as if it were the message.\n` +
    `- Plain spoken text only. Do not mention that this is scheduled or automated.${previousBlock}\n` +
    `Once you have what you need, output only the message text.`
  );
}

/**
 * Generate and deliver one task's message. Returns `{ ok: false }` (never throws)
 * when generation/delivery fails or the model produced no visible content, so the
 * scheduler can still advance the schedule and move on.
 */
export async function fireScheduledTask(task: ScheduledTask, deps: FireDeps): Promise<FireResult> {
  const trace = await startTrace(
    {
      feature: FEATURE.id,
      action: "fire",
      trigger: { kind: "cron", actor: task.chatId, correlationId: task.id },
      inputSummary: task.instruction,
    }
  );
  try {
    const languageInstruction = deps.requiredLanguage?.trim()
      ? buildLanguageInstruction(deps.requiredLanguage)
      : null;
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: buildSystemPrompt({
          personalityPrompt: deps.personalityPrompt,
          specialistInstructions: deps.specialistInstructions,
        }),
      },
      ...(languageInstruction
        ? [{ role: "system" as const, content: languageInstruction }]
        : []),
      { role: "user", content: buildTaskDirectiveMessage(task.instruction, task.recentDeliveries ?? []) },
    ];
    await trace.event({
      type: "llm_request",
      message: "request",
      data: {
        messages: sanitizeMessagesForTrace(messages),
        specialistApplied: Boolean(deps.specialistInstructions?.trim()),
      },
    });

    let reply: ChatCompletionResult;
    try {
      // The completion runs with the task's chat bound as the tool context —
      // like the live reply path — so any tool the model calls (a specialist
      // reading its entries, a task listing) is scoped to the firing chat. No
      // `collectImage` sink: a fire is text-only delivery, and image-producing
      // tools must refuse rather than generate into a void.
      reply = await runWithToolContext(
        {
          chatId: task.chatId,
          userId: task.createdByUserId ?? null,
          threadId: task.threadId ?? null,
        },
        () =>
          deps.complete(messages, async (call) => {
            await trace.event({
              type: "external_call",
              level: call.ok ? "info" : "warn",
              message: `tool: ${call.name}`,
              data: { args: call.args, result: call.result },
            });
          }),
      );
    } catch (err) {
      await trace.event({
        type: "step",
        level: "warn",
        message: "generation failed",
        data: { error: err instanceof Error ? err.message : String(err) },
      });
      await trace.skip(undefined, { outputSummary: "generation failed" });
      return { ok: false };
    }
    await trace.event({
      type: "llm_response",
      message: "response",
      data: reply.responseBody ?? { content: reply.content },
      usage: { ...llmUsageOf(reply), callKind: "scheduled-task-fire" },
    });

    const outgoing = formatReply(reply.content);
    if (!hasVisibleContent(outgoing)) {
      await trace.event({ type: "step", level: "warn", message: "empty reply — nothing to deliver" });
      await trace.skip(undefined, { outputSummary: "empty reply" });
      return { ok: false };
    }

    let messageId: number;
    try {
      ({ messageId } = await deps.send(outgoing));
    } catch (err) {
      await trace.fail(err);
      return { ok: false };
    }
    await trace.event({
      type: "output",
      level: "success",
      message: "send message",
      data: { content: outgoing, messageId },
    });

    // Mirror into history so the fired message is part of the conversation and
    // future variation context. Best-effort — never fail a delivered message.
    try {
      await deps.recordReply?.({ chatId: task.chatId, telegramMessageId: messageId, content: outgoing });
    } catch {
      // swallow — the message was delivered; the mirror is a side record
    }

    // A fire has no incoming message to key on, so it opens on the task id and
    // settles on what it delivered. That puts it on the app-wide
    // `<chatId>:<messageId>` convention: feedback on this message can resolve the
    // trace behind it, and the chat-scoped trace queries count it like any other
    // message in the chat. The task itself stays linked via `relatedIds`.
    await trace.succeed({
      outputSummary: outgoing,
      relatedIds: { [FEATURE.relatedIdsKey]: [task.id] },
      correlationId: `${task.chatId}:${messageId}`,
    });
    return { ok: true, text: outgoing, messageId };
  } catch (err) {
    await trace.fail(err);
    return { ok: false };
  }
}
