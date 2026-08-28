import { EMBEDDING_DIMENSIONS } from "@assistant-hub/contracts";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  vector,
} from "drizzle-orm/pg-core";

/**
 * The v2 **core store** (PLAN.md, "Data ownership") — the brain's own
 * database: assistants, settings, LLM backend config, memory,
 * self-improvement, tasks, person links, and core-job coverage markers.
 * Fresh database, fresh migration chain (`store/migrations`), populated
 * from the v1 database by `store/import-v1.ts` at cutover.
 *
 * Never a foreign key into another app's database: anything that points at a
 * source-owned entity (a telegram user, a web-chat thread) stores a **scoped
 * ref** string (`tg:user:123`, `chat:thread:45` — `@assistant-hub/contracts`).
 * `*_ref` columns hold scoped refs; source-local details that ride along
 * (telegram message ids, forum-topic thread ids) keep their own columns and
 * are only meaningful to the source the ref names.
 *
 * Tables the v1 app owns that are NOT here: raw conversation mirrors,
 * media, message search, chat summaries and feedbacks (conversation-derived
 * content is source-owned — the tg store; the core's features write it
 * through the owning app's API — user decision, 2026-08-22), analytics
 * rollups and browser-agent runs (start fresh; their tables join this
 * schema when their feature is rewired), search-engine stats (self-healing
 * scoreboard, starts fresh). Traces stay in the file-backed store, not the
 * database.
 *
 * Conventions unchanged from v1: app-generated UUID text ids for entities,
 * identity bigints for append-only logs, timestamptz everywhere.
 */

/** Named LLM backends — the operator's catalog of OpenAI-compatible endpoints. */
export const backends = pgTable(
  "backends",
  {
    id: text("id").primaryKey(),
    /** Display name (unique case-insensitively, enforced in the service). */
    name: text("name").notNull(),
    /** Base URL of the OpenAI-compatible endpoint (e.g. `.../v1`). */
    baseUrl: text("base_url").notNull(),
    /** Optional API key for the endpoint. Secret — never returned in plaintext. */
    apiKey: text("api_key"),
    /** Which inference server answers at `baseUrl` (see v1 `@/lib/llm-backend`). */
    type: text("type").notNull().default("openai-compatible"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("backends_name_idx").on(t.name)],
);

export type BackendRow = typeof backends.$inferSelect;
export type BackendInsert = typeof backends.$inferInsert;

/**
 * Application settings — the shared brain configuration. A single typed row
 * (`id = 'singleton'`), exactly the v1 table minus what left the core:
 *
 * - `telegram_bot_token` — became a tg-store connection row (bot token per
 *   assistant, owned by apps/tg).
 * - `active_personality_id` — personalities became assistants; "active" is
 *   replaced by transport connections binding an assistant to a chat.
 * - `owner_username` / `owner_user_id` — owner identity and resolution are
 *   the source app's job (user decision, 2026-08-22): they live in the tg
 *   store's settings, and the core receives the resolved is-owner flag on
 *   inbound events. `maintenance_mode_enabled` stays here — the pipeline
 *   gate that consumes that flag is a core feature.
 */
export const settings = pgTable(
  "settings",
  {
    id: text("id").primaryKey().default("singleton"),
    /** The chat (main) backend — the endpoint every reply runs on. */
    chatBackendId: text("chat_backend_id").references(() => backends.id, {
      onDelete: "restrict",
    }),
    /** Selected chat model id (from the backend's `/v1/models`). */
    model: text("model"),
    /** Operator dashboard password (self-describing scrypt hash). Secret. */
    operatorPasswordHash: text("operator_password_hash"),
    /** HMAC key for session-cookie signing. Secret. */
    sessionSecret: text("session_secret"),
    /** Tavily API key for the web-search tool. Secret. */
    tavilyApiKey: text("tavily_api_key"),
    /** Embedding backend (`/v1/embeddings`); null means "use the chat backend". */
    embeddingBackendId: text("embedding_backend_id").references(() => backends.id, {
      onDelete: "restrict",
    }),
    /** Embedding model id; must emit `EMBEDDING_DIMENSIONS`-wide vectors. */
    embeddingModel: text("embedding_model"),
    /** Image-generation backend; null → chat backend. */
    imageBackendId: text("image_backend_id").references(() => backends.id, {
      onDelete: "restrict",
    }),
    /** Image generation model id. Null disables the tool. */
    imageModel: text("image_model"),
    /** Speech (TTS) backend; null → chat backend. */
    speechBackendId: text("speech_backend_id").references(() => backends.id, {
      onDelete: "restrict",
    }),
    /** Speech (TTS) model id. Null disables voice replies. */
    speechModel: text("speech_model"),
    /** Voice name for the speech endpoint. Null → endpoint default. */
    speechVoice: text("speech_voice"),
    /** Audio (STT) backend; null → chat backend. */
    audioBackendId: text("audio_backend_id").references(() => backends.id, {
      onDelete: "restrict",
    }),
    /** Audio (STT) model id; null → transcription falls back to the chat model. */
    audioModel: text("audio_model"),
    /** How the audio role transcribes: the STT endpoint or chat `input_audio`. */
    audioTranscriptionMode: text("audio_transcription_mode")
      .$type<"transcriptions" | "chat">()
      .notNull()
      .default("transcriptions"),
    /** Vision backend; null → chat backend. */
    visionBackendId: text("vision_backend_id").references(() => backends.id, {
      onDelete: "restrict",
    }),
    /** Vision (media description) model id; null → the chat model describes. */
    visionModel: text("vision_model"),
    /** Classifier (auxiliary, interactive) backend; null → chat backend. */
    classifierBackendId: text("classifier_backend_id").references(() => backends.id, {
      onDelete: "restrict",
    }),
    /** Model for per-message classifications (addressing, honesty, rules). */
    classifierModel: text("classifier_model"),
    /** Background-jobs (auxiliary, batch) backend; null → chat backend. */
    backgroundBackendId: text("background_backend_id").references(() => backends.id, {
      onDelete: "restrict",
    }),
    /** Model for the offline jobs (summaries, memory, insights, reflection). */
    backgroundModel: text("background_model"),
    /** Browser-agent LLM backend; null → chat backend. */
    browserBackendId: text("browser_backend_id").references(() => backends.id, {
      onDelete: "restrict",
    }),
    /** Browser-agent model id; null → the chat model. */
    browserModel: text("browser_model"),
    /** Maintenance mode: only the owner can trigger LLM replies. */
    maintenanceModeEnabled: boolean("maintenance_mode_enabled").notNull().default(false),
    /**
     * Bot-to-bot loop guard (PLAN "Shared-chat behavior", user decision
     * 2026-08-24 — default 3): how many assistant-authored turns a chat may
     * hold in a row before every assistant there falls silent until a human
     * speaks again. Deterministic, never an LLM judgement. 0 stops
     * assistants from answering each other at all.
     */
    assistantLoopGuardTurns: integer("assistant_loop_guard_turns").notNull().default(3),
    /** Operator timezone (IANA name) for wall-clock features. */
    timezone: text("timezone").notNull().default("UTC"),
    /** Local wall-clock `HH:MM` at which the daily background jobs run. */
    dailyJobsRunTime: text("daily_jobs_run_time").notNull().default("04:00"),
    /** Hard ceiling (GB) on a single browser-agent download. */
    browserDownloadLimitGb: integer("browser_download_limit_gb").notNull().default(10),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("settings_singleton", sql`${t.id} = 'singleton'`)],
);

export type SettingsRow = typeof settings.$inferSelect;
export type SettingsInsert = typeof settings.$inferInsert;

/**
 * Assistants — the first-class entity replacing personalities (PLAN.md,
 * "Domain model"). Many assistants share one brain (settings, memory, tools);
 * per-assistant: the persona, transport connections (stored by the owning
 * source app, keyed by this id), and standing tasks.
 *
 * Migration seeds these from v1 personalities, **id-preserving** — so the tg
 * import can bind the v1 bot token to the assistant converted from the active
 * personality without coordinating with this script. When v1 had no active
 * personality, both imports fall back to the same fixed id
 * (`assistant-default`), created here with an empty persona.
 */
export const assistants = pgTable(
  "assistants",
  {
    id: text("id").primaryKey(),
    /** Display name (unique case-insensitively, enforced in the service). */
    name: text("name").notNull(),
    /** Persona instructions appended to the base system prompt. */
    persona: text("persona").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("assistants_name_idx").on(t.name)],
);

export type AssistantRow = typeof assistants.$inferSelect;
export type AssistantInsert = typeof assistants.$inferInsert;

/**
 * Queue of raw memory notes awaiting the nightly consolidation job. v1
 * `memory_entries` with the person keyed by scoped ref instead of a
 * `known_users` FK; `origin_chat_ref` is provenance, not scope.
 */
export const memoryEntries = pgTable(
  "memory_entries",
  {
    id: text("id").primaryKey(),
    /** `user` (a fact about one person) or `general` (shared knowledge). */
    scope: text("scope").notNull(),
    /** Scoped ref of the person the fact is about — `user` scope only. */
    userRef: text("user_ref"),
    /** The durable fact, as the model wrote it. */
    content: text("content").notNull(),
    /** Scoped ref of the chat the note was saved from (provenance). */
    originChatRef: text("origin_chat_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("memory_entries_scope_check", sql`${t.scope} in ('user', 'general')`),
    check(
      "memory_entries_user_ref_check",
      sql`(${t.scope} = 'user') = (${t.userRef} is not null)`,
    ),
    index("memory_entries_scope_user_idx").on(t.scope, t.userRef),
  ],
);

export type MemoryEntryRow = typeof memoryEntries.$inferSelect;
export type MemoryEntryInsert = typeof memoryEntries.$inferInsert;

/**
 * The consolidated long-term memory of one person — one merged document per
 * scoped user ref. Person links (below) are what make a linked person's
 * documents read as one body of memory across sources: reads resolve the
 * ref through its link group and read every member's document.
 */
export const userMemories = pgTable(
  "user_memories",
  {
    /** Scoped ref of the person (`tg:user:123`, `chat:user:<uuid>`). */
    userRef: text("user_ref").primaryKey(),
    /** The merged memory document — durable facts, one per line. */
    content: text("content").notNull(),
    /** Embedding of `content` for the semantic half of memory search. */
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("user_memories_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);

export type UserMemoryRow = typeof userMemories.$inferSelect;
export type UserMemoryInsert = typeof userMemories.$inferInsert;

/** Cross-chat shared knowledge — one merged document, injected into every reply. */
export const generalMemories = pgTable("general_memories", {
  id: text("id").primaryKey().default("singleton"),
  /** The merged general-knowledge document — durable facts, one per line. */
  content: text("content").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type GeneralMemoryRow = typeof generalMemories.$inferSelect;
export type GeneralMemoryInsert = typeof generalMemories.$inferInsert;

/**
 * Versioned per-person communication preferences, distilled by the daily
 * self-improvement job. v1 `users_communication_preferences` keyed by scoped
 * user ref. Append-only — history is kept; the latest version wins.
 */
export const communicationPreferences = pgTable(
  "communication_preferences",
  {
    id: text("id").primaryKey(),
    /** Scoped ref of the person the preferences describe. */
    userRef: text("user_ref").notNull(),
    /** Clean model name that produced this version (informational). */
    model: text("model").notNull(),
    /** What this person likes about the bot's replies. */
    likes: text("likes").notNull(),
    /** What this person dislikes about the bot's replies. */
    dislikes: text("dislikes").notNull(),
    /** Monotonic version per person; the latest wins. */
    version: integer("version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("comm_prefs_user_version_idx").on(t.userRef, t.version)],
);

export type CommunicationPreferenceRow = typeof communicationPreferences.$inferSelect;
export type CommunicationPreferenceInsert = typeof communicationPreferences.$inferInsert;

/**
 * Versioned global self-corrections, composed into the system prompt on every
 * reply. Identical to v1. Append-only — history is kept.
 */
export const selfCorrections = pgTable(
  "self_corrections",
  {
    id: text("id").primaryKey(),
    /** Clean model name that produced this version (informational). */
    model: text("model").notNull(),
    /** The correction guidelines composed into the system prompt. */
    correction: text("correction").notNull(),
    /** Monotonic global version; the latest wins. */
    version: integer("version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("self_corrections_version_idx").on(t.version)],
);

export type SelfCorrectionRow = typeof selfCorrections.$inferSelect;
export type SelfCorrectionInsert = typeof selfCorrections.$inferInsert;

/**
 * Words the addressing analyzer must stop reading as an assistant's name.
 * Bot-wide facts (v1 decision); the chat/message/user columns are provenance
 * of the report, now as scoped refs / source-local ids with no FKs — the
 * feedback rows they came from live in the tg store.
 */
export const addressingExclusions = pgTable(
  "addressing_exclusions",
  {
    id: text("id").primaryKey(),
    /** The word verbatim, as it appeared in the message that mis-triggered. */
    term: text("term").notNull(),
    /** Case-folded, whitespace-collapsed form — what the mechanical check matches. */
    normalized: text("normalized").notNull(),
    /** The display name the false match was made against (informational). */
    botDisplayName: text("bot_display_name").notNull(),
    /** Scoped ref of the chat the report came from (provenance). */
    chatRef: text("chat_ref"),
    /** Source-local message id of the reported reply (provenance). */
    sourceMessageId: bigint("source_message_id", { mode: "number" }),
    /** Scoped ref of who reported it (provenance). */
    userRef: text("user_ref"),
    /** Id of the tg-store feedback row that created it (provenance, no FK). */
    feedbackId: text("feedback_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("addressing_exclusions_normalized_idx").on(t.normalized)],
);

export type AddressingExclusionRow = typeof addressingExclusions.$inferSelect;
export type AddressingExclusionInsert = typeof addressingExclusions.$inferInsert;

/**
 * Tasks — one standing instruction plus the trigger that runs it (v1 shape),
 * now owned by an assistant and pointing at chats/people via scoped refs.
 * `thread_id` stays a source-local delivery detail (telegram forum topic),
 * meaningful only to the source `chat_ref` names.
 */
export const tasks = pgTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    /** The assistant this task belongs to; dies with it. */
    assistantId: text("assistant_id")
      .notNull()
      .references(() => assistants.id, { onDelete: "cascade" }),
    /** Scoped chat ref, or null for a global `message`/`on-reply` task. */
    chatRef: text("chat_ref"),
    /** Source-local forum-topic thread to deliver into, or null (chat root). */
    threadId: bigint("thread_id", { mode: "number" }),
    /** Scoped ref of whoever created it, or null (dashboard). */
    createdByUserRef: text("created_by_user_ref"),
    /** `chat` | `dashboard` — where the task was authored (provenance). */
    source: text("source").notNull().default("dashboard"),
    /**
     * Whether the creator held owner rights at creation time, stamped from
     * the inbound event's `sender.isOwner` (the source is authoritative for
     * owner identity — the core compares no user ids). Half the authority
     * rule: a task lends owner rights when it is dashboard-authored
     * (`source`) or this flag is set.
     */
    createdByOwner: boolean("created_by_owner").notNull().default(false),
    /** The task itself, in the author's own words. */
    instruction: text("instruction").notNull(),
    /** Background gathered at creation for timed kinds; null otherwise. */
    context: text("context"),
    /** The trigger kind — see v1 table note (message/on-reply/interval/timeout/schedule). */
    trigger: text("trigger").notNull(),
    /** Scoped refs of the senders a `message`/`on-reply` task applies to. */
    targetUserRefs: text("target_user_refs").array().notNull().default(sql`ARRAY[]::text[]`),
    /** Minutes between fires (`interval`); null otherwise. */
    everyMinutes: integer("every_minutes"),
    /** Minutes after creation the one-shot fires (`timeout`, display); null otherwise. */
    delayMinutes: integer("delay_minutes"),
    /** Local time of day `HH:MM` for `schedule`; null otherwise. */
    timeOfDay: text("time_of_day"),
    /** Weekdays for a weekly `schedule` (0=Sunday..6=Saturday); null otherwise. */
    weekdays: integer("weekdays").array(),
    /** Calendar date for a once `schedule` (`YYYY-MM-DD`); null otherwise. */
    runDate: text("run_date"),
    /** A paused task stays authored but never fires and never enters a prompt. */
    enabled: boolean("enabled").notNull().default(true),
    /** Consecutive failed fires of a due one-shot; disabled at the cap. */
    attempts: integer("attempts").notNull().default(0),
    /** The last few messages fires actually sent, newest first. */
    recentDeliveries: jsonb("recent_deliveries").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** When the task last fired, or null. */
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    /** Absolute UTC instant of the next firing; null for prompt kinds and spent rows. */
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("tasks_chat_idx").on(t.chatRef, t.enabled),
    index("tasks_due_idx").on(t.enabled, t.nextRunAt),
    check(
      "tasks_trigger_check",
      sql`${t.trigger} in ('message', 'on-reply', 'interval', 'timeout', 'schedule')`,
    ),
    check("tasks_source_check", sql`${t.source} in ('chat', 'dashboard')`),
    check(
      "tasks_scope_check",
      sql`${t.chatRef} is not null or ${t.trigger} in ('message', 'on-reply')`,
    ),
    check(
      "tasks_targets_scope_check",
      sql`${t.chatRef} is not null or cardinality(${t.targetUserRefs}) = 0`,
    ),
  ],
);

export type TaskRow = typeof tasks.$inferSelect;
export type TaskInsert = typeof tasks.$inferInsert;

/**
 * Marker of a (chat, day) pair the summarization job has processed. The
 * summaries themselves are conversation-derived CONTENT and live in the
 * owning source app's store (user decision, 2026-08-22: bot state → core,
 * conversation-derived content → app storage; core writes it through the
 * app's API). These markers are core-JOB state — which app chat-days the
 * core's summarization feature has covered — so they stay here, keyed by
 * scoped chat ref (same decision).
 */
export const chatSummaryDays = pgTable(
  "chat_summary_days",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    /** Scoped ref of the chat. */
    chatRef: text("chat_ref").notNull(),
    /** The summarized day (`YYYY-MM-DD`) in the operator timezone. */
    summaryDate: text("summary_date").notNull(),
    /** Messages the day held when it was summarized (the re-run trigger). */
    messageCount: integer("message_count").notNull(),
    /** Topics the day distilled into (0 for a day with nothing substantive). */
    topicCount: integer("topic_count").notNull(),
    summarizedAt: timestamp("summarized_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("chat_summary_days_chat_date_idx").on(t.chatRef, t.summaryDate)],
);

export type ChatSummaryDayRow = typeof chatSummaryDays.$inferSelect;
export type ChatSummaryDayInsert = typeof chatSummaryDays.$inferInsert;

/** Marker of a (chat, day) pair the passive memory-extraction job has read. */
export const memoryExtractionDays = pgTable(
  "memory_extraction_days",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    /** Scoped ref of the chat. */
    chatRef: text("chat_ref").notNull(),
    /** The extracted day (`YYYY-MM-DD`) in the operator timezone. */
    extractionDate: text("extraction_date").notNull(),
    /** Messages the day held when it was extracted (the re-run trigger). */
    messageCount: integer("message_count").notNull(),
    /** Notes the day yielded (0 for a day of pure noise). */
    noteCount: integer("note_count").notNull(),
    extractedAt: timestamp("extracted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("memory_extraction_days_chat_date_idx").on(t.chatRef, t.extractionDate),
  ],
);

export type MemoryExtractionDayRow = typeof memoryExtractionDays.$inferSelect;
export type MemoryExtractionDayInsert = typeof memoryExtractionDays.$inferInsert;

/**
 * Actions-started markers — the turn-failure rule's mechanical half (PLAN.md
 * "Turn failure handling"; user decision 2026-08-22: queue `attempts: 1`,
 * the turn runner alone decides re-enqueue). A row appears the moment a turn
 * performs its first action (a send, a tool execution) and is deleted when
 * the turn settles terminally. A failed queue job re-enqueues ONLY when no
 * row exists for its correlation id — so transient failures before any work
 * never drop messages, and nothing ever double-sends or double-executes.
 */
export const turnActions = pgTable("turn_actions", {
  /** The turn's correlation id (`<chatId>:<sourceMessageId>` today). */
  correlationId: text("correlation_id").primaryKey(),
  actedAt: timestamp("acted_at", { withTimezone: true }).notNull().defaultNow(),
});

export type TurnActionRow = typeof turnActions.$inferSelect;

/**
 * Person links — the operator-managed declaration that identities across
 * sources are the same human (PLAN.md): "tg user X = web user Y". One link
 * row is one person; members are that person's scoped user refs. Memory
 * reads resolve through the link group, so knowledge follows the person
 * across sources; unlinked users stay separate.
 */
export const personLinks = pgTable("person_links", {
  id: text("id").primaryKey(),
  /** Operator's free-text note about who this person is. */
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type PersonLinkRow = typeof personLinks.$inferSelect;
export type PersonLinkInsert = typeof personLinks.$inferInsert;

/**
 * One member identity of a person link. A scoped user ref belongs to at most
 * one link (unique), which is what keeps resolution a lookup rather than a
 * graph walk.
 */
export const personLinkMembers = pgTable(
  "person_link_members",
  {
    /** The link (person) this identity belongs to; membership dies with it. */
    linkId: text("link_id")
      .notNull()
      .references(() => personLinks.id, { onDelete: "cascade" }),
    /** Scoped user ref (`tg:user:123`, `chat:user:<uuid>`). */
    userRef: text("user_ref").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.linkId, t.userRef] }),
    uniqueIndex("person_link_members_ref_idx").on(t.userRef),
  ],
);

export type PersonLinkMemberRow = typeof personLinkMembers.$inferSelect;
export type PersonLinkMemberInsert = typeof personLinkMembers.$inferInsert;

/**
 * MCP tool connections (PLAN.md, "MCP tool connections") — the operator's
 * catalog of remote MCP servers whose tools the model may call, replacing
 * v1's code-only in-process toolset. Config lives in the DB, not in env.
 *
 * Three scope dimensions decide whether a connection's tools reach a turn
 * (user decision, 2026-08-28): global (the default), app (`app_scope` names
 * one source app — how each source's own MCP server stays out of the
 * other's prompt) and assistant (`all_assistants`, else the explicit
 * selection in `assistant_tool_connections`). Per-chat and per-user scoping
 * is not part of v2.
 */
export const toolConnections = pgTable(
  "tool_connections",
  {
    id: text("id").primaryKey(),
    /** Tool-name prefix and stable handle (`<slug>__<tool>`); unique. */
    slug: text("slug").notNull(),
    /** Display name for the dashboard. */
    name: text("name").notNull(),
    /**
     * Transport discriminator. `http` (Streamable HTTP, legacy SSE fallback)
     * is the only one v2 executes; `stdio` is modeled so adding it later
     * needs no schema or UI rework, and is refused by the service.
     */
    transport: text("transport").notNull().default("http"),
    /** Endpoint of the remote MCP server. */
    endpointUrl: text("endpoint_url").notNull(),
    /**
     * Auth headers sent on every request, `{ name: value }`. Secret — the
     * service never returns the values (the backends `api_key` precedent).
     */
    authHeaders: jsonb("auth_headers").$type<Record<string, string>>().notNull().default({}),
    /** Disabled connections keep their snapshot but are offered to nobody. */
    enabled: boolean("enabled").notNull().default(true),
    /** Null = every source; else the source app id whose turns may call it. */
    appScope: text("app_scope"),
    /** False = only the assistants listed in `assistant_tool_connections`. */
    allAssistants: boolean("all_assistants").notNull().default(true),
    /**
     * Auto-provisioned by the core (a source app's own MCP server). Managed
     * connections are reconciled from configuration, so the operator may
     * enable/scope them but not delete or re-point them.
     */
    managed: boolean("managed").notNull().default(false),
    /** Last successful discovery, and the last failure's message (if any). */
    lastDiscoveredAt: timestamp("last_discovered_at", { withTimezone: true }),
    lastError: text("last_error"),
    /**
     * What the last discovery SAW, which is not what the model is offered:
     * the operator reviews this against the applied snapshot and applies
     * exactly the set they reviewed. Null until a first discovery runs.
     */
    lastDiscoveredTools: jsonb("last_discovered_tools").$type<
      { name: string; description: string; inputSchema: Record<string, unknown> }[]
    >(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("tool_connections_slug_idx").on(t.slug),
    check("tool_connections_transport_check", sql`${t.transport} in ('http', 'stdio')`),
  ],
);

export type ToolConnectionRow = typeof toolConnections.$inferSelect;
export type ToolConnectionInsert = typeof toolConnections.$inferInsert;

/**
 * The applied tool snapshot of one connection — what the model is actually
 * offered. Discovery never writes here; only an operator's apply does (user
 * decision, 2026-08-28), which is what keeps the prompt's tool block stable
 * across a conversation instead of tracking a remote server's edits.
 */
export const toolConnectionTools = pgTable(
  "tool_connection_tools",
  {
    connectionId: text("connection_id")
      .notNull()
      .references(() => toolConnections.id, { onDelete: "cascade" }),
    /** Remote tool name, unprefixed as the server reports it. */
    name: text("name").notNull(),
    description: text("description"),
    /** JSON Schema of the tool's arguments, as discovered. */
    inputSchema: jsonb("input_schema").$type<Record<string, unknown>>().notNull(),
    appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.connectionId, t.name] })],
);

export type ToolConnectionToolRow = typeof toolConnectionTools.$inferSelect;
export type ToolConnectionToolInsert = typeof toolConnectionTools.$inferInsert;

/**
 * Which assistants may call a connection whose `all_assistants` is false.
 * Absent rows then mean "no assistant" — an explicit empty selection, not a
 * fallback to everyone.
 */
export const assistantToolConnections = pgTable(
  "assistant_tool_connections",
  {
    assistantId: text("assistant_id")
      .notNull()
      .references(() => assistants.id, { onDelete: "cascade" }),
    connectionId: text("connection_id")
      .notNull()
      .references(() => toolConnections.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.connectionId, t.assistantId] })],
);

export type AssistantToolConnectionRow = typeof assistantToolConnections.$inferSelect;
export type AssistantToolConnectionInsert = typeof assistantToolConnections.$inferInsert;
