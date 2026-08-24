import "server-only";

import { getSingleAssistantPersona } from "@/features/assistants/server/service";
import { getBackgroundRuntime } from "@/features/settings/server/service";
import { FEATURES } from "@/lib/features";
import {
  chatCompletion,
  type ChatCompletionResult,
  type ChatMessage,
  type LlmCallTrace,
} from "@/server/llm/client";
import { publishEvent } from "@/server/realtime/hub";
import { startTrace } from "@/server/trace";
import { normalizeModelName } from "../model-name";
import type { UserFeedback } from "../types";
import { getReplyTrace, renderExchange, renderReplyTrace } from "./exchange";
import { resolveFeedbackPorts, type FeedbackPorts } from "./feedback-store";

/**
 * Self-reflection: as soon as a user answers the 👍/👎 menu, the bot reads back
 * how it produced the reply they reacted to — the prompt it was given, the tools
 * it ran, the text it sent — together with what they said about it, and writes
 * down what went right or wrong and why. The result is stored on the same
 * feedback row.
 *
 * This is the reasoned half of a feedback. "Too long" is a symptom; the
 * reflection is where the cause lives, and it is what both incorporation folds
 * read (see `analyze.ts`) when they distill per-user preferences and global
 * self-corrections.
 *
 * Runs detached from the Telegram flows ({@link scheduleReflection}): the answer
 * is already stored and acknowledged, and grammy handles updates one at a time,
 * so waiting on an inference here would stall the bot for every other chat.
 * Best-effort by consequence — a reflection that never lands leaves the column
 * null, and the daily job writes it before folding that feedback.
 */

const FEATURE = FEATURES["user-feedback"];

/** Collaborators, injected so tests can drive a reflection deterministically. */
export interface ReflectionDeps {
  /** Run the reflection call (real: `chatCompletion` with the configured model). */
  complete: (messages: ChatMessage[], trace?: LlmCallTrace) => Promise<ChatCompletionResult>;
  /** Active persona prompt, stated as bot context so the bot judges itself as itself. */
  personalityPrompt?: string | null;
  /** Configured model id — fallback for stamping when the provider reports none. */
  model?: string | null;
  /** The source-owned feedback rows + mirror (real: the tg internal API). */
  ports: FeedbackPorts;
}

const REFLECTION_PROMPT =
  "You are reviewing one of your own replies as a Telegram chat bot. You are given how the reply " +
  "was produced — the prompt you were working from, any tools you called with their results, and " +
  "the reply you sent — followed by the reaction and feedback the user gave it. Write a short, " +
  "honest self-reflection: what specifically went right or wrong in that reply, and why it " +
  "happened. Name the actual cause where the evidence shows one (an instruction in your prompt, a " +
  "missing or wrong tool result, an assumption you made, tone, length, language). Do not restate " +
  "the user's feedback — explain it. Do not apologize, and do not suggest what to do next. Reply " +
  "with ONLY the reflection, a few sentences of plain text, no headings and no commentary.";

/** The bot persona, stated once as context (never repeated per block). */
function personaContext(personalityPrompt: string | null | undefined): string | null {
  const persona = personalityPrompt?.trim();
  if (!persona) return null;
  return `For context, your configured persona:\n${persona}`;
}

/** What the user did about the reply, as the reflection's subject line. */
function feedbackBlock(feedback: UserFeedback): string {
  return [
    `User reaction: ${feedback.reaction === "up" ? "👍 liked it" : "👎 disliked it"}`,
    `User feedback: ${feedback.feedback ?? "(none)"}`,
  ].join("\n");
}

/**
 * Reflect on one answered feedback and store the result on its row. Resolves the
 * reflection text, or null when it could not be produced (no answer to explain,
 * a failed call, or an empty output) — every outcome is recorded on its own
 * trace, so a missing reflection is always explained in Debug.
 *
 * Never throws: every caller (a detached kickoff, the daily job) treats a
 * reflection as best-effort.
 */
export async function reflectOnFeedback(
  feedback: UserFeedback,
  deps: ReflectionDeps,
): Promise<string | null> {
  // Nothing to explain until the user has actually said something.
  if (feedback.status !== "completed" || !feedback.feedback?.trim()) return null;

  const trace = await startTrace(
    {
      feature: FEATURE.id,
      action: "reflect",
      trigger: {
        kind: "system",
        actor: "self-improvement",
        correlationId: `${feedback.chatId}:${feedback.telegramMessageId}`,
      },
      inputSummary: `${feedback.reaction === "up" ? "👍" : "👎"} ${feedback.feedback}`,
    }
  );
  try {
    // How the reply was produced is the evidence. Without it (an old or purged
    // trace) the bot still reflects, but only on the exchange itself — a thinner
    // answer, and one the operator can see is thinner.
    const replyTrace = await getReplyTrace(
      deps.ports.messages,
      feedback.chatId,
      feedback.telegramMessageId,
    );
    const evidence = replyTrace ? renderReplyTrace(replyTrace) : null;
    if (evidence) {
      await trace.event({
        type: "step",
        message: "reply trace loaded",
        data: { traceId: replyTrace?.id, evidence },
      });
    } else {
      await trace.event({
        type: "step",
        level: "warn",
        message: "no reply trace — reflecting on the exchange alone",
        data: { traceId: replyTrace?.id ?? null },
      });
    }
    const context = evidence ?? (await renderExchange(deps.ports.messages, feedback));

    const persona = personaContext(deps.personalityPrompt);
    const messages: ChatMessage[] = [
      { role: "system", content: REFLECTION_PROMPT },
      ...(persona ? [{ role: "system" as const, content: persona }] : []),
      { role: "user", content: `${context}\n\n${feedbackBlock(feedback)}` },
    ];
    let result: ChatCompletionResult;
    try {
      result = await deps.complete(messages, {
        recorder: trace,
        callKind: "self-improve-reflect",
      });
    } catch (err) {
      await trace.event({
        type: "error",
        level: "warn",
        message: "reflection call failed — left for the next incorporation run",
        data: { error: err instanceof Error ? err.message : String(err) },
      });
      await trace.skip("reflection call failed");
      return null;
    }

    const reflection = result.content.trim();
    if (!reflection) {
      await trace.skip("empty reflection — left for the next incorporation run");
      return null;
    }
    const model = normalizeModelName(result.model ?? deps.model);
    await deps.ports.feedbacks.patch(feedback.id, { reflection, reflectionModel: model });
    await trace.event({
      type: "db",
      level: "success",
      message: "reflection stored",
      data: { feedbackId: feedback.id, reflection, model },
    });

    publishEvent(FEATURE.realtimeTopic);
    await trace.succeed({
      outputSummary: reflection,
      relatedIds: { [FEATURE.relatedIdsKey]: [feedback.id] },
    });
    return reflection;
  } catch (err) {
    await trace.fail(err);
    return null;
  }
}

/**
 * The real collaborators for a reflection, or null when no LLM is configured
 * or the source API is unreachable from env (nothing to reflect with / no
 * rows to reach — the daily job retries once both are).
 */
export async function resolveReflectionDeps(): Promise<ReflectionDeps | null> {
  const ports = resolveFeedbackPorts();
  if (!ports) return null;
  const runtime = await getBackgroundRuntime().catch(() => null);
  if (!runtime) return null;
  const conn = { baseUrl: runtime.baseUrl, apiKey: runtime.apiKey, backend: runtime.backend };
  // Transitional (see the assistants service): no event names an assistant
  // here, so only a single-assistant deployment composes one as context.
  const personalityPrompt = await getSingleAssistantPersona().catch(() => null);
  return {
    complete: (messages, trace) =>
      chatCompletion(conn, {
        model: runtime.model,
        messages,
        priority: "background",
        ...(trace ? { trace } : {}),
      }),
    personalityPrompt,
    model: runtime.model,
    ports,
  };
}
