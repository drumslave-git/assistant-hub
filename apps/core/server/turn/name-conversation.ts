import "server-only";

import type { InboundMessageEvent } from "@assistant-hub-swarm/contracts";

import { getClassifierRuntime } from "@/features/settings/server/service";
import { runClassifier } from "@/server/llm/classifier";
import { startTrace } from "@/server/trace";

import type { SourceOutboundPort } from "./source-outbound";

/**
 * Naming a conversation from what was said in it.
 *
 * Some sources have real names for their conversations — a Telegram group has
 * a title, a DM has a person — and never ask for this. A web thread has
 * neither: it starts as "New chat", which is a placeholder, not a name. Rather
 * than make someone title a conversation before having it, the source marks
 * the name provisional (`chat.titleProvisional`) and the core names it once,
 * after the first exchange, through that source's own `setChatTitle`.
 *
 * A classification call, not a conversation: no persona, no history, no tools
 * — the same shape as the addressing analyzer and the honesty gate, and the
 * same cheap runtime.
 */

/** What a title may cost. A few words; the cap is a runaway stop. */
const TITLE_MAX_TOKENS = 200;
const TITLE_TIMEOUT_MS = 15_000;

/** The store's own limit for a thread name. */
const TITLE_MAX_CHARS = 120;

const SYSTEM_PROMPT = [
  "You name conversations.",
  "Given the first exchange of one, reply with a short title for it: three to six words,",
  "in the language the conversation is in, naming its subject.",
  "Reply with the title alone — no quotes, no trailing punctuation, no prefix like",
  '"Title:", and never a sentence about the conversation.',
].join(" ");

/**
 * Name the conversation this turn belongs to, when its source asked for one
 * and this is the first exchange. Best-effort by design: a thread keeps its
 * placeholder if anything here fails, which is a cosmetic loss, and the caller
 * never waits on it before delivering the reply.
 *
 * Returns the stored title, or null when nothing was named.
 */
export async function nameConversation(input: {
  event: InboundMessageEvent;
  outbound: SourceOutboundPort | null;
  /** What the person said, and what the assistant answered. */
  question: string;
  answer: string;
  /** Test seam: a title without a configured classifier endpoint. */
  generateTitle?: (exchange: { question: string; answer: string }) => Promise<string | null>;
}): Promise<string | null> {
  const { event, outbound } = input;
  // Only a source that asked, only a source that can be told, and only the
  // first exchange — a window with history has been named already (or is a
  // conversation whose name someone chose).
  if (!event.chat.titleProvisional) return null;
  if (!outbound?.setChatTitle) return null;
  if (event.context.history.length > 0) return null;
  const question = input.question.trim();
  const answer = input.answer.trim();
  if (!question && !answer) return null;

  const runtime = input.generateTitle
    ? null
    : await getClassifierRuntime().catch(() => null);
  if (!runtime && !input.generateTitle) return null;

  const chatId = event.chat.ref.slice(event.chat.ref.lastIndexOf(":") + 1);
  // Its own trace, on the turn's correlation: the reply trace has settled by
  // the time this runs (naming happens after delivery), and Debug's flow still
  // shows the two together.
  const trace = await startTrace({
    feature: "bot-messaging",
    action: "name-conversation",
    assistantId: event.assistantId,
    trigger: {
      kind: event.source === "chat" ? "chat" : "transport",
      actor: chatId,
      correlationId: event.correlationId,
    },
    inputSummary: question,
  });
  try {
    const generated = input.generateTitle
      ? {
          content: await input.generateTitle({ question, answer }),
          model: "(injected)",
          latencyMs: 0,
        }
      : await runClassifier(
          runtime!,
          [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: `Person: ${question}\nAssistant: ${answer}` },
          ],
          { maxTokens: TITLE_MAX_TOKENS, timeoutMs: TITLE_TIMEOUT_MS },
        );
    // The model's words, bounded to what the field holds — the first line so a
    // model that adds a second one cannot smuggle a paragraph into a label.
    const title = (generated.content ?? "").trim().split("\n")[0].trim().slice(0, TITLE_MAX_CHARS);
    if (!title) {
      await trace.skip("the model returned no title — the placeholder stands");
      return null;
    }

    trace.event({
      type: "llm_response",
      message: "title generated",
      data: { title, model: generated.model, latencyMs: generated.latencyMs },
    });
    const stored = await outbound.setChatTitle(chatId, title);
    await trace.succeed({ outputSummary: stored.title });
    return stored.title;
  } catch (err) {
    // Cosmetic by nature: a thread keeping its placeholder is a worse label,
    // not a worse answer — so this never fails the turn.
    await trace.fail(err);
    return null;
  }
}
