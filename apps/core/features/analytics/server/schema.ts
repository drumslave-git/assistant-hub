import { z } from "zod";

import { GRANULARITIES, METRIC_SOURCES, PERIOD_UNITS, SERIES_SECTIONS } from "../types";

/**
 * Validated query shapes for the analytics Route Handlers. Kept pure (no server-only
 * import) so tests can build inputs against the same schema the handlers parse.
 */

/**
 * The filters a card carries: which period it is pointed at, and an optional
 * chat/user drill-down.
 *
 * `anchor` names the exact period — `2026-07-18`, `2026-07`, `2026`, `all`. It is
 * optional only so a first load can mean "the current one"; the service resolves it
 * against the operator timezone rather than letting the browser's clock decide.
 */
export const metricsQuerySchema = z.object({
  unit: z.enum(PERIOD_UNITS).default("day"),
  anchor: z.string().trim().min(1).optional(),
  /** Restrict to one chat (Telegram chat id). */
  chatId: z.string().trim().min(1).optional(),
  /** Restrict to one user's own messages (Telegram user id). */
  userId: z.string().trim().min(1).optional(),
});

export type MetricsQuery = z.infer<typeof metricsQuerySchema>;

/** A chart card's query: the card's filters plus which series it wants. */
export const seriesQuerySchema = metricsQuerySchema.extend({
  section: z.enum(SERIES_SECTIONS),
});

export type SeriesQuery = z.infer<typeof seriesQuerySchema>;

/**
 * The insight/mood cards' query. `chatId` is **required**: insights are scored per
 * chat, and averaging unrelated conversations produces a number describing nobody.
 */
export const insightsQuerySchema = z.object({
  unit: z.enum(PERIOD_UNITS).default("day"),
  anchor: z.string().trim().min(1).optional(),
  chatId: z.string().trim().min(1),
});

export type InsightsQuery = z.infer<typeof insightsQuerySchema>;

/**
 * The calendar's data-mark query: which periods in a range hold any data, for the
 * source this card reads.
 */
export const availabilityQuerySchema = z.object({
  source: z.enum(METRIC_SOURCES),
  unit: z.enum(PERIOD_UNITS).default("day"),
  /** Inclusive anchor range the calendar is showing. */
  from: z.string().trim().min(1),
  to: z.string().trim().min(1),
  chatId: z.string().trim().min(1).optional(),
});

export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;

/**
 * Drop-and-regenerate request: which period's insights to throw away and compute
 * again. `all`/`all` wipes every stored insight and re-scores the whole history.
 */
export const regenerateSchema = z.object({
  granularity: z.enum(GRANULARITIES),
  /** Bucket key at that granularity (`2026-07-16 14`, `2026-07-16`, `2026-07`, `2026`, `all`). */
  bucket: z.string().trim().min(1),
});

export type RegenerateInput = z.infer<typeof regenerateSchema>;
