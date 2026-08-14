import "server-only";

import type { DrizzleDb } from "@/db/drizzle";
import { buildSystemPrompt } from "@/features/bot-messaging/server/prompt";
import { FEATURES } from "@/lib/features";
import { buildLanguageInstruction } from "@/lib/language";
import type { ChatCompletionResult, ChatMessage } from "@/server/llm/client";
import { llmUsageOf, sanitizeMessagesForTrace } from "@/server/llm/client";
import { runWithToolContext } from "@/server/mcp/context";
import type { McpToolCallResult } from "@/server/mcp/tool-result";
import { startTrace } from "@/server/trace";

import type { Task } from "../types";

/**
 * Firing a timed task: compose an out-of-band prompt (base system prompt +
 * active persona + the firing chat's specialist + standing tasks + the task
 * directive), then let the LLM *execute* the task with the full toolset — the
 * outbound tools included — and record the whole pass as a trace.
 *
 * Nothing is delivered by this code (user decision, 2026-08-13). The model's
 * completion text is traced, never sent; a message reaches the chat only
 * through `send_message`/`reply_to_message`, which the fire wires up by
 * binding {@link import("@/server/mcp/context").McpToolContext.deliver}. A
 * fire that sends nothing is a **quiet fire** — a legitimate outcome ("check
 * X, message only if Y"), recorded as such, never an error.
 *
 * The fire composes the firing chat's specialist context exactly like the live
 * reply path (the load-bearing integration — user decision, 2026-07-27):
 * instructions stack into the system prompt, and the completion runs with the
 * task's chat bound as the tool context, so a specialist check-in can
 * read/write its own entries instead of waking up as the generic bot.
 *
 * Collaborators (LLM completion, delivery, history mirror) are injected so the
 * fire is unit-testable without a live LLM or Telegram, and so the scheduler
 * can bind them once per run. Advancing the schedule (`next_run_at`) and the
 * capped `recent_deliveries` is the caller's job — {@link fireTask} only
 * returns what was sent.
 */

const FEATURE = FEATURES.tasks;

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
   * The firing chat's standing tasks as a composed prompt block, stacked in
   * like the live reply path: a standing task about how the bot speaks here
   * governs what it sends unprompted just as much as what it answers.
   * Null/absent → no block.
   */
  standingTasks?: string | null;
  /**
   * The reply language required for this task's chat (operator-configured, or
   * the default). Injected as a strict directive before the task directive so
   * anything the fire sends is in the chat's language. Null/absent → none.
   */
  requiredLanguage?: string | null;
  /**
   * Run the completion (real: `chatCompletionWithTools` with the outbound
   * toolset). Throws on provider/config failure. Runs inside the task chat's
   * tool context; each executed tool call is reported via `onToolCall` so the
   * fire trace records it.
   */
  complete: (
    messages: ChatMessage[],
    onToolCall?: (call: FireToolCall) => void | Promise<void>,
  ) => Promise<ChatCompletionResult>;
  /**
   * Raw delivery to the task's chat (real: the bot's `sendChatMessage`);
   * resolves the delivered message id. The fire wraps it as the tool context's
   * `deliver` binding, records each send on the trace, and mirrors it into
   * history — the outbound tools call the wrapper, never this directly.
   */
  send: (
    text: string,
    opts: { threadId?: number | null; replyToMessageId?: number },
  ) => Promise<{ messageId: number }>;
  /** Mirror a delivered message into history (best-effort). */
  recordReply?: (input: {
    chatId: string;
    telegramMessageId: number;
    content: string;
  }) => Promise<void>;
  db?: DrizzleDb;
}

/** Outcome of a fire. `ok: true` with `sent: []` is a quiet fire. */
export interface FireResult {
  ok: boolean;
  /** The texts actually delivered, in send order. */
  sent: string[];
}

/**
 * Build the directive user message. Recurring tasks get their recent deliveries
 * fed back so the model varies its wording; a one-shot has none.
 *
 * A fire carries **no transcript** — the directive plus its saved context are
 * the model's whole world. When the directive points at something instead of
 * stating it ("remind him who X is"), the message that comes out is the
 * pointer, not the reminder (observed in production, 2026-07-28). `tasks_create`
 * gathers that background into the task's dedicated `context` at creation time,
 * and this block hands it to the fire; the history lookup stays as the second
 * line of defence, with honesty over parroting when even that fails.
 *
 * The recent deliveries are the one part of this prompt that is bot-authored,
 * and they are labelled as such (user report, 2026-08-01): one hallucinated
 * fire used to seed the next, since the invented detail came back as context
 * and compounded from there.
 *
 * Delivery is spelled out twice (up front and at the end) because it inverts
 * what the model does everywhere else: in every other turn its answer text IS
 * the message, and here the answer text goes nowhere.
 */
export function buildTaskDirectiveMessage(
  instruction: string,
  context: string | null,
  recentDeliveries: string[],
): string {
  const contextBlock = context?.trim()
    ? `Saved context (gathered from the chat when this task was created — the background the directive relies on):\n${context.trim()}\n\n`
    : "";
  const previousBlock =
    recentDeliveries.length > 0
      ? `\n\nWORDING REFERENCE ONLY — you have delivered this recurring task before. Your most recent messages for it (newest first):\n` +
        recentDeliveries.map((text, i) => `${i + 1}. ${text}`).join("\n") +
        `\nThose are YOUR OWN past messages, quoted for exactly one purpose: so you do not repeat yourself. They are NOT a source of facts. ` +
        `They may be wrong, stale, or invented, and anything in them that is not in the directive or the saved context above is unverified — do not repeat it, build on it, or treat it as something that happened. ` +
        `Say the same thing a DIFFERENT way this time — fresh wording, angle, or phrasing. Do not reuse a sentence from the list.`
      : "";
  return (
    `[TASK] A standing task set up for this chat is now due. Execute it now.\n` +
    `Directive: ${instruction}\n\n` +
    contextBlock +
    `You are acting on your own here — nobody sent a message, and nothing you merely write in your ` +
    `answer reaches the chat. Anything the people here should see must be sent with the ` +
    `send_message tool (or reply_to_message when it is about one specific earlier message). Use ` +
    `your other tools first when the directive needs them (looking something up, downloading, ` +
    `checking history).\n` +
    `- When the directive is a reminder or a nudge, send ONE short, natural, in-character chat ` +
    `message that *performs* it. Do NOT restate the directive as an instruction. Never write ` +
    `"remind X to …" — say what you would actually tell them (directive "remind me to call mom" → ` +
    `send "Hey, don't forget to call your mom").\n` +
    `- Address people by name when you know it; if it concerns the person who set the task up, ` +
    `address them directly ("you").\n` +
    `- You have no chat transcript here — the directive and saved context above are all you were ` +
    `given. Ground the message in the saved context when there is one; the message must carry the ` +
    `substance, not point at it. If the directive names a person, event, joke, or topic the saved ` +
    `context does not explain, search this chat's history for it first and put what you find into ` +
    `the message. If the lookup turns up nothing, say plainly what the task was about and that you ` +
    `cannot recall the details — do not invent them.\n` +
    `- If the directive asks you to check or watch something and there is nothing worth saying ` +
    `this time, send nothing at all: a quiet run is a correct outcome. Never send filler like ` +
    `"nothing to report" unless the directive explicitly asks for it.\n` +
    `- Plain spoken text only in what you send. Do not mention that this is scheduled or automated.` +
    previousBlock +
    `\nWhen you are done, your final answer is just a short internal note of what you did (or why ` +
    `you stayed silent) — it is logged, not sent.`
  );
}

/**
 * Execute one due task. Returns `{ ok: false }` (never throws) when generation
 * failed, or when delivery was attempted and nothing got through — both worth a
 * one-shot retry. A quiet fire (the model chose to send nothing) is `ok: true`.
 */
export async function fireTask(task: Task, deps: FireDeps): Promise<FireResult> {
  const trace = await startTrace({
    feature: FEATURE.id,
    action: "fire",
    trigger: { kind: "cron", actor: task.chatId ?? "global", correlationId: task.id },
    inputSummary: task.instruction,
  });
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
          standingTasks: deps.standingTasks,
        }),
      },
      ...(languageInstruction ? [{ role: "system" as const, content: languageInstruction }] : []),
      {
        role: "user",
        content: buildTaskDirectiveMessage(
          task.instruction,
          task.context,
          task.recentDeliveries ?? [],
        ),
      },
    ];
    await trace.event({
      type: "llm_request",
      message: "request",
      data: {
        messages: sanitizeMessagesForTrace(messages),
        specialistApplied: Boolean(deps.specialistInstructions?.trim()),
        standingTasksApplied: Boolean(deps.standingTasks?.trim()),
      },
    });

    // What actually went out, recorded by the deliver binding as it happens —
    // the fire's ground truth, independent of anything the model writes.
    const sent: string[] = [];
    const sentIds: number[] = [];
    let deliveryFailures = 0;
    const deliver = async (text: string, opts?: { replyToMessageId?: number }) => {
      try {
        const { messageId } = await deps.send(text, {
          threadId: task.threadId,
          replyToMessageId: opts?.replyToMessageId,
        });
        sent.push(text);
        sentIds.push(messageId);
        await trace.event({
          type: "output",
          level: "success",
          message: opts?.replyToMessageId
            ? `send message (reply to #${opts.replyToMessageId})`
            : "send message",
          data: { content: text, messageId, replyToMessageId: opts?.replyToMessageId ?? null },
        });
        // Mirror into history so the sent message is part of the conversation
        // and future context. Best-effort — never fail a delivered message.
        try {
          await deps.recordReply?.({
            chatId: task.chatId!,
            telegramMessageId: messageId,
            content: text,
          });
        } catch {
          // swallow — the message was delivered; the mirror is a side record
        }
        return { messageId };
      } catch (err) {
        deliveryFailures += 1;
        throw err;
      }
    };

    let reply: ChatCompletionResult;
    try {
      // The completion runs with the task's chat bound as the tool context —
      // like the live reply path — so every tool the model calls is scoped to
      // the firing chat, and `deliver` is what arms the outbound tools. No
      // `collectImage` sink: image-producing tools must refuse rather than
      // generate into a void.
      reply = await runWithToolContext(
        {
          chatId: task.chatId!,
          userId: task.createdByUserId ?? null,
          threadId: task.threadId ?? null,
          deliver,
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
      return { ok: false, sent };
    }
    await trace.event({
      type: "llm_response",
      message: "response",
      data: reply.responseBody ?? { content: reply.content },
      usage: { ...llmUsageOf(reply), callKind: "task-fire" },
    });

    // Delivery was attempted and nothing got through: the task wanted to speak
    // and could not — the retryable failure. A fire that attempted nothing is a
    // quiet fire, which is the model's call to make.
    if (sent.length === 0 && deliveryFailures > 0) {
      const failure = new Error(
        `every delivery attempt failed (${deliveryFailures}) — nothing reached the chat`,
      );
      await trace.fail(failure);
      return { ok: false, sent };
    }

    // A fire has no incoming message to key on, so it opens on the task id and
    // settles on what it delivered. The `<chatId>:<messageId>` convention is
    // app-wide: feedback on a sent message can resolve the trace behind it, and
    // chat-scoped trace queries count it like any other message in the chat.
    await trace.succeed({
      outputSummary:
        sent.length > 0 ? sent.join("\n\n") : `quiet fire — nothing sent (${reply.content})`,
      relatedIds: { [FEATURE.relatedIdsKey]: [task.id] },
      ...(sentIds.length > 0 ? { correlationId: `${task.chatId}:${sentIds[0]}` } : {}),
    });
    return { ok: true, sent };
  } catch (err) {
    await trace.fail(err);
    return { ok: false, sent: [] };
  }
}
