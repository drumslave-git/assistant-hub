import "server-only";

import type { DrizzleDb } from "@/db/drizzle";
import { getDb } from "@/db/drizzle";
import { formatKnownUserLabel } from "@/features/known-users/format";
import { getKnownUsersByIds } from "@/features/known-users/server/repository";
import { getMediaSuffixesForMessages } from "@/features/vision/server/service";
import type { ChatMessage } from "@/server/llm/client";
import { FEATURES } from "@/lib/features";
import type { TraceTrigger } from "@/lib/trace";
import { publishEvent } from "@/server/realtime/hub";
import { getLatestTraceIdsByCorrelation, withTrace } from "@/server/trace";
import {
  collectUserIds,
  fallbackSpeakerLabel,
  historyWindowStart,
  renderTranscript,
  renderTranscriptLine,
  type ReplyRef,
} from "./format";
import { summaryDayBounds, type SummarizableMessage, type SummaryDate } from "../summary";
import {
  appendChatMessage,
  deleteBotReaction,
  getBotReactionsForMessages,
  getChatMessageByTelegramId,
  getChatMessages,
  getChatMessagesForDay,
  getChatMessagesSince,
  listChatSummaries,
  markChatMessageDeleted,
  markMessageProcessed,
  updateChatMessageContent,
  upsertBotReaction,
  type ChatMessageRecord,
  type ChatSummary,
} from "./repository";
import {
  applyEditSchema,
  recordMediaMessageSchema,
  recordMessageSchema,
  type ApplyEditInput,
  type ChatMessageWithTrace,
  type RecordMessageInput,
} from "./schema";

/**
 * History domain service — the boundary the Telegram runtime and dashboard call.
 *
 * The runtime records every human message (passively, even un-addressed group
 * chatter) and every delivered reply, so `chat_messages` becomes a 1:1 mirror of
 * the conversation. For each reply the service assembles the last 24 hours as an
 * id-anchored transcript (one user message) and renders the current turn in the
 * same format. Passive capture is high-volume and intentionally untraced (the
 * mirror itself is the record); mutating edits are traced.
 */

const FEATURE = FEATURES["history"];

/** Input for capturing an incoming human message (role is always `user`). */
export interface IncomingHistoryMessage {
  chatId: string;
  telegramMessageId: number;
  userId: string | null;
  content: string;
  replyToMessageId?: number | null;
  sentAt: Date;
  /** When true, empty content is allowed (a media message with no caption). */
  hasMedia?: boolean;
  /**
   * Live-processing semaphore: the live reply pipeline mirrors with `false` and
   * releases via {@link markIncomingMessageProcessed} once the turn settles.
   * Omitted (imports, tests) → the row lands released (`true`).
   */
  processed?: boolean;
}

/** Input for capturing a delivered assistant reply. */
export interface AssistantHistoryMessage {
  chatId: string;
  telegramMessageId: number;
  content: string;
  replyToMessageId?: number | null;
  sentAt?: Date;
  /** When true, empty content is allowed (a delivered image with no caption). */
  hasMedia?: boolean;
}

/**
 * Capture an incoming human message into the mirror. Best-effort and untraced:
 * returns the stored record, or null when it was empty/invalid or already stored
 * (a re-delivered update). Never throws on validation — a bad row must not break
 * message handling.
 */
export async function recordIncomingMessage(
  input: IncomingHistoryMessage,
  db: DrizzleDb = getDb(),
): Promise<ChatMessageRecord | null> {
  // A media message may have no caption; a text message must have content.
  const schema = input.hasMedia ? recordMediaMessageSchema : recordMessageSchema;
  const parsed = schema.safeParse({ ...input, role: "user" } satisfies RecordMessageInput);
  if (!parsed.success) return null;
  const record = await appendChatMessage(db, {
    chatId: parsed.data.chatId,
    telegramMessageId: parsed.data.telegramMessageId,
    role: "user",
    userId: parsed.data.userId ?? null,
    content: parsed.data.content,
    replyToMessageId: parsed.data.replyToMessageId ?? null,
    sentAt: parsed.data.sentAt,
    // Internal flag, not user input — carried past validation on purpose.
    processed: input.processed,
  });
  if (record) publishEvent(FEATURE.realtimeTopic);
  return record;
}

/**
 * Release a message's live-processing hold (see `chat_messages.processed`).
 * Called from the reply pipeline's `finally` so every exit path — replied,
 * ignored, errored — frees the message's media for the vision backfill.
 */
export async function markIncomingMessageProcessed(
  chatId: string,
  telegramMessageId: number,
  db: DrizzleDb = getDb(),
): Promise<void> {
  await markMessageProcessed(db, chatId, telegramMessageId);
}

/**
 * Capture a delivered assistant reply into the mirror. Best-effort and untraced
 * (the reply is already traced by bot-messaging). Returns the stored record or
 * null.
 */
export async function recordAssistantMessage(
  input: AssistantHistoryMessage,
  db: DrizzleDb = getDb(),
): Promise<ChatMessageRecord | null> {
  // Mirrors the incoming rule: a media message may carry no text. The bot sends
  // one when it delivers a generated image — the picture is the message.
  const schema = input.hasMedia ? recordMediaMessageSchema : recordMessageSchema;
  const parsed = schema.safeParse({
    chatId: input.chatId,
    telegramMessageId: input.telegramMessageId,
    role: "assistant",
    userId: null,
    content: input.content,
    replyToMessageId: input.replyToMessageId ?? null,
    sentAt: input.sentAt ?? new Date(),
  } satisfies RecordMessageInput);
  if (!parsed.success) return null;
  const record = await appendChatMessage(db, {
    chatId: parsed.data.chatId,
    telegramMessageId: parsed.data.telegramMessageId,
    role: "assistant",
    userId: null,
    content: parsed.data.content,
    replyToMessageId: parsed.data.replyToMessageId ?? null,
    sentAt: parsed.data.sentAt,
  });
  if (record) publishEvent(FEATURE.realtimeTopic);
  return record;
}

/**
 * Record the bot's own reaction on a message — set/replace with an emoji, or
 * remove with null. This is what keeps a reaction from being invisible to the
 * bot's own memory: the transcript renders it as a suffix on the target line
 * (`[you reacted: 👍]`), so the next turn *knows* it liked the message instead
 * of denying it (operator report, 2026-08-15). Throws when the target message
 * is not mirrored; the caller decides how to report that.
 */
export async function recordBotReaction(
  input: { chatId: string; telegramMessageId: number; emoji: string | null },
  db: DrizzleDb = getDb(),
): Promise<void> {
  if (input.emoji) {
    await upsertBotReaction(db, input.chatId, input.telegramMessageId, input.emoji);
  } else {
    await deleteBotReaction(db, input.chatId, input.telegramMessageId);
  }
  publishEvent(FEATURE.realtimeTopic);
}

/**
 * Transcript suffixes for the bot's reactions on the given messages
 * (` [you reacted: 👍]`), keyed by Telegram message id — merged into the
 * recent-history window beside the media suffixes.
 */
export async function getBotReactionSuffixesForMessages(
  chatId: string,
  telegramMessageIds: number[],
  db: DrizzleDb = getDb(),
): Promise<Map<number, string>> {
  const reactions = await getBotReactionsForMessages(db, chatId, telegramMessageIds);
  return new Map(
    [...reactions].map(([id, emoji]) => [id, ` [you reacted: ${emoji}]`]),
  );
}

/**
 * Soft-delete a mirrored message the bot removed from the live chat (e.g. a
 * browsing-run acknowledgement), keeping the mirror 1:1 with what the chat
 * shows. Untraced like the capture path — the deletion is already recorded on
 * the flow that performed it. Returns the updated record, or null when the
 * message was never mirrored.
 */
export async function markMessageDeleted(
  chatId: string,
  telegramMessageId: number,
  db: DrizzleDb = getDb(),
): Promise<ChatMessageRecord | null> {
  const record = await markChatMessageDeleted(db, chatId, telegramMessageId);
  if (record) publishEvent(FEATURE.realtimeTopic);
  return record;
}

/**
 * Apply a Telegram `edited_message` to the mirror, keeping it 1:1 with the live
 * chat. Traced (a mutation). If the edited message was never stored, the trace
 * records that the target was unknown rather than fabricating a row.
 */
export async function applyMessageEdit(
  input: ApplyEditInput,
  trigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<ChatMessageRecord | null> {
  return withTrace(
    { feature: FEATURE.id, action: "edit", trigger, inputSummary: input.content },
    async (trace) => {
      const parsed = applyEditSchema.parse(input);
      const before = await updateChatMessageContent(
        db,
        parsed.chatId,
        parsed.telegramMessageId,
        parsed.content,
        parsed.editedAt,
      );
      if (!before) {
        await trace.event({
          type: "db",
          level: "warn",
          message: "edit target not found",
          data: { chatId: parsed.chatId, telegramMessageId: parsed.telegramMessageId },
        });
        await trace.skip("edit target not found");
        return null;
      }
      await trace.event({
        type: "db",
        message: "message edited",
        data: { telegramMessageId: parsed.telegramMessageId, content: parsed.content },
      });
      publishEvent(FEATURE.realtimeTopic);
      await trace.succeed({
        outputSummary: parsed.content,
        relatedIds: { [FEATURE.relatedIdsKey]: [String(before.id)] },
      });
      return before;
    },
  );
}

/**
 * The recent-history window for a reply: zero or one `user` message holding the
 * id-anchored transcript. `count` is the number of transcript rows (for tracing).
 */
export interface ConversationWindow {
  messages: ChatMessage[];
  count: number;
}

/** Resolve known-user labels for every sender in a set of rows. */
export async function resolveSpeakerLabels(
  db: DrizzleDb,
  records: readonly ChatMessageRecord[],
): Promise<Map<string, string>> {
  const userIds = collectUserIds(records);
  if (userIds.length === 0) return new Map();
  const users = await getKnownUsersByIds(db, userIds);
  return new Map(users.map((u) => [u.userId, formatKnownUserLabel(u)]));
}

/** Label used for the bot's own rows in a loaded chat-day transcript. */
export const BOT_TRANSCRIPT_LABEL = "Bot";

/** One wall-clock chat-day, loaded for a whole-day model pass. */
export interface ChatDayTranscript {
  /**
   * The day's readable transcript rows: media messages carry their vision
   * annotation (` [photo: <description>]`) folded into `content`, and rows with
   * nothing to read (no text, no known media) are dropped — an album photo with
   * no caption must not become an empty transcript line.
   */
  messages: SummarizableMessage[];
  /**
   * Raw stored rows in the day, including the dropped ones. This — not
   * `messages.length` — is what a job marker must record: the due-scans compare
   * the marker against the day's live row count, so recording the filtered count
   * would leave the day looking changed forever.
   */
  dayMessageCount: number;
}

/**
 * Load one wall-clock chat-day's messages with their speakers resolved and
 * their media annotated.
 *
 * Shared by the two nightly jobs that read a day as a whole — history
 * summarization and passive memory extraction — because both need exactly this:
 * the day's rows in the operator's timezone, each carrying a human label. The
 * boundaries are the operator's day, not UTC's, so an evening conversation is not
 * split across two runs.
 */
export async function loadChatDayTranscript(
  db: DrizzleDb,
  chatId: string,
  date: SummaryDate,
  timeZone: string,
): Promise<ChatDayTranscript> {
  const { from, to } = summaryDayBounds(date, timeZone);
  const records = await getChatMessagesForDay(db, chatId, from, to);
  if (records.length === 0) return { messages: [], dayMessageCount: 0 };
  const labels = await resolveSpeakerLabels(db, records);
  const mediaSuffixes = await getMediaSuffixesForMessages(
    chatId,
    records.map((record) => record.telegramMessageId),
    db,
  );
  const messages = records
    .map((record) => ({
      telegramMessageId: record.telegramMessageId,
      role: record.role,
      content: `${record.content}${mediaSuffixes.get(record.telegramMessageId) ?? ""}`.trim(),
      label:
        record.role === "assistant"
          ? BOT_TRANSCRIPT_LABEL
          : ((record.userId ? labels.get(record.userId) : undefined) ??
            fallbackSpeakerLabel(record.userId)),
      userId: record.role === "assistant" ? null : record.userId,
      sentAt: record.sentAt,
    }))
    .filter((message) => message.content.length > 0);
  return { messages, dayMessageCount: records.length };
}

/**
 * Build the recent-history window for a reply: the chat's messages from the last
 * 24 hours (excluding the current turn), rendered as one id-anchored transcript
 * in a single `user` message. Every human turn is labelled with the sender's
 * known-user name; the bot's own rows use `botLabel`.
 */
export async function getConversationWindow(
  params: {
    chatId: string;
    botLabel?: string;
    excludeTelegramMessageId?: number;
    now?: Date;
    /**
     * Cap the window to the newest N messages. Unset → the whole 24-hour window.
     * Used by the context-overflow retry: a day too big for the model's context
     * is re-injected progressively smaller until the request fits.
     */
    maxMessages?: number;
    /**
     * Resolve media suffixes (e.g. ` [photo: <description>]`) for the window's
     * message ids, so past image turns read as text. Injected so history stays
     * decoupled from the vision feature. Best-effort — omit or resolve empty when
     * there is no media.
     */
    loadMediaSuffixes?: (telegramMessageIds: number[]) => Promise<ReadonlyMap<number, string>>;
  },
  db: DrizzleDb = getDb(),
): Promise<ConversationWindow> {
  const since = historyWindowStart(params.now ?? new Date());
  const fetched = await getChatMessagesSince(db, params.chatId, since, {
    excludeTelegramMessageId: params.excludeTelegramMessageId,
  });
  // Keep the newest N: recency matters most for a reply, so a shrunken window
  // drops the oldest turns first.
  const records =
    params.maxMessages != null && params.maxMessages < fetched.length
      ? fetched.slice(fetched.length - params.maxMessages)
      : fetched;

  const ids = records.map((r) => r.telegramMessageId);
  const speakerLabels = await resolveSpeakerLabels(db, records);
  const mediaSuffixes = params.loadMediaSuffixes
    ? await params.loadMediaSuffixes(ids).catch(() => undefined)
    : undefined;
  // The bot's own reactions, appended after any media suffix — so a liked photo
  // reads ` [photo: …] [you reacted: 👍]`. History's own data, loaded here
  // rather than injected: every consumer of the window must see them, or the
  // bot denies reactions it set (operator report, 2026-08-15). Best-effort like
  // the media suffixes — an unreadable table must not drop the reply.
  const reactionSuffixes = await getBotReactionSuffixesForMessages(params.chatId, ids, db).catch(
    () => new Map<number, string>(),
  );
  const suffixes = new Map(mediaSuffixes ?? []);
  for (const [id, suffix] of reactionSuffixes) {
    suffixes.set(id, `${suffixes.get(id) ?? ""}${suffix}`);
  }
  const transcript = renderTranscript(records, {
    speakerLabels,
    botLabel: params.botLabel,
    mediaSuffixes: suffixes,
  });
  return {
    messages: transcript ? [{ role: "user", content: transcript }] : [],
    count: records.length,
  };
}

/** The reply target of the current turn, as extracted from the Telegram update. */
export interface CurrentTurnReplyTo {
  telegramMessageId: number;
  /** Sender label resolved by the runtime from the quoted message's `from`. */
  senderLabel: string | null;
  /** The quoted message's text/caption, or null when it had none. */
  text: string | null;
  /** Telegram partial-quote text, when the user quoted a specific fragment. */
  quote?: string | null;
}

/** The current turn rendered in transcript format, plus data for the trace. */
export interface ComposedCurrentTurn {
  content: string;
  senderLabel: string | null;
  data: Record<string, unknown>;
}

/**
 * Render the message being answered as a transcript line, resolving its reply
 * target against the mirror: a stored target becomes a `[reply to #<id>]` anchor
 * (dereferenceable via the history tools even when outside the injected window);
 * an unstored one gets its sender and full text inlined, never trimmed.
 */
export async function composeCurrentTurn(
  params: {
    chatId: string;
    telegramMessageId: number;
    senderLabel: string | null;
    content: string;
    replyTo?: CurrentTurnReplyTo | null;
  },
  db: DrizzleDb = getDb(),
): Promise<ComposedCurrentTurn> {
  let replyRef: ReplyRef | null = null;
  if (params.replyTo) {
    const stored = await getChatMessageByTelegramId(
      db,
      params.chatId,
      params.replyTo.telegramMessageId,
    );
    replyRef = stored
      ? {
          kind: "anchor",
          telegramMessageId: params.replyTo.telegramMessageId,
          quote: params.replyTo.quote ?? null,
        }
      : { kind: "inline", label: params.replyTo.senderLabel, text: params.replyTo.text };
  }
  const content = renderTranscriptLine({
    telegramMessageId: params.telegramMessageId,
    label: params.senderLabel ?? fallbackSpeakerLabel(null),
    replyRef,
    content: params.content,
  });
  return {
    content,
    senderLabel: params.senderLabel,
    data: {
      line: content,
      replyTo: params.replyTo
        ? { telegramMessageId: params.replyTo.telegramMessageId, resolved: replyRef?.kind ?? null }
        : null,
    },
  };
}

/** Per-chat rollups for the History dashboard. */
export async function getHistoryOverview(db: DrizzleDb = getDb()): Promise<ChatSummary[]> {
  return listChatSummaries(db);
}

/**
 * Correlation id of the trace that handled a message's turn. A trace's
 * correlation id is `${chatId}:${incomingMessageId}` (see the bot-messaging
 * service), so a user row uses its own Telegram id and an assistant row uses the
 * message it replied to (the incoming turn). Null when there is no anchor.
 */
export function traceCorrelationFor(record: ChatMessageRecord): string | null {
  const anchor = record.role === "assistant" ? record.replyToMessageId : record.telegramMessageId;
  return anchor != null ? `${record.chatId}:${anchor}` : null;
}

/**
 * The full stored mirror for one chat (dashboard detail view), each message
 * annotated with the id of the trace that handled its turn so the UI can link
 * straight to `/debug/[id]`.
 */
export async function getChatHistory(
  chatId: string,
  options: {
    /**
     * Resolve media annotations (` [photo: <description>]`) for the given message
     * ids so a media message shows its recognition instead of blank content.
     * Injected so history stays decoupled from the vision feature.
     */
    loadMediaSuffixes?: (telegramMessageIds: number[]) => Promise<ReadonlyMap<number, string>>;
  } = {},
  db: DrizzleDb = getDb(),
): Promise<ChatMessageWithTrace[]> {
  const records = await getChatMessages(db, chatId);
  const ids = records.map((r) => r.telegramMessageId);
  const correlations = records
    .map(traceCorrelationFor)
    .filter((value): value is string => value != null);
  const traceIds = await getLatestTraceIdsByCorrelation(correlations);
  const mediaSuffixes = options.loadMediaSuffixes
    ? await options.loadMediaSuffixes(ids).catch(() => undefined)
    : undefined;
  // The bot's own reactions ride the same annotation slot, after any media
  // suffix — the dashboard shows the reaction exactly where the transcript
  // renders it.
  const reactionSuffixes = await getBotReactionSuffixesForMessages(chatId, ids, db).catch(
    () => new Map<number, string>(),
  );
  return records.map((record) => {
    const correlation = traceCorrelationFor(record);
    const annotation = `${mediaSuffixes?.get(record.telegramMessageId) ?? ""}${
      reactionSuffixes.get(record.telegramMessageId) ?? ""
    }`;
    return {
      ...record,
      traceId: correlation ? (traceIds.get(correlation) ?? null) : null,
      mediaSuffix: annotation || null,
    };
  });
}
