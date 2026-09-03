import { scopedRef, turnCorrelationId } from "@assistant-hub-swarm/contracts";

import type { CoreApi } from "./core-api";
import type { SendContext } from "./send";
import { updateEnvelope } from "./updates";

/**
 * Reacting to a message, minus the emoji.
 *
 * Which emoji a platform allows, whether it has a "big" variant and how the
 * model should be told about the set are all the transport's — so each one
 * registers its own reaction TOOL. What is the same everywhere is what
 * happens around the platform call, and that is here:
 *
 * - the mirror gates it. An id the model guessed, or the assistant's own
 *   message, is refused before the platform is touched at all. Reacting to
 *   yourself is the one target that is never right, and every platform would
 *   happily allow it.
 * - the badge is recorded. Without a `transport.bot-reaction` the next turn
 *   does not remember reacting and says so out loud (operator report,
 *   2026-08-15) — and a failed record must read as a missing memory, not as
 *   a platform refusal, because the reaction IS on the message.
 */

export type ReactionStatus = "ok" | "not_found" | "own_message";

export interface ReactionOutcome {
  status: ReactionStatus;
  /** Whether the mirror remembers it; a failed record is cosmetic. */
  recorded: boolean;
}

export async function reactToMessage(
  ctx: Pick<SendContext, "descriptor" | "publisher" | "running" | "connectionFor"> & {
    core: CoreApi;
  },
  input: {
    chatId: string;
    sourceMessageId: string;
    /** Already canonical for this platform, or null to take the badge back. */
    emoji: string | null;
    assistantId: string | null;
    /** Platform-specific extras passed straight through to the connection. */
    options?: Record<string, unknown>;
  },
): Promise<ReactionOutcome> {
  const source = ctx.descriptor.id;
  const connection = ctx.connectionFor(input.assistantId);
  if (!connection.setReaction) {
    throw new Error(`${ctx.descriptor.name} cannot set reactions`);
  }
  const direct = await connection.isDirectChat(input.chatId).catch(() => false);

  const target = await ctx.core.lookupMessage({
    chatId: input.chatId,
    sourceMessageId: input.sourceMessageId,
    assistantId: input.assistantId,
    direct,
  });
  if (!target.found) return { status: "not_found", recorded: false };
  // `assistant` is exactly this bot's own output in the mirror — another
  // bot's message arrives as an ordinary `user` row and stays fair game.
  if (target.role === "assistant") return { status: "own_message", recorded: false };

  // A platform refusal throws with its own words: swallowing it would leave
  // the model telling the chat it reacted.
  await connection.setReaction(input.chatId, input.sourceMessageId, input.emoji, input.options);

  try {
    await ctx.publisher.publish({
      ...updateEnvelope(
        turnCorrelationId(scopedRef(source, "chat", input.chatId), input.sourceMessageId),
      ),
      type: "transport.bot-reaction",
      source,
      chat: { id: input.chatId, kind: direct ? "direct" : "group" },
      assistantId: input.assistantId,
      sourceMessageId: input.sourceMessageId,
      emoji: input.emoji,
    });
    return { status: "ok", recorded: true };
  } catch {
    return { status: "ok", recorded: false };
  }
}
