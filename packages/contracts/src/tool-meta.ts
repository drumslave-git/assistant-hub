import { z } from "zod";

import { sourceIdSchema } from "./source-events";

/**
 * The turn binding that travels with an MCP tool call as request `_meta`.
 *
 * A tool hosted by another app (a source app's own MCP server) has no ambient
 * turn state, and the model must not be handed one either: if "which chat" or
 * "which assistant" were arguments, a model could aim an action at a
 * conversation nobody invited it into. So the core attaches the binding out of
 * band — invisible in the tool schema, carried on every call — and the hosting
 * app reads it from the request metadata.
 *
 * Namespaced under one key: `_meta` is a shared bag, and MCP reserves the
 * `modelcontextprotocol.io/` prefix for its own use.
 */
export const TURN_META_KEY = "assistant-hub/turn";

export const turnToolMetaSchema = z.object({
  /** The source app the turn belongs to; the app hosting the tool. */
  source: sourceIdSchema,
  /** Source-local chat id (a telegram chat id, a web thread uuid). */
  chatId: z.string(),
  /** The assistant acting in this turn, when the turn has one. */
  assistantId: z.string().nullable().optional(),
  /** Source-local sub-thread (a forum topic), when the chat has them. */
  threadId: z.number().nullable().optional(),
  /** The message this turn is answering, for a tool that attaches a reply. */
  replyToMessageId: z.number().nullable().optional(),
  /** The turn's trace correlation, so a hosted tool's work joins the turn. */
  correlationId: z.string().optional(),
  /** The speaker, when the turn has one (a fire does not). */
  userId: z.string().nullable().optional(),
  /** Owner rights as the source stamped them on the inbound event. */
  senderIsOwner: z.boolean().optional(),
});

export type TurnToolMeta = z.infer<typeof turnToolMetaSchema>;

/** Wrap a turn binding as the `_meta` object of a tool call. */
export function turnMetaEnvelope(meta: TurnToolMeta): Record<string, unknown> {
  return { [TURN_META_KEY]: meta };
}

/**
 * Read the turn binding out of a request's `_meta`, or null when the call
 * carries none (a client that is not this hub) or carries a malformed one. A
 * hosted tool refuses in that case rather than guessing a chat.
 */
export function readTurnMeta(meta: unknown): TurnToolMeta | null {
  if (!meta || typeof meta !== "object") return null;
  const raw = (meta as Record<string, unknown>)[TURN_META_KEY];
  const parsed = turnToolMetaSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
