import "server-only";

import { parseScopedRef, scopedRef } from "@assistant-hub-swarm/contracts";

import { formatKnownUserLabel } from "@/features/known-users/format";
import { getKnownUsersByIds } from "@/features/known-users/server/repository";
import { renderMediaSuffix, type MediaAnnotation } from "@/features/vision/format";
import {
  contentSources,
  requireSourceContent,
  type SourceChatMessage,
  type SourceContentClient,
} from "@/server/source/content";
import { sourceLabels } from "@/server/source/directory";
import { sourceDirectoryClient } from "@/server/source-store/directory-client";
import type { StoreDb } from "@/server/store/db";
import { getLatestTraceIdsByCorrelation } from "@/server/trace";
import {
  botReactionSuffix,
  collectUserIds,
  fallbackSpeakerLabel,
} from "./format";
import { summaryDayBounds, type SummarizableMessage, type SummaryDate } from "../summary";
import type { ChatMessageRecord, ChatSummary } from "./repository";
import type { ChatMessageWithTrace } from "./schema";

/**
 * History domain service — the read side the dashboard and the day-reading
 * jobs call. The mirror lives in the core's conversation store: every
 * transport's ingest captures the messages and mirrors every delivered
 * reply, so nothing here writes any more — this service composes views and
 * transcripts from what the store serves, for whichever transport a chat
 * ref names.
 */

/**
 * Resolve known-user labels for every sender in a set of rows, keyed by
 * source-local user id. Rows of several chats may mix sources; each source's
 * directory is asked for its own people.
 */
export async function resolveSpeakerLabels(
  db: StoreDb | undefined,
  records: readonly ChatMessageRecord[],
): Promise<Map<string, string>> {
  const bySource = new Map<string, ChatMessageRecord[]>();
  for (const record of records) {
    const { source } = parseScopedRef(record.chatRef);
    bySource.set(source, [...(bySource.get(source) ?? []), record]);
  }
  const labels = new Map<string, string>();
  for (const [source, rows] of bySource) {
    const userIds = collectUserIds(rows);
    if (userIds.length === 0) continue;
    const users = await getKnownUsersByIds(db, source, userIds);
    for (const user of users) labels.set(user.userId, formatKnownUserLabel(user));
  }
  return labels;
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
 * their media annotated. Shared by the two nightly jobs that read a day as
 * a whole — history summarization and passive memory extraction. The
 * boundaries are the operator's day, not UTC's, so an evening conversation
 * is not split across two runs.
 */
export async function loadChatDayTranscript(
  content: SourceContentClient,
  db: StoreDb,
  chatRef: string,
  date: SummaryDate,
  timeZone: string,
): Promise<ChatDayTranscript> {
  const { from, to } = summaryDayBounds(date, timeZone);
  const records = await content.messagesWindow(chatRef, { from, to, endExclusive: true });
  if (records.length === 0) return { messages: [], dayMessageCount: 0 };
  const labels = await resolveSpeakerLabels(db, records);
  const messages = records
    .map((record) => ({
      sourceMessageId: record.sourceMessageId,
      role: record.role,
      content: `${record.content}${mediaSuffixOf(record)}${botReactionSuffix(record)}`.trim(),
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

/** The media annotation suffix for one source row, or the empty string. */
export function mediaSuffixOf(record: SourceChatMessage): string {
  // The source's kinds ARE the v1 kinds (its store carries the same values).
  return record.media ? renderMediaSuffix(record.media as MediaAnnotation) : "";
}

/**
 * Per-chat rollups for the History dashboard, across every registered
 * transport — each chat tagged with the transport it lives on and named by
 * its title when the directory has one.
 */
export async function getHistoryOverview(): Promise<ChatSummary[]> {
  const [sources, labels] = await Promise.all([contentSources(), sourceLabels()]);
  const listings = await Promise.all(
    sources.map(async (source) => {
      const chats = await sourceDirectoryClient(source).listChats();
      return chats
        .filter((chat) => chat.messageCount > 0 && chat.lastMessageAt != null)
        .map((chat) => ({
          chatRef: scopedRef(source, "chat", chat.id),
          sourceLabel: labels.get(source) ?? source,
          label: chat.title ?? chat.id,
          messageCount: chat.messageCount,
          lastSentAt: chat.lastMessageAt!,
        }));
    }),
  );
  return listings.flat().sort((a, b) => b.lastSentAt.localeCompare(a.lastSentAt));
}

/**
 * Correlation id of the trace that handled a message's turn. A transport
 * correlates a turn as `${chatId}:${incomingMessageId}` (source-local ids —
 * see the transport manual), so a user row uses its own message id and an
 * assistant row uses the message it replied to (the incoming turn). Null when
 * there is no anchor.
 */
export function traceCorrelationFor(record: ChatMessageRecord): string | null {
  const anchor =
    record.role === "assistant" ? record.replyToSourceMessageId : record.sourceMessageId;
  return anchor != null ? `${parseScopedRef(record.chatRef).id}:${anchor}` : null;
}

/**
 * The full stored mirror for one chat (dashboard detail view), each message
 * annotated with the id of the trace that handled its turn so the UI can
 * link straight to `/debug/[id]`.
 */
export async function getChatHistory(chatRef: string): Promise<ChatMessageWithTrace[]> {
  const records = await requireSourceContent().allMessages(chatRef);
  const correlations = records
    .map(traceCorrelationFor)
    .filter((value): value is string => value != null);
  const traceIds = await getLatestTraceIdsByCorrelation(correlations);
  return records.map((record) => {
    const correlation = traceCorrelationFor(record);
    // The bot's own reaction rides the annotation slot after any media suffix —
    // the dashboard shows it exactly where the transcript renders it.
    const annotation = `${mediaSuffixOf(record)}${botReactionSuffix(record)}`;
    return {
      ...record,
      traceId: correlation ? (traceIds.get(correlation) ?? null) : null,
      mediaSuffix: annotation || null,
    };
  });
}
