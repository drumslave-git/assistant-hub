import "server-only";

import { randomUUID } from "node:crypto";

import { openWorker } from "@assistant-hub/bus";
import {
  TRANSPORT_UPDATES_QUEUE,
  inboundMessageEventSchema,
  scopedRef,
  transportUpdateEventSchema,
  turnCorrelationId,
  type Addressing,
  type InboundMessageEvent,
  type MessageDeliveredEvent,
  type SourceId,
  type TransportBotReactionEvent,
  type TransportEditEvent,
  type TransportMessageEvent,
  type TransportPresenceEvent,
  type TransportReactionEvent,
  type TransportReceiver,
} from "@assistant-hub/contracts";
import { normalizeImageForChat } from "@assistant-hub/media";
import type { Worker } from "bullmq";

import { formatKnownUserLabel } from "@/features/known-users/format";
import {
  captureFeedbackReply,
  processReactionUpdate,
} from "@/features/self-improvement/server/collect-flows";
import { collectTransport } from "@/features/self-improvement/server/collect-transport";
import { redeemLinkCode, selfLinkReplyText } from "@/features/accounts/server/self-link";
import { getEnv } from "@/server/env";
import { publishEvent } from "@/server/realtime/hub";
import {
  appendSourceMessage,
  applySourceMessageEdit,
  getSourceMessage,
  getSourceMediaForMessages,
  getSourceUserById,
  listChatAssistants,
  markSourceMessageProcessed,
  recordBotReaction,
  stampAssistantPresence,
  upsertSourceChatActivity,
  upsertSourceUser,
} from "@/server/source-store/repository";
import { insertSourceMedia, insertUnavailableSourceMedia } from "@/server/source-store/media";
import { withTrace } from "@/server/trace";
import { enqueueInboundEvent } from "@/server/turn/enqueue";
import { sourceOutbound } from "@/server/turn/source-outbound";

import { resolveOwnerRights } from "@/server/owner-rights";
import { silencedAssistantIds } from "@/server/ownership";

import { buildChatInfo, buildConversationContext, buildSenderInfo } from "./context";

/**
 * The core's ingest stage (redesign Phase 7): consume the transport-update
 * queue, persist everything into the conversation store, resolve the
 * audience from core-owned presence, compose the conversation context, and
 * hand the pipeline its turn events — the same `message.inbound` shape it
 * always consumed, so `processInboundEvent` never noticed the store moved.
 *
 * Ordering: per-chat sequential, cross-chat concurrent (the same guarantee
 * every stage of the pipeline keeps) — an in-process promise chain per
 * `(source, chat)` key, jobs picked FIFO.
 */

/** The event ONE receiver gets for a fresh inbound message. */
async function buildTurnEvent(
  event: TransportMessageEvent,
  receiver: TransportReceiver,
): Promise<InboundMessageEvent> {
  const source = event.source;
  const chatId = event.chat.id;
  const direct = event.chat.kind === "direct";
  const scope = { source, chatId, assistantId: receiver.assistantId, direct };
  const senderRef = scopedRef(source, "user", event.sender.userId);
  const [chatInfo, sender, context] = await Promise.all([
    buildChatInfo(source, event.chat),
    // Owner rights are per receiving assistant (Phase 8): the sender's linked
    // account against this assistant's owner, admins everywhere.
    resolveOwnerRights({ senderRef, assistantId: receiver.assistantId }).then((isOwner) =>
      buildSenderInfo(source, event.sender, isOwner),
    ),
    buildConversationContext(scope, {
      senderId: event.sender.userId,
      excludeSourceMessageId: event.message.sourceMessageId,
    }),
  ]);

  const replyTo = event.message.replyTo ?? null;
  // Anchors are chat-wide in a group and single-stream in a DM, so the
  // stored check runs per receiver's scope.
  const replyTargetStored = replyTo
    ? (await getSourceMessage(scope, replyTo.sourceMessageId)) != null
    : false;
  const media = replyTo
    ? await getSourceMediaForMessages(source, chatId, [replyTo.sourceMessageId])
    : new Map<string, unknown>();
  const ownMedia = await getSourceMediaForMessages(source, chatId, [
    event.message.sourceMessageId,
  ]);
  const stored = ownMedia.get(event.message.sourceMessageId) as
    | { id: string; kind: string; description: string | null; status: string }
    | undefined;

  const fromAssistant = replyTo?.authorAssistantId === receiver.assistantId;
  return inboundMessageEventSchema.parse({
    v: 1,
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    // One turn = one assistant acting on one message: several assistants can
    // be handed the same message, and their markers and traces must not
    // collide.
    correlationId: turnCorrelationId(
      chatId,
      event.message.sourceMessageId,
      receiver.assistantId,
    ),
    type: "message.inbound",
    source,
    assistantId: receiver.assistantId,
    connection: receiver.identity,
    chat: chatInfo,
    sender,
    addressing: receiver.addressing,
    message: {
      sourceMessageId: event.message.sourceMessageId,
      content: event.message.content,
      sentAt: event.message.sentAt,
      threadId: event.message.threadId ?? null,
      replyTo: replyTo
        ? {
            sourceMessageId: replyTo.sourceMessageId,
            stored: replyTargetStored,
            hasMedia: replyTo.hasMedia || media.has(replyTo.sourceMessageId),
            senderLabel:
              fromAssistant || !replyTo.author ? null : formatKnownUserLabel(replyTo.author),
            fromAssistant,
            text: replyTo.text,
            quote: replyTo.quote ?? null,
          }
        : null,
      media: stored
        ? [
            {
              id: stored.id,
              kind: stored.kind,
              description: stored.description,
              status: stored.status as "pending" | "described" | "unavailable",
            },
          ]
        : [],
    },
    context,
  } satisfies InboundMessageEvent);
}

/** Persist the media a message update carried, best-effort. */
async function storeEventMedia(event: TransportMessageEvent): Promise<void> {
  const media = event.media;
  if (!media) return;
  if (media.unavailable || media.frames.length === 0) {
    await insertUnavailableSourceMedia({
      id: randomUUID(),
      source: event.source,
      chatId: event.chat.id,
      sourceMessageId: event.message.sourceMessageId,
      kind: media.kind,
      fileId: media.fileId,
      fileUniqueId: media.fileUniqueId,
      visionHint: media.visionHint,
    }).catch(() => undefined);
    return;
  }
  await insertSourceMedia({
    id: randomUUID(),
    source: event.source,
    chatId: event.chat.id,
    sourceMessageId: event.message.sourceMessageId,
    kind: media.kind,
    fileId: media.fileId,
    fileUniqueId: media.fileUniqueId,
    mimeType: media.mimeType,
    visionHint: media.visionHint,
    frames: media.frames,
  }).catch(() => undefined);
}

/**
 * Who gets a turn for this message. A direct chat is between one person and
 * one bot: the receiving connection alone. A group is every assistant
 * listening there — presence rows intersected with the connections running
 * right now, with the receiving connection re-added defensively so a
 * presence read that comes back empty can never cost the bot that actually
 * got the update its turn.
 */
async function resolveReceivers(event: TransportMessageEvent): Promise<TransportReceiver[]> {
  // Offboarding (Phase 9): a deactivated account's assistants answer
  // nothing, even while a poller is still winding down.
  const silenced = await silencedAssistantIds();
  const receivers = event.receivers.filter((r) => !silenced.has(r.assistantId));
  const self = receivers.find((r) => r.assistantId === event.receivedBy);
  const selfList = self ? [self] : [];
  if (event.chat.kind === "direct") return selfList;
  const present = new Set(
    await listChatAssistants(event.source, event.chat.id).catch(() => [] as string[]),
  );
  const listening = receivers.filter((r) => present.has(r.assistantId));
  if (self && !listening.some((r) => r.assistantId === self.assistantId)) {
    return [...selfList, ...listening];
  }
  return listening;
}

/** Handle one fresh inbound platform message. */
async function handleTransportMessage(event: TransportMessageEvent): Promise<void> {
  const source = event.source;
  const chatId = event.chat.id;
  const direct = event.chat.kind === "direct";

  // Remember every human sender + mirror every human message (addressed or
  // not) so the operator sees who talks to the bot and the window holds the
  // whole running conversation. Mirror first, in insertion order.
  await upsertSourceUser({
    source,
    userId: event.sender.userId,
    username: event.sender.username,
    firstName: event.sender.firstName,
    lastName: event.sender.lastName,
  });
  if (!direct) {
    await upsertSourceChatActivity({
      source,
      chatId,
      title: event.chat.title ?? null,
      type: event.chat.type ?? "group",
      userId: event.sender.userId,
      // The platform delivered this chat's traffic to THIS connection — the
      // evidence the fan-out and the cross-feed read.
      assistantId: event.receivedBy,
    });
  }

  // `processed: false` takes the live-processing hold; the settle handler
  // releases it (and the media backfill's expiry covers a turn that never
  // does).
  const mirrored = await appendSourceMessage({
    source,
    chatId,
    // A DM row belongs to the receiving bot's conversation with the peer; a
    // group row is the shared stream.
    assistantId: direct ? event.receivedBy : null,
    sourceMessageId: event.message.sourceMessageId,
    dedupeKey: event.dedupeKey,
    role: "user",
    userId: event.sender.userId,
    content: event.message.content,
    replyToSourceMessageId: event.message.replyTo?.sourceMessageId ?? null,
    sentAt: new Date(event.message.sentAt),
    processed: false,
  });
  if (!mirrored) {
    // Idempotency: a re-delivered update was already mirrored — and its
    // turns already enqueued. Presence was stamped above regardless.
    return;
  }

  publishEvent("history");
  publishEvent("users");
  if (!direct) publishEvent("groups");

  // Feedback capture: a reply to an `awaiting_text` feedback menu from the
  // reactor is the free-text answer to the 👍/👎 menu — record it and stop,
  // the message is not a turn to answer (it stays mirrored above). The hold
  // is released since no turn will ever settle it.
  const replyTo = event.message.replyTo;
  if (replyTo && event.message.content.trim()) {
    const transport = collectTransport(source);
    if (transport) {
      const captured = await captureFeedbackReply(
        {
          chatId,
          menuSourceMessageId: replyTo.sourceMessageId,
          userId: event.sender.userId,
          text: event.message.content,
        },
        { source, assistantId: event.receivedBy, transport },
      ).catch(() => null);
      if (captured) {
        await releaseHold(source, chatId, event.message.sourceMessageId, event.receivedBy);
        return;
      }
    }
  }

  // Self-link codes (Phase 8): a message that IS a profile-minted code
  // links this platform identity to its account instead of opening a turn.
  // Checked after feedback capture; whatever the outcome, the code-shaped
  // message is consumed and answered, never sent to the model.
  const selfLink = await redeemLinkCode({
    senderRef: scopedRef(source, "user", event.sender.userId),
    text: event.message.content,
  }).catch(() => null);
  if (selfLink) {
    const port = sourceOutbound(source);
    await port
      ?.sendMessage(chatId, {
        text: selfLinkReplyText(selfLink),
        replyToMessageId: Number(event.message.sourceMessageId) || null,
        assistantId: event.receivedBy,
      })
      .catch((err) => {
        console.error(
          "self-link confirmation send failed:",
          err instanceof Error ? err.message : String(err),
        );
      });
    await releaseHold(source, chatId, event.message.sourceMessageId, event.receivedBy);
    return;
  }

  // Ingest media after the mirror. A media message whose payload could not
  // be stored still opens turns — the pipeline answers from the text.
  await storeEventMedia(event);

  const receivers = await resolveReceivers(event);
  const turns: InboundMessageEvent[] = [];
  for (const receiver of receivers) {
    const turnEvent = await buildTurnEvent(event, receiver);
    await enqueueInboundEvent(turnEvent);
    turns.push(turnEvent);
  }

  // The ingest half of the turn, correlated like the reply trace — recorded
  // only when the message actually opened turns (plain mirrored chatter
  // leaves nothing behind; the v1 noise rule).
  if (turns.length > 0) {
    await withTrace(
      {
        feature: "bot-messaging",
        action: "inbound",
        assistantId: event.receivedBy,
        trigger: {
          kind: "telegram",
          actor: event.sender.userId,
          correlationId: turnCorrelationId(
            chatId,
            event.message.sourceMessageId,
            event.receivedBy,
          ),
        },
        inputSummary: event.message.content || "(media)",
      },
      async (trace) => {
        await trace.event({
          message:
            turns.length > 1
              ? `inbound event enqueued for ${turns.length} assistants`
              : "inbound event enqueued",
          type: "output",
          level: "success",
          data: {
            turns: turns.map((turn) => ({
              assistantId: turn.assistantId,
              eventId: turn.eventId,
              correlationId: turn.correlationId,
              addressed: turn.addressing.addressed,
            })),
          },
        });
        await trace.succeed({
          outputSummary:
            turns.length > 1
              ? `enqueued for the pipeline (${turns.length} assistants)`
              : "enqueued for the pipeline",
        });
      },
    ).catch(() => undefined);
  }
}

/**
 * The same structural verdict for a message the cross-feed hands to another
 * assistant. It never came off the wire for that bot, so there are no
 * entities to read: what remains is whether the author answered one of the
 * target's own messages, and whether the text spells its handle. Everything
 * else is undecided — the pipeline runs the name check and the analyzer.
 */
function checkCrossFedAddressed(input: {
  text: string;
  botUsername: string;
  repliesToOwnMessage: boolean;
}): Addressing {
  if (input.repliesToOwnMessage) {
    return {
      addressed: true,
      source: "reply",
      needsAnalyzer: false,
      reason: "this assistant's own message was answered",
    };
  }
  const user = input.botUsername.toLowerCase();
  if (user && input.text.toLowerCase().includes(`@${user}`)) {
    return {
      addressed: true,
      source: "mention",
      needsAnalyzer: false,
      reason: "the other assistant's message @mentions this bot's username",
    };
  }
  if (input.text.trim()) {
    return {
      addressed: false,
      needsAnalyzer: true,
      reason: "nothing in the message structure names this bot — over to the name check",
    };
  }
  return { addressed: false, needsAnalyzer: false };
}

/**
 * Feed a delivered assistant message to the other assistants in its chat —
 * the cross-feed, core-owned since the store moved in. Mechanical gates
 * unchanged: group chats only, an attributable author, text present, never a
 * silent send.
 */
async function crossFeedDelivered(event: MessageDeliveredEvent): Promise<void> {
  if (event.chat.kind !== "group") return;
  if (!event.assistantId || event.silent || !event.content.trim()) return;
  const author = event.running.find((c) => c.assistantId === event.assistantId);
  if (!author) return;
  const present = new Set(
    await listChatAssistants(event.source, event.chat.id).catch(() => [] as string[]),
  );
  const targets = event.running.filter(
    (c) => c.assistantId !== event.assistantId && present.has(c.assistantId),
  );
  if (targets.length === 0) return;

  const chatId = event.chat.id;
  const replyRow =
    event.replyToSourceMessageId != null
      ? await getSourceMessage(
          { source: event.source, chatId, assistantId: null, direct: false },
          event.replyToSourceMessageId,
        )
      : null;
  const replySender = replyRow?.userId
    ? await getSourceUserById(event.source, replyRow.userId)
    : null;
  const replyMedia =
    event.replyToSourceMessageId != null
      ? await getSourceMediaForMessages(event.source, chatId, [event.replyToSourceMessageId])
      : new Map<string, unknown>();

  for (const target of targets) {
    try {
      const repliesToOwnMessage =
        replyRow?.role === "assistant" && replyRow.assistantId === target.assistantId;
      const [chatInfo, context] = await Promise.all([
        buildChatInfo(event.source, event.chat),
        buildConversationContext(
          // Group history is the shared stream — every assistant's lines
          // included, each attributed by the row's own assistant id.
          { source: event.source, chatId, assistantId: null, direct: false },
          { senderId: null, excludeSourceMessageId: event.sourceMessageId },
        ),
      ]);
      const turnEvent = inboundMessageEventSchema.parse({
        v: 1,
        eventId: randomUUID(),
        occurredAt: new Date().toISOString(),
        correlationId: turnCorrelationId(chatId, event.sourceMessageId, target.assistantId),
        type: "message.inbound",
        source: event.source,
        assistantId: target.assistantId,
        connection: target.identity,
        chat: chatInfo,
        // The author's bot ACCOUNT — the pipeline resolves the speaking
        // assistant's own name from `authoredByAssistantId` and never treats
        // this ref as a person.
        sender: {
          ref: scopedRef(event.source, "user", author.botId),
          isOwner: false,
          label: author.identity.botDisplayName,
          username: author.identity.botUsername,
          firstName: author.identity.botDisplayName,
          lastName: null,
          aliases: [],
          language: null,
        },
        authoredByAssistantId: event.assistantId,
        addressing: checkCrossFedAddressed({
          text: event.content,
          botUsername: target.identity.botUsername,
          repliesToOwnMessage,
        }),
        message: {
          sourceMessageId: event.sourceMessageId,
          content: event.content,
          sentAt: event.sentAt,
          threadId: event.threadId ?? null,
          replyTo:
            event.replyToSourceMessageId != null
              ? {
                  sourceMessageId: event.replyToSourceMessageId,
                  stored: replyRow != null,
                  hasMedia: replyMedia.has(event.replyToSourceMessageId),
                  senderLabel: replySender ? formatKnownUserLabel(replySender) : null,
                  fromAssistant: repliesToOwnMessage,
                  text: replyRow?.content ?? null,
                  quote: null,
                }
              : null,
          media: [],
        },
        context,
      } satisfies InboundMessageEvent);
      await enqueueInboundEvent(turnEvent);
    } catch (error) {
      // One deaf assistant must not cost the others their turn, and never
      // the delivery that triggered this.
      console.error(
        `cross-feed of ${chatId}:${event.sourceMessageId} to ${target.assistantId} failed:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

/** Mirror a delivered assistant message; cross-feed a genuinely new row. */
async function handleDelivered(event: MessageDeliveredEvent): Promise<void> {
  const direct = event.chat.kind === "direct";
  const row = await appendSourceMessage({
    source: event.source,
    chatId: event.chat.id,
    assistantId: event.assistantId,
    sourceMessageId: event.sourceMessageId,
    dedupeKey: event.dedupeKey,
    role: "assistant",
    userId: null,
    content: event.content,
    replyToSourceMessageId: event.replyToSourceMessageId ?? null,
    sentAt: new Date(event.sentAt),
    processed: true,
  });
  publishEvent("history");
  if (!row) return;

  // A generated image the send delivered: stored as ordinary pending media,
  // keyed by the file id the platform minted, so the describer recognizes
  // what the bot drew exactly like a user-sent picture.
  if (event.image) {
    const normalized = await normalizeImageForChat(event.image.base64).catch(() => null);
    if (normalized) {
      await insertSourceMedia({
        id: randomUUID(),
        source: event.source,
        chatId: event.chat.id,
        sourceMessageId: event.sourceMessageId,
        kind: "photo",
        fileId: event.image.fileId,
        fileUniqueId: event.image.fileUniqueId,
        mimeType: normalized.mimeHint,
        visionHint:
          "This image was generated by the bot itself, in response to a request in this chat.",
        frames: [normalized.base64],
      }).catch(() => undefined);
    }
  }

  if (!direct) {
    // Detached from the delivery: the message is already sent and mirrored,
    // and a cross-feed failure must not undo either.
    void crossFeedDelivered(event).catch(() => undefined);
  }
}

async function handleEdit(event: TransportEditEvent): Promise<void> {
  await applySourceMessageEdit(
    {
      source: event.source,
      chatId: event.chat.id,
      assistantId: event.assistantId,
      direct: event.chat.kind === "direct",
    },
    {
      sourceMessageId: event.sourceMessageId,
      content: event.content,
      editedAt: new Date(event.editedAt),
    },
  );
  publishEvent("history");
}

async function handleReaction(event: TransportReactionEvent): Promise<void> {
  const transport = collectTransport(event.source);
  if (!transport) return;
  // Remember the reactor — the feedback row FKs nothing, but the dashboard
  // names them from the directory.
  await upsertSourceUser({
    source: event.source,
    userId: event.user.userId,
    username: event.user.username,
    firstName: event.user.firstName,
    lastName: event.user.lastName,
  }).catch(() => undefined);
  await withTrace(
    {
      feature: "self-improvement",
      action: "collect-feedback",
      assistantId: event.assistantId,
      trigger: {
        kind: "telegram",
        actor: event.user.userId,
        correlationId: `${event.chat.id}:${event.sourceMessageId}`,
      },
      inputSummary: "reaction on a bot reply",
    },
    async (trace) => {
      const outcome = await processReactionUpdate(event, {
        source: event.source,
        assistantId: event.assistantId,
        transport,
      });
      if (outcome.status === "menu_sent") {
        await trace.event({
          message: "feedback menu sent",
          type: "output",
          level: "success",
          data: { feedbackId: outcome.feedback.id, reaction: outcome.feedback.reaction },
        });
        await trace.succeed({ outputSummary: `menu sent (${outcome.feedback.reaction})` });
      } else {
        await trace.skip(undefined, { outputSummary: `ignored (${outcome.reason})` });
      }
    },
  ).catch(() => undefined);
}

async function handleBotReaction(event: TransportBotReactionEvent): Promise<void> {
  await recordBotReaction(
    {
      source: event.source,
      chatId: event.chat.id,
      assistantId: event.assistantId,
      direct: event.chat.kind === "direct",
    },
    { sourceMessageId: event.sourceMessageId, emoji: event.emoji },
  );
  publishEvent("history");
}

async function handlePresence(event: TransportPresenceEvent): Promise<void> {
  await stampAssistantPresence({
    source: event.source,
    chatId: event.chatId,
    assistantId: event.assistantId,
  }).catch(() => undefined);
}

/** Release a message's live-processing hold (the settle handler's half). */
export async function releaseHold(
  source: SourceId,
  chatId: string,
  sourceMessageId: string,
  assistantId: string | null,
): Promise<void> {
  // A DM row carries the assistant, a group row does not; releasing both
  // shapes covers the message without knowing the chat's kind here.
  await markSourceMessageProcessed(
    { source, chatId, assistantId, direct: true },
    sourceMessageId,
  ).catch(() => undefined);
  await markSourceMessageProcessed(
    { source, chatId, assistantId: null, direct: false },
    sourceMessageId,
  ).catch(() => undefined);
}

/** Handle one transport update (exported for the ingest's tests). */
export async function processTransportUpdate(payload: unknown): Promise<void> {
  const event = transportUpdateEventSchema.parse(payload);
  switch (event.type) {
    case "transport.message":
      return handleTransportMessage(event);
    case "message.delivered":
      return handleDelivered(event);
    case "transport.edited":
      return handleEdit(event);
    case "transport.reaction":
      return handleReaction(event);
    case "transport.bot-reaction":
      return handleBotReaction(event);
    case "transport.presence":
      return handlePresence(event);
  }
}

export interface TransportIngest {
  close(): Promise<void>;
}

/** The per-chat ordering key of one update (falls back to the event id). */
function chainKeyOf(payload: unknown): string {
  const event = payload as { source?: string; chat?: { id?: string }; chatId?: string };
  const chat = event.chat?.id ?? event.chatId;
  return chat ? `${event.source}:${chat}` : randomUUID();
}

/** Start the transport-update consumer (boot entry). */
export async function startTransportIngest(input: {
  redisUrl: string;
  concurrency?: number;
}): Promise<TransportIngest> {
  const chains = new Map<string, Promise<unknown>>();
  const worker: Worker = openWorker(
    TRANSPORT_UPDATES_QUEUE,
    input.redisUrl,
    async (job) => {
      const key = chainKeyOf(job.data);
      const chain = chains.get(key) ?? Promise.resolve();
      const run = chain.then(() => processTransportUpdate(job.data));
      chains.set(
        key,
        run.catch(() => undefined),
      );
      try {
        await run;
      } finally {
        if (chains.get(key) === run) chains.delete(key);
      }
    },
    { concurrency: input.concurrency ?? 8 },
  );
  return {
    async close(): Promise<void> {
      await worker.close();
    },
  };
}

/** Env-gated starter for boot: runs only when the bus and store are configured. */
export async function startTransportIngestFromEnv(): Promise<TransportIngest | null> {
  const env = getEnv();
  if (!env.REDIS_URL || !env.DATABASE_URL) return null;
  return startTransportIngest({ redisUrl: env.REDIS_URL });
}
