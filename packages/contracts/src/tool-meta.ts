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
  threadId: z.string().nullable().optional(),
  /** The message this turn is answering, for a tool that attaches a reply. */
  replyToSourceMessageId: z.string().nullable().optional(),
  /** The turn's trace correlation, so a hosted tool's work joins the turn. */
  correlationId: z.string().optional(),
  /** The speaker, when the turn has one (a fire does not). */
  userId: z.string().nullable().optional(),
  /** Owner rights as the source stamped them on the inbound event. */
  senderIsOwner: z.boolean().optional(),
  /**
   * Which delivery this turn may perform, when it may perform one at all: a
   * turn opened by a message answers it (`reply`), a timed fire speaks
   * unprompted (`send`), and an ordinary reply turn delivers its own text and
   * so carries neither. The core withholds the tool that does not match, and
   * the hosting app refuses it as well — the same double boundary the
   * core-hosted delivery tools had, now spanning two processes.
   */
  deliveryKind: z.enum(["reply", "send"]).nullable().optional(),
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

/**
 * What a hosted tool reports when it delivered (or tried to deliver) a
 * message, carried in the call's `structuredContent`.
 *
 * The core needs to know a send happened — a task stamps its wording, a fire
 * counts what actually reached the chat — and it must learn that from the
 * call's RESULT rather than by recognizing a tool name. A name-based hook
 * would break the moment a source called its tool something else; a result
 * shape any source can report keeps the bookkeeping general.
 */
export const toolDeliverySchema = z.object({
  /** False = the platform refused the send; the tool reports the reason. */
  ok: z.boolean(),
  /** The delivered message's own id, when it landed. */
  sourceMessageId: z.string().nullable().optional(),
  /** Exactly what was sent, as the chat reads it. */
  text: z.string(),
});

export type ToolDelivery = z.infer<typeof toolDeliverySchema>;

/** The key a delivery rides under in a tool result's structured content. */
export const TOOL_DELIVERY_KEY = "delivery";

/** Wrap a delivery for a tool result's `structuredContent`. */
export function toolDeliveryResult(delivery: ToolDelivery): Record<string, unknown> {
  return { [TOOL_DELIVERY_KEY]: delivery };
}

/** The delivery a tool result reports, or null when it reports none. */
export function readToolDelivery(structuredContent: unknown): ToolDelivery | null {
  if (!structuredContent || typeof structuredContent !== "object") return null;
  const raw = (structuredContent as Record<string, unknown>)[TOOL_DELIVERY_KEY];
  const parsed = toolDeliverySchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
