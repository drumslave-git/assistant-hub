import "server-only";

import {
  parseScopedRef,
  type ReplyDeliveryEvent,
  type TurnLifecycleEvent,
} from "@assistant-hub-swarm/contracts";

import { withTrace } from "@/server/trace";

import { appendMessage, getThreadById } from "./repository";
import { pingThreads } from "./service";
import { threadTurns } from "./turns";

/**
 * The web chat's half of the turn's outbound events, consumed in-process
 * since the dissolve (the chat app's bus consumer, relocated): the pipeline
 * publishes `reply.delivery` and `turn.lifecycle` for every source on the
 * bus, tg's app consumes its own, and the core consumes the web chat's here
 * (wired in `server/source/events-consumer.ts`).
 *
 * "Delivering" to a web thread is storing the reply and pinging the
 * dashboard, because the thread is already on screen — there is no platform
 * to hand it to. The trace, the correlation and the refresh ping are what tg
 * records for its sends, which is why the model never has to remember to
 * send its own answer here either.
 *
 * The lifecycle events are this source's typing indicator: they update the
 * running-turn state the thread API serves, and each change pings the
 * dashboard so the browser re-reads and shows what the turn is doing. A
 * settle also pings on its own, so a finished turn shows up even if a
 * delivery ping was missed.
 */

/** Store one delivered reply in its thread, under the turn's own trace. */
export async function handleChatReplyDelivery(event: ReplyDeliveryEvent): Promise<void> {
  const threadId = parseScopedRef(event.chatRef).id;
  await withTrace(
    {
      feature: "bot-messaging",
      action: "deliver",
      assistantId: event.assistantId,
      trigger: { kind: "chat", actor: threadId, correlationId: event.correlationId },
      inputSummary: event.text,
    },
    async (trace) => {
      const thread = await getThreadById(threadId);
      if (!thread) {
        // The thread was deleted while the turn ran. Nothing to store and
        // nowhere to show it — said out loud rather than swallowed.
        await trace.succeed({ outputSummary: `thread ${threadId} is gone — reply dropped` });
        return;
      }
      const stored = await appendMessage({
        threadId,
        role: "assistant",
        content: event.text,
        replyToMessageId:
          event.replyToSourceMessageId != null ? Number(event.replyToSourceMessageId) : null,
      });
      await trace.event({
        message: "reply stored in the thread",
        type: "db",
        level: "success",
        data: {
          messageId: stored.id,
          replyToMessageId: stored.replyToMessageId,
          // A web thread has no notification to suppress; the flag is
          // recorded so a silent reply is legible in Debug all the same.
          silent: event.silent,
        },
      });
      pingThreads();
      await trace.succeed({ outputSummary: `delivered ${threadId}:${stored.id}` });
    },
  );
}

/** Apply one lifecycle event to the running-turn state the thread view reads. */
export function handleChatTurnLifecycle(event: TurnLifecycleEvent): void {
  const threadId = parseScopedRef(event.chatRef).id;
  const changed = threadTurns().apply(threadId, event);
  // Ping on a visible change, and always on settle: the last ping is what
  // clears "thinking…" and shows the finished transcript.
  if (changed || event.phase === "settled") pingThreads();
}
