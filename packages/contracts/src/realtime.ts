/**
 * The realtime contract: what the dashboard's live surfaces are called.
 *
 * Live updates reach the browser over one SSE stream the core serves
 * (`GET /api/events`); a page subscribes to a topic and re-reads when it
 * fires. The names live here because they cross apps in both directions — a
 * source app names the topics it invalidated on its `dashboard.refresh`
 * event, and an app-contributed dashboard page subscribes to them.
 */

/** Topics a client can subscribe to. Add new live surfaces here. */
export const REALTIME_TOPICS = [
  "traces",
  "bot",
  "status",
  "history",
  "users",
  "groups",
  "vision",
  "tasks",
  "feedback",
  "memory",
  "analytics",
  "browser",
  "assistants",
  "threads",
  "tools",
  "accounts",
] as const;

export type RealtimeTopic = (typeof REALTIME_TOPICS)[number];

/** A single server→client notification. Payload stays intentionally small. */
export interface RealtimeEvent {
  topic: RealtimeTopic;
  /** Optional feature scope, so a scoped view can ignore unrelated events. */
  feature?: string;
  /** ISO timestamp the event was published. */
  at: string;
}
