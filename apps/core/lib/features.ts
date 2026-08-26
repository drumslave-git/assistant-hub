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
/**
 * Which part of the product a feature belongs to. Only the Debug filter reads
 * this today: 31 flat options in one dropdown is a list you scan, not one you
 * pick from, and grouping by product area is how an operator already thinks
 * about the bot ("something in Knowledge", "one of the tools").
 *
 * Order here is the order the groups appear in the filter.
 */
export const FEATURE_GROUPS = [
  "conversation",
  "people",
  "knowledge",
  "automation",
  "tools",
  "insights",
  "system",
] as const;

export type FeatureGroup = (typeof FEATURE_GROUPS)[number];

export const FEATURE_GROUP_LABELS: Record<FeatureGroup, string> = {
  conversation: "Conversation",
  people: "People",
  knowledge: "Knowledge",
  automation: "Automation",
  tools: "Tools",
  insights: "Insights",
  system: "System",
};

export interface FeatureDescriptor {
  id: string;
  label: string;
  /** Product area, used to group the Debug filter. See {@link FEATURE_GROUPS}. */
  group: FeatureGroup;
  realtimeTopic?: RealtimeTopic;
  relatedIdsKey?: string;
  path?: string;
}

export const FEATURES = {
  "bot-messaging": { id: "bot-messaging", label: "Bot messaging", group: "conversation" },
  vision: {
    id: "vision",
    label: "Vision",
    group: "conversation",
    realtimeTopic: "vision",
    relatedIdsKey: "message_media",
    path: "/vision",
  },
  "vision-backfill": {
    id: "vision-backfill",
    label: "Vision backfill",
    group: "automation",
    realtimeTopic: "vision",
    path: "/vision",
  },
  // Voice messages live on the vision media pipeline (`message_media`, kind
  // `voice`) but trace as their own feature, so "what did the bot hear/say"
  // filters cleanly: `transcribe` (voice → text) and `synthesize` (text → voice).
  voice: {
    id: "voice",
    label: "Voice",
    group: "conversation",
    realtimeTopic: "vision",
    relatedIdsKey: "message_media",
    path: "/vision",
  },
  history: {
    id: "history",
    label: "History",
    group: "knowledge",
    realtimeTopic: "history",
    relatedIdsKey: "chat_messages",
    path: "/history",
  },
  "history-summaries": {
    id: "history-summaries",
    label: "History summaries",
    group: "knowledge",
    realtimeTopic: "history",
    relatedIdsKey: "chat_summaries",
    path: "/history",
  },
  // Split from `history` for the same reason `history-summaries` is: the indexing
  // job runs continuously in the background and would otherwise bury the handful
  // of traces an operator actually looks for under "what did history do today".
  "history-index": {
    id: "history-index",
    label: "History search index",
    group: "knowledge",
    realtimeTopic: "history",
    relatedIdsKey: "chat_message_search",
    path: "/history",
  },
  "known-users": {
    id: "known-users",
    label: "Users",
    group: "people",
    realtimeTopic: "users",
    relatedIdsKey: "known_users",
    path: "/users",
  },
  "known-groups": {
    id: "known-groups",
    label: "Groups",
    group: "people",
    realtimeTopic: "groups",
    relatedIdsKey: "known_groups",
    path: "/groups",
  },
  // The operator's declaration that identities across sources are one human
  // (redesign Phase 3). Lives on the Users page as its own tab: it is a view
  // of the same people, not a separate corner of the dashboard.
  "person-links": {
    id: "person-links",
    label: "Person links",
    group: "people",
    realtimeTopic: "users",
    relatedIdsKey: "person_links",
    path: "/users",
  },
  // First-class successor of personalities (redesign Phase 3): many
  // assistants, each with its own persona and per-source connection; the
  // assistant in a chat is implied by which bot is in it — no "active" one.
  assistants: {
    id: "assistants",
    label: "Assistants",
    group: "conversation",
    realtimeTopic: "assistants",
    relatedIdsKey: "assistants",
    path: "/assistants",
  },
  // The unified feature that absorbed scheduled tasks and chat rules (user
  // decision, 2026-08-13): one instruction + one trigger (message / on-reply /
  // interval / timeout / schedule).
  tasks: {
    id: "tasks",
    label: "Tasks",
    group: "automation",
    realtimeTopic: "tasks",
    relatedIdsKey: "tasks",
    path: "/tasks",
  },
  settings: {
    id: "settings",
    label: "Settings",
    group: "system",
    relatedIdsKey: "settings",
    path: "/settings",
  },
  backends: {
    id: "backends",
    label: "Backends",
    group: "system",
    relatedIdsKey: "backends",
    path: "/backends",
  },
  /** Trace-store maintenance itself (the manual prune) — traced like any mutation. */
  traces: {
    id: "traces",
    label: "Traces",
    group: "system",
    path: "/debug",
  },
  /** Operator authentication (setup/login) — every attempt is traced. */
  auth: {
    id: "auth",
    label: "Auth",
    group: "system",
  },
  "user-feedback": {
    id: "user-feedback",
    label: "User feedback",
    group: "people",
    realtimeTopic: "feedback",
    relatedIdsKey: "users_feedbacks",
    path: "/self-improvement",
  },
  "self-improvement": {
    id: "self-improvement",
    label: "Self-improvement",
    group: "automation",
    realtimeTopic: "feedback",
    path: "/self-improvement",
  },
  memory: {
    id: "memory",
    label: "Memory",
    group: "knowledge",
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
    group: "knowledge",
    realtimeTopic: "memory",
    relatedIdsKey: "memory",
    path: "/memory",
  },
  "browser-agent": {
    id: "browser-agent",
    label: "Browser agent",
    group: "automation",
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
    group: "automation",
    realtimeTopic: "browser",
    path: "/browser",
  },
  analytics: {
    id: "analytics",
    label: "Analytics",
    group: "insights",
    realtimeTopic: "analytics",
    path: "/analytics",
  },
  "analytics-insights": {
    id: "analytics-insights",
    label: "Analytics insights",
    group: "insights",
    realtimeTopic: "analytics",
    relatedIdsKey: "chat_day_insights",
    path: "/analytics",
  },

  // Per-tool trace scopes. Every MCP tool call is recorded under
  // `mcp-tools-<owning-feature>` (see `server/mcp/tool-trace.ts`), so each tool
  // group has its own Debug scope. The id must equal `mcp-tools-${owner}` where
  // `owner` is the feature string passed to `registry.registerTools` in
  // `server/mcp/runtime.ts`.
  "mcp-tools-history": {
    id: "mcp-tools-history",
    label: "History tools",
    group: "tools",
    path: "/tools",
  },
  "mcp-tools-known-users": {
    id: "mcp-tools-known-users",
    label: "User tools",
    group: "tools",
    path: "/tools",
  },
  "mcp-tools-tasks": {
    id: "mcp-tools-tasks",
    label: "Task tools",
    group: "tools",
    path: "/tools",
  },
  "mcp-tools-memory": {
    id: "mcp-tools-memory",
    label: "Memory tools",
    group: "tools",
    path: "/tools",
  },
  "mcp-tools-randomness": {
    id: "mcp-tools-randomness",
    label: "Randomness tool",
    group: "tools",
    path: "/tools",
  },
  "mcp-tools-image-gen": {
    id: "mcp-tools-image-gen",
    label: "Image generation tool",
    group: "tools",
    path: "/tools",
  },
  "mcp-tools-browser-agent": {
    id: "mcp-tools-browser-agent",
    label: "Browser agent tool",
    group: "tools",
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

/** Group of a feature id, or null for an id that is not registered. */
export function featureGroup(id: string): FeatureGroup | null {
  return (FEATURES as Record<string, FeatureDescriptor>)[id]?.group ?? null;
}

/** One heading in the Debug feature filter. */
export interface FeatureOptionGroup {
  label: string;
  ids: string[];
}

/**
 * The Debug feature filter's options, grouped by product area.
 *
 * Two sources are merged: every **registered** feature (so a feature is always
 * selectable and an empty list reads as "no traces yet" rather than "this does
 * not exist") and every feature id that actually appears in the data. The second
 * source is what keeps traces from retired features — `chat-rules` from before
 * the tasks merge, say — reachable; those have no registered group, so they land
 * in a trailing "Other" heading instead of being silently dropped.
 */
export function groupedFeatureOptions(
  dataFeatures: string[] = [],
  selected?: string,
): FeatureOptionGroup[] {
  const ids = new Set<string>([...FEATURE_IDS, ...dataFeatures]);
  if (selected) ids.add(selected);

  const byGroup = new Map<FeatureGroup | "other", string[]>();
  for (const id of ids) {
    const key = featureGroup(id) ?? "other";
    const list = byGroup.get(key);
    if (list) list.push(id);
    else byGroup.set(key, [id]);
  }

  const groups: FeatureOptionGroup[] = [];
  for (const group of FEATURE_GROUPS) {
    const list = byGroup.get(group);
    if (list?.length) {
      groups.push({ label: FEATURE_GROUP_LABELS[group], ids: sortByLabel(list) });
    }
  }
  const other = byGroup.get("other");
  if (other?.length) groups.push({ label: "Other", ids: sortByLabel(other) });
  return groups;
}

const sortByLabel = (ids: string[]): string[] =>
  [...ids].sort((a, b) => featureLabel(a).localeCompare(featureLabel(b)));

/** The shared Debug view pre-filtered to a single feature's traces. */
export function featureDebugHref(id: FeatureId): string {
  return `/debug?feature=${encodeURIComponent(FEATURES[id].id)}`;
}
