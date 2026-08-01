import type { RealtimeTopic } from "./realtime";

/**
 * Central feature registry — the single source of truth tying each product
 * feature to the identifiers that must stay in lockstep across the codebase:
 *
 *  - `id`            the `feature` string recorded on every trace and used to
 *                    scope the shared Debug view (`/debug?feature=<id>`).
 *  - `label`         human name shown in the Debug filter and elsewhere.
 *  - `realtimeTopic` the SSE topic this feature's data pages live-update on
 *                    (omitted for features that publish no domain events).
 *  - `relatedIdsKey` the key under `trace.relatedIds` for this feature's rows
 *                    (omitted for features with no primary row to link).
 *  - `path`          the feature's dashboard route.
 *
 * These identifiers were previously bare string literals duplicated between
 * each service (the trace *writer*) and its Debug page (the *reader*). Nothing
 * enforced that they matched, so a rename silently produced an empty Debug
 * list. Referencing the registry from both ends turns any mismatch into a
 * compile error. Pure/client-safe (types only) so services, Server Components,
 * and Client Components can all import it.
 */
export interface FeatureDescriptor {
  id: string;
  label: string;
  realtimeTopic?: RealtimeTopic;
  relatedIdsKey?: string;
  path?: string;
}

export const FEATURES = {
  "bot-messaging": { id: "bot-messaging", label: "Bot messaging" },
  vision: {
    id: "vision",
    label: "Vision",
    realtimeTopic: "vision",
    relatedIdsKey: "message_media",
    path: "/vision",
  },
  "vision-backfill": {
    id: "vision-backfill",
    label: "Vision backfill",
    realtimeTopic: "vision",
    path: "/vision",
  },
  // Voice messages live on the vision media pipeline (`message_media`, kind
  // `voice`) but trace as their own feature, so "what did the bot hear/say"
  // filters cleanly: `transcribe` (voice → text) and `synthesize` (text → voice).
  voice: {
    id: "voice",
    label: "Voice",
    realtimeTopic: "vision",
    relatedIdsKey: "message_media",
    path: "/vision",
  },
  history: {
    id: "history",
    label: "History",
    realtimeTopic: "history",
    relatedIdsKey: "chat_messages",
    path: "/history",
  },
  "history-summaries": {
    id: "history-summaries",
    label: "History summaries",
    realtimeTopic: "history",
    relatedIdsKey: "chat_summaries",
    path: "/history",
  },
  "known-users": {
    id: "known-users",
    label: "Users",
    realtimeTopic: "users",
    relatedIdsKey: "known_users",
    path: "/users",
  },
  "known-groups": {
    id: "known-groups",
    label: "Groups",
    realtimeTopic: "groups",
    relatedIdsKey: "known_groups",
    path: "/groups",
  },
  personalities: {
    id: "personalities",
    label: "Personalities",
    relatedIdsKey: "personalities",
    path: "/personalities",
  },
  "scheduled-tasks": {
    id: "scheduled-tasks",
    label: "Scheduled tasks",
    realtimeTopic: "tasks",
    relatedIdsKey: "scheduled_tasks",
    path: "/scheduled-tasks",
  },
  specialists: {
    id: "specialists",
    label: "Specialists",
    realtimeTopic: "specialists",
    relatedIdsKey: "specialists",
    path: "/specialists",
  },
  "chat-rules": {
    id: "chat-rules",
    label: "Chat rules",
    realtimeTopic: "rules",
    relatedIdsKey: "chat_rules",
    path: "/rules",
  },
  settings: {
    id: "settings",
    label: "Settings",
    relatedIdsKey: "settings",
    path: "/settings",
  },
  /** Trace-store maintenance itself (the manual prune) — traced like any mutation. */
  traces: {
    id: "traces",
    label: "Traces",
    path: "/debug",
  },
  /** Operator authentication (setup/login) — every attempt is traced. */
  auth: {
    id: "auth",
    label: "Auth",
  },
  "user-feedback": {
    id: "user-feedback",
    label: "User feedback",
    realtimeTopic: "feedback",
    relatedIdsKey: "users_feedbacks",
    path: "/self-improvement",
  },
  "self-improvement": {
    id: "self-improvement",
    label: "Self-improvement",
    realtimeTopic: "feedback",
    path: "/self-improvement",
  },
  memory: {
    id: "memory",
    label: "Memory",
    realtimeTopic: "memory",
    relatedIdsKey: "memory",
    path: "/memory",
  },
  // Its own feature id rather than an action under `memory`, for the same reason
  // `history-summaries` is split from `history`: one nightly run produces both
  // extraction and consolidation traces, and an operator asking "what did the bot
  // decide to remember from Tuesday" must be able to filter to that half alone.
  "memory-extraction": {
    id: "memory-extraction",
    label: "Memory extraction",
    realtimeTopic: "memory",
    relatedIdsKey: "memory",
    path: "/memory",
  },
  "browser-agent": {
    id: "browser-agent",
    label: "Browser agent",
    realtimeTopic: "browser",
    relatedIdsKey: "browser_agent_runs",
    path: "/browser",
  },
  // Split from `browser-agent` for the same reason `history-summaries` is split
  // from `history`: the nightly yt-dlp check is maintenance *of* the browser
  // agent, not a browsing run, and "did the downloader's binary stay current"
  // must be filterable without wading through every run.
  "ytdlp-updater": {
    id: "ytdlp-updater",
    label: "yt-dlp updater",
    realtimeTopic: "browser",
    path: "/browser",
  },
  analytics: {
    id: "analytics",
    label: "Analytics",
    realtimeTopic: "analytics",
    path: "/analytics",
  },
  "analytics-insights": {
    id: "analytics-insights",
    label: "Analytics insights",
    realtimeTopic: "analytics",
    relatedIdsKey: "chat_day_insights",
    path: "/analytics",
  },

  // Per-tool trace scopes. Every MCP tool call is recorded under
  // `mcp-tools-<owning-feature>` (see `server/mcp/tool-trace.ts`), so each tool
  // group has its own Debug scope. The id must equal `mcp-tools-${owner}` where
  // `owner` is the feature string passed to `registry.registerTools` in
  // `server/mcp/runtime.ts`.
  "mcp-tools-history": { id: "mcp-tools-history", label: "History tools", path: "/tools" },
  "mcp-tools-known-users": {
    id: "mcp-tools-known-users",
    label: "User tools",
    path: "/tools",
  },
  "mcp-tools-scheduled-tasks": {
    id: "mcp-tools-scheduled-tasks",
    label: "Scheduled task tools",
    path: "/tools",
  },
  "mcp-tools-memory": {
    id: "mcp-tools-memory",
    label: "Memory tools",
    path: "/tools",
  },
  "mcp-tools-image-gen": {
    id: "mcp-tools-image-gen",
    label: "Image generation tool",
    path: "/tools",
  },
  "mcp-tools-browser-agent": {
    id: "mcp-tools-browser-agent",
    label: "Browser agent tool",
    path: "/tools",
  },
  "mcp-tools-specialists": {
    id: "mcp-tools-specialists",
    label: "Specialist tools",
    path: "/tools",
  },
  "mcp-tools-chat-rules": {
    id: "mcp-tools-chat-rules",
    label: "Chat rule tools",
    path: "/tools",
  },
} as const satisfies Record<string, FeatureDescriptor>;

/** A registered feature id (the trace `feature` string). */
export type FeatureId = keyof typeof FEATURES;

/** Every registered feature id, for building filter option lists. */
export const FEATURE_IDS = Object.keys(FEATURES) as FeatureId[];

/** Human label for a feature id — falls back to the raw id for unknowns. */
export function featureLabel(id: string): string {
  return (FEATURES as Record<string, FeatureDescriptor>)[id]?.label ?? id;
}

/** The shared Debug view pre-filtered to a single feature's traces. */
export function featureDebugHref(id: FeatureId): string {
  return `/debug?feature=${encodeURIComponent(FEATURES[id].id)}`;
}
