import { z } from "zod";

/**
 * The conversation-content half of the source apps' internal API (the swap):
 * what the core's content features — history tools, summarization, search
 * indexing, the dashboard's history/search views — read and write now that
 * the mirror, the search index, and the summaries live in the owning app's
 * store. The SQL runs next to the data (hybrid search, due scans); the core
 * supplies query text and, when embeddings are configured, vectors — models
 * never run on the source side.
 */

/** One mirrored message row, as stored (deleted rows flagged, not hidden). */
export const contentMessageSchema = z.object({
  /** The store's monotonic insertion id (ordering; search fusion key). */
  id: z.number().int(),
  chatId: z.string().min(1),
  sourceMessageId: z.string().min(1),
  role: z.enum(["user", "assistant"]),
  userId: z.string().nullable(),
  content: z.string(),
  replyToSourceMessageId: z.string().nullable(),
  sentAt: z.string().min(1),
  editedAt: z.string().nullable(),
  deletedAt: z.string().nullable(),
  botReaction: z.string().nullable(),
  createdAt: z.string().min(1),
  /** Media on this message (kind + describe state), or null. */
  media: z
    .object({
      kind: z.string().min(1),
      status: z.enum(["pending", "described", "unavailable"]),
      description: z.string().nullable(),
    })
    .nullable(),
});

export type ContentMessage = z.infer<typeof contentMessageSchema>;

/**
 * GET /internal/chats/:chatId/content-messages — mirror reads for the
 * content features, oldest first. Narrowed by exactly one of:
 * `?ids=1,2,3` (specific rows), `?from=ISO&to=ISO[&endExclusive=true]`
 * (a time window; exclusive end for calendar-day reads so midnight's
 * message never files under two days), or nothing (the full mirror — the
 * export's read). Rows come back as stored; callers filter `deletedAt`
 * where their v1 semantics did.
 */
export const contentMessagesResponseSchema = z.object({
  messages: z.array(contentMessageSchema),
});

/** POST /internal/chats/:chatId/messages/import — the CSV import's write path. */
export const contentImportRequestSchema = z.object({
  messages: z
    .array(
      z.object({
        sourceMessageId: z.string().min(1),
        role: z.enum(["user", "assistant"]),
        userId: z.string().nullable().optional(),
        content: z.string(),
        replyToSourceMessageId: z.string().nullable().optional(),
        sentAt: z.string().min(1),
        editedAt: z.string().nullable().optional(),
        deletedAt: z.string().nullable().optional(),
      }),
    )
    .max(10_000),
});

/** Rows whose `(chat, source message id)` already existed are skipped. */
export const contentImportResponseSchema = z.object({
  inserted: z.number().int().nonnegative(),
});

/** GET /internal/messages/day-counts?tz=&before= — the summarizer's day scan half. */
export const contentDayCountsResponseSchema = z.object({
  days: z.array(
    z.object({
      chatId: z.string().min(1),
      /** `YYYY-MM-DD` in the requested timezone. */
      date: z.string().min(1),
      messageCount: z.number().int().nonnegative(),
    }),
  ),
});

/** A stored topic summary. */
export const contentSummarySchema = z.object({
  id: z.number().int(),
  chatId: z.string().min(1),
  summaryDate: z.string().min(1),
  content: z.string(),
  /** Source-local message ids belonging to this topic. */
  messageIds: z.array(z.number().int()),
  createdAt: z.string().min(1),
  /** Whether the row is semantically searchable (carries an embedding). */
  embedded: z.boolean(),
});

export type ContentSummary = z.infer<typeof contentSummarySchema>;

/**
 * PUT /internal/chats/:chatId/summaries/:date — replace the day's topics
 * atomically (idempotent re-runs). The core stamps its own coverage marker
 * after this returns.
 */
export const contentReplaceSummariesRequestSchema = z.object({
  topics: z.array(
    z.object({
      content: z.string().min(1),
      messageIds: z.array(z.number().int()),
      embedding: z.array(z.number()).nullable(),
    }),
  ),
});

export const contentSummariesResponseSchema = z.object({
  summaries: z.array(contentSummarySchema),
});

/** GET /internal/summaries/counts — per-chat topic counts (History overview). */
export const contentSummaryCountsResponseSchema = z.object({
  counts: z.array(z.object({ chatId: z.string().min(1), topicCount: z.number().int() })),
});

/** POST /internal/search/messages — the hybrid message search. */
export const contentSearchMessagesRequestSchema = z.object({
  /** The chat to search, or null for every chat (operator-side search only). */
  chatId: z.string().nullable(),
  queryText: z.string(),
  queryVector: z.array(z.number()).nullable(),
  limit: z.number().int().positive().max(200),
  filters: z
    .object({
      authorUserIds: z.array(z.string()).optional(),
      mediaKinds: z.array(z.string()).optional(),
    })
    .optional(),
});

/** A message hit: the row, what matched, and the fused score. */
export const contentMessageMatchSchema = contentMessageSchema
  .omit({ media: true })
  .extend({
    /** The indexed text (message + media annotation), when the row is indexed. */
    indexedContent: z.string().nullable(),
    /** The message's media kind, or null for a plain text message. */
    mediaKind: z.string().nullable(),
    score: z.number(),
  });

export const contentSearchMessagesResponseSchema = z.object({
  matches: z.array(contentMessageMatchSchema),
});

export type ContentMessageMatch = z.infer<typeof contentMessageMatchSchema>;

/** POST /internal/search/summaries — the hybrid summaries search. */
export const contentSearchSummariesRequestSchema = z.object({
  chatId: z.string().min(1),
  queryText: z.string(),
  queryVector: z.array(z.number()).nullable(),
  limit: z.number().int().positive().max(200),
});

export const contentSearchSummariesResponseSchema = z.object({
  matches: z.array(contentSummarySchema.extend({ score: z.number() })),
});

/** GET /internal/index/due?limit= — what the indexing job still owes work on. */
export const contentIndexDueResponseSchema = z.object({
  messages: z.array(
    z.object({
      chatId: z.string().min(1),
      sourceMessageId: z.string().min(1),
      content: z.string(),
      media: z
        .object({
          kind: z.string().min(1),
          status: z.string().min(1),
          description: z.string().nullable(),
        })
        .nullable(),
    }),
  ),
  total: z.number().int().nonnegative(),
});

/** PUT /internal/index/rows — store built index rows (replace on conflict). */
export const contentIndexRowsRequestSchema = z.object({
  rows: z
    .array(
      z.object({
        chatId: z.string().min(1),
        sourceMessageId: z.string().min(1),
        content: z.string(),
        embedding: z.array(z.number()).nullable(),
      }),
    )
    .max(1_000),
});

/** POST /internal/index/clear — rebuild-from-scratch (embeddings arrived late). */
export const contentIndexClearResponseSchema = z.object({
  removed: z.number().int().nonnegative(),
});

/** GET /internal/index/embedded-count?chatId= — semantic coverage of one chat. */
export const contentEmbeddedCountResponseSchema = z.object({
  count: z.number().int().nonnegative(),
});

/* -------------------------- analytics aggregates -------------------------- *
 * Message-volume analytics read the mirror where it lives: the aggregation
 * SQL runs source-side and only the bucketed numbers cross the API. Bucket
 * keys are wall-clock strings in the requested timezone (`YYYY-MM-DD HH24` /
 * `YYYY-MM-DD` / `YYYY-MM` / `YYYY`, or the literal `all`), matching the
 * core's period module bucket keys exactly.
 * -------------------------------------------------------------------------- */

/** The bucketing unit for the analytics series/availability endpoints. */
export const contentBucketUnitSchema = z.enum(["hour", "day", "week", "month", "year", "all"]);

export type ContentBucketUnit = z.infer<typeof contentBucketUnitSchema>;

/** GET /internal/analytics/message-series?from=&to=&unit=&tz=[&chatId=][&userId=] */
export const contentMessageSeriesResponseSchema = z.object({
  rows: z.array(
    z.object({
      bucket: z.string().min(1),
      human: z.number().int().nonnegative(),
      bot: z.number().int().nonnegative(),
      activeUsers: z.number().int().nonnegative(),
    }),
  ),
});

/** GET /internal/analytics/new-user-series?from=&to=&unit=&tz= (first sightings). */
export const contentNewUserSeriesResponseSchema = z.object({
  rows: z.array(
    z.object({ bucket: z.string().min(1), newUsers: z.number().int().nonnegative() }),
  ),
});

/** GET /internal/analytics/top-users?from=&to=&limit=[&chatId=] */
export const contentTopUsersResponseSchema = z.object({
  rows: z.array(
    z.object({ userId: z.string().min(1), messages: z.number().int().nonnegative() }),
  ),
});

/** GET /internal/analytics/availability?from=&to=&unit=&tz=[&chatId=] */
export const contentBucketsResponseSchema = z.object({
  buckets: z.array(z.string()),
});

/**
 * GET /internal/analytics/hour-counts?tz=[&from=] — the insight due-scan's
 * source half: every (chat, wall-clock hour) pair holding visible messages,
 * with counts. The core joins these against its own scored-hour rows in JS
 * (the same split-scan shape as the summarizer's day counts); `from` is the
 * scan floor as a UTC instant, bounding the group-by to recent rows.
 */
export const contentHourCountsResponseSchema = z.object({
  hours: z.array(
    z.object({
      chatId: z.string().min(1),
      /** `YYYY-MM-DD HH24` in the requested timezone. */
      insightHour: z.string().min(1),
      messageCount: z.number().int().nonnegative(),
    }),
  ),
});
