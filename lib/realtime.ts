/**
 * Shared realtime event contract.
 *
 * Live dashboard updates are delivered server→client over a single SSE stream
 * (`GET /api/events`). Features publish small, typed {@link RealtimeEvent}s when
 * state changes; clients subscribe to a topic and react (typically a
 * `router.refresh()`). Pure types (no server imports) so both the server hub and
 * client hooks can share them.
 */

/** Topics a client can subscribe to. Add new live surfaces here. */
export const REALTIME_TOPICS = ["traces", "bot", "status", "history", "users", "groups", "vision", "tasks", "feedback", "memory", "analytics", "browser"] as const;
export type RealtimeTopic = (typeof REALTIME_TOPICS)[number];

/** A single server→client notification. Payload stays intentionally small. */
export interface RealtimeEvent {
  topic: RealtimeTopic;
  /** Optional feature scope, so a scoped view can ignore unrelated events. */
  feature?: string;
  /** ISO timestamp the event was published. */
  at: string;
}
