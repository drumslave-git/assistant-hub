import "server-only";

import type { DrizzleDb } from "@/db/drizzle";
import { buildSystemPrompt } from "@/features/bot-messaging/server/prompt";
import { FEATURES } from "@/lib/features";
import { buildLanguageInstruction } from "@/lib/language";
import type { TraceTrigger } from "@/lib/trace";
import type {
  ChatCompletionResult,
  ChatMessage,
  LlmCallTrace,
} from "@/server/llm/client";
import { runWithToolContext } from "@/server/mcp/context";
import { startTrace } from "@/server/trace";

import { buildRecentDeliveriesBlock } from "../format";
import type { Task } from "../types";

/**
 * Firing a timed task: compose an out-of-band prompt (base system prompt +
 * active persona + standing tasks + the task directive), then let the LLM
 * *execute* the task with the full toolset — the outbound tools included — and
 * record the whole pass as a trace.
 *
 * Nothing is delivered by this code (user decision, 2026-08-13). The model's
 * completion text is traced, never sent; a message reaches the chat only
 * through `send_message`/`reply_to_message`, which the fire wires up by
 * binding {@link import("@/server/mcp/context").McpToolContext.deliver}. A
 * fire that sends nothing is a **quiet fire** — a legitimate outcome ("check
 * X, message only if Y"), recorded as such, never an error.
 *
 * Collaborators (LLM completion, delivery, history mirror) are injected so the
 * fire is unit-testable without a live LLM or Telegram, and so the scheduler
 * can bind them once per run. Advancing the schedule (`next_run_at`) and the
 * capped `recent_deliveries` is the caller's job — {@link fireTask} only
 * returns what was sent.
 */

const FEATURE = FEATURES.tasks;

/** Collaborators the fire needs. */
export interface FireDeps {
  /** The active personality prompt to compose into the system prompt, or null. */
  personalityPrompt: string | null;
  /**
   * The firing chat's identity context — the same block a live reply gets: in a
   * group the known-participant roster (names, @usernames, user ids), in a
   * private chat who the bot is talking to. Injected as a system message so a
   * fire can address people properly — most importantly by their exact
   * @username, without which Telegram notifies nobody (operator report,
   * 2026-08-18: a fire greeted someone by a bare alias and the reminder was
   * never seen). Null/absent → no block.
   */
  chatContext?: string | null;
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
   * tool context; the whole exchange (request, rounds, tool calls, retries) is
   * recorded on the fire trace by the shared LLM tracing layer via `trace`.
   */
  complete: (messages: ChatMessage[], trace?: LlmCallTrace) => Promise<ChatCompletionResult>;
  /**
   * Raw delivery to the task's chat (real: the bot's `sendChatMessage`);
   * resolves the delivered message id. The fire wraps it as the tool context's
   * `deliver` binding, records each send on the trace, and mirrors it into
   * history — the outbound tools call the wrapper, never this directly.
   */
  send: (text: string, opts: { threadId?: number | null }) => Promise<{ messageId: number }>;
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
 * How a fire is recorded. The scheduler's regular fire is the default; the
 * dashboard's "Fire now" passes `manual-fire` with its own trigger, so an
 * operator-initiated run is distinguishable from the schedule's in Debug. The
 * task id is stamped as the opening correlation either way.
 */
export interface FireOptions {
  action?: "fire" | "manual-fire";
  /** Trace trigger override (e.g. `{ kind: "dashboard" }`); omit for the cron default. */
  trigger?: TraceTrigger;
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
 * The recent deliveries are the shared wording-variation block
 * ({@link buildRecentDeliveriesBlock}) — matched `message` tasks feed back the
 * same way.
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
  const variation = buildRecentDeliveriesBlock(recentDeliveries, {
    intro: "you have delivered this recurring task before.",
    grounding: "the directive or the saved context above",
  });
  const previousBlock = variation ? `\n\n${variation}` : "";
  return (
    `[TASK] A standing task set up for this chat is now due. Execute it now.\n` +
    `Directive: ${instruction}\n\n` +
    contextBlock +
    `You are acting on your own here — nobody sent a message, and nothing you merely write in your ` +
    `answer reaches the chat. Anything the people here should see must be sent with the ` +
    `send_message tool. Use your other tools first when the directive needs them (looking ` +
    `something up, downloading, checking history).\n` +
    `- When the directive is a reminder or a nudge, send ONE short, natural, in-character chat ` +
    `message that *performs* it. Do NOT restate the directive as an instruction. Never write ` +
    `"remind X to …" — say what you would actually tell them (directive "remind me to call mom" → ` +
    `send "Hey, don't forget to call your mom").\n` +
    `- Address people by name when you know it; if it concerns the person who set the task up, ` +
    `address them directly ("you").\n` +
    `- A bare name or nickname notifies NOBODY on Telegram — a message meant for a specific ` +
    `person must mention them by their exact @username (copy it from the chat participants ` +
    `context, @ included) so they actually get notified. Only when no @username is listed for ` +
    `them, use their name.\n` +
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
export async function fireTask(
  task: Task,
  deps: FireDeps,
  opts: FireOptions = {},
): Promise<FireResult> {
  const trace = await startTrace({
    feature: FEATURE.id,
    action: opts.action ?? "fire",
    trigger: {
      kind: "cron",
      actor: task.chatId ?? "global",
      ...(opts.trigger ?? {}),
      correlationId: opts.trigger?.correlationId ?? task.id,
    },
    inputSummary: task.instruction,
  });
  // Related up front, not at settle: the per-task Debug view must find every
  // fire — the failed and skipped ones are the fires an operator looks for.
  trace.relate(FEATURE.relatedIdsKey, [task.id]);
  try {
    const languageInstruction = deps.requiredLanguage?.trim()
      ? buildLanguageInstruction(deps.requiredLanguage)
      : null;
    const chatContext = deps.chatContext?.trim() ? deps.chatContext.trim() : null;
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: buildSystemPrompt({
          personalityPrompt: deps.personalityPrompt,
          standingTasks: deps.standingTasks,
        }),
      },
      // The chat identity context right after the system prompt, mirroring the
      // live reply order — it names who can be addressed and by which @username.
      ...(chatContext ? [{ role: "system" as const, content: chatContext }] : []),
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
      type: "step",
      message: "fire prompt composed",
      data: {
        standingTasksApplied: Boolean(deps.standingTasks?.trim()),
        chatContextApplied: Boolean(chatContext),
      },
    });

    // What actually went out, recorded by the deliver binding as it happens —
    // the fire's ground truth, independent of anything the model writes.
    const sent: string[] = [];
    const sentIds: number[] = [];
    let deliveryFailures = 0;
    // A fire sends standalone: nothing triggered it, so there is no message to
    // attach to (user decision, 2026-08-14 — a `message` task replies, a timed
    // one sends). The model never names a target, so it can never aim one wrong.
    const deliver = async (text: string) => {
      try {
        const { messageId } = await deps.send(text, { threadId: task.threadId });
        sent.push(text);
        sentIds.push(messageId);
        await trace.event({
          type: "output",
          level: "success",
          message: "send message",
          data: { content: text, messageId },
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
          // A fire has no inbound event to stamp owner status from; the
          // task's own creation-time stamp carries the creator's rights
          // (dashboard fires stay non-owner here, as they always were —
          // their created_by_user_id is null and the stamp false).
          senderIsOwner: task.createdByOwner,
          // The fire's correlation is the task id (what its trace opened with),
          // so the fire and any tool calls it makes group in Debug.
          correlationId: task.id,
          threadId: task.threadId ?? null,
          deliveryKind: "send",
          deliver,
        },
        () =>
          deps.complete(messages, {
            recorder: trace,
            callKind: "task-fire",
            toolTurnCallKind: "task-fire",
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
      ...(sentIds.length > 0 ? { correlationId: `${task.chatId}:${sentIds[0]}` } : {}),
    });
    return { ok: true, sent };
  } catch (err) {
    await trace.fail(err);
    return { ok: false, sent: [] };
  }
}
