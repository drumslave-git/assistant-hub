import { EMBEDDING_DIMENSIONS, type TransportConfigField } from "@assistant-hub-swarm/contracts";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
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
 * Fresh database, fresh migration chain (`store/migrations`).
 *
 * Never a foreign key into another app's database: anything that points at a
 * source-owned entity (a telegram user, a web-chat thread) stores a **scoped
 * ref** string (`tg:user:123`, `chat:thread:45` — `@assistant-hub-swarm/contracts`).
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
 * Accounts — who signs in (redesign Phase 8, PLAN.md "Accounts and roles").
 * Username + password (self-describing scrypt hash), a role, and a
 * per-account session secret: session cookies are HMAC-signed with the
 * account's own secret, so rotating it (a password change) signs out that
 * account's sessions and nobody else's. The first admin is created by
 * first-run `/setup`; admins create further accounts with a temporary
 * password (`must_change_password` holds the session at the change form
 * until it is replaced). `active = false` blocks sign-in, data intact.
 *
 * An account is also an identity: `account:<id>` refs join the person-link
 * graph, anchoring platform identities (and the memory held under them) to
 * the person who owns the account. The account IS its web-chat identity —
 * web threads key on the account id.
 */
export const accounts = pgTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    /** Sign-in name; unique case-insensitively. */
    username: text("username").notNull(),
    /** Shown in chat rosters and the dashboard; null falls back to username. */
    displayName: text("display_name"),
    /** Operator-curated alternate names (addressing, directory search). */
    aliases: text("aliases").array().notNull().default([]),
    /** Curated reply language for this person, or null (default). */
    language: text("language"),
    /** Self-describing scrypt hash (`server/auth/password.ts`). Secret. */
    passwordHash: text("password_hash").notNull(),
    role: text("role").$type<"admin" | "user">().notNull(),
    /** HMAC key this account's session tokens are signed with. Secret. */
    sessionSecret: text("session_secret").notNull(),
    /** Temporary-password gate: the session is held at the change form. */
    mustChangePassword: boolean("must_change_password").notNull().default(false),
    /** False blocks sign-in (reversible deactivation); data stays. */
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("accounts_username_unique").on(sql`lower(${t.username})`),
    check("accounts_role_check", sql`${t.role} in ('admin', 'user')`),
  ],
);

export type AccountRow = typeof accounts.$inferSelect;
export type AccountInsert = typeof accounts.$inferInsert;

/**
 * One-time self-link codes (Phase 8, PLAN.md "Identity links"): a signed-in
 * account mints a code in its profile and sends it to any connected bot;
 * the ingest recognizes it and links that platform identity to the account
 * in the person-link graph. Short-lived, single-use; minting a new code
 * retires the account's unused ones.
 */
export const accountLinkCodes = pgTable(
  "account_link_codes",
  {
    /** The code verbatim (`link-xxxxxxxx`), matched against message text. */
    code: text("code").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (t) => [index("account_link_codes_account_idx").on(t.accountId)],
);

export type AccountLinkCodeRow = typeof accountLinkCodes.$inferSelect;

/**
 * Application settings — the shared brain configuration. A single typed row
 * (`id = 'singleton'`), exactly the v1 table minus what left the core:
 *
 * - `telegram_bot_token` — became a tg-store connection row (bot token per
 *   assistant, owned by apps/tg).
 * - `active_personality_id` — personalities became assistants; "active" is
 *   replaced by transport connections binding an assistant to a chat.
 * - `owner_username` / `owner_user_id` — the global owner identity is
 *   superseded by per-assistant owner rights resolved through accounts and
 *   identity links (redesign Phase 8). `maintenance_mode_enabled` stays
 *   here — the pipeline gate that consumes that flag is a core feature.
 * - `operator_password_hash` / `session_secret` — the single operator
 *   credential became the `accounts` table (redesign Phase 8); sessions are
 *   signed per account.
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
    /**
     * The owning account (Phase 8): a sender holds owner rights in a turn
     * iff their linked account is this one (admins hold them everywhere).
     * Null only for rows created while auth was unconfigured — those are
     * admin-owned in effect (nobody else has owner rights on them).
     */
    ownerAccountId: text("owner_account_id").references(() => accounts.id, {
      onDelete: "set null",
    }),
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
    /**
     * The owning account (Phase 9). Null for managed/system rows. A
     * connection whose owner's CURRENT role is `user` is restricted: it may
     * scope only to that account's assistants and may target public
     * addresses only. Dies with its account (offboarding cascade).
     */
    ownerAccountId: text("owner_account_id").references(() => accounts.id, {
      onDelete: "cascade",
    }),
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

/** Raw binary column. node-postgres maps `bytea` to/from `Buffer` natively. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/**
 * Web chat, a core feature since the chat dissolve (redesign Phase 6): the
 * former `apps/chat` store, table for table, under `web_*` names. The chat
 * app owned these rows as a source app; with the dissolve the core is the
 * web chat, so its users, threads, transcripts and uploads live here beside
 * everything else the brain owns. Scoped refs (`chat:thread:<id>`,
 * `chat:user:<id>`) keep naming these rows on events, memory and traces —
 * `chat` stays a source id even though no separate app serves it.
 */

/**
 * Named threads. Each belongs to one ACCOUNT — the account is its own
 * web-chat identity since Phase 8 (`chat:user:<accountId>`); the separate
 * `web_users` table is gone — and is bound to one assistant **at creation**
 * (no mid-thread switching — PLAN.md).
 */
export const webThreads = pgTable(
  "web_threads",
  {
    id: text("id").primaryKey(),
    /** The account that owns the thread; threads die with their account. */
    userId: text("user_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    /** The assistant answering in this thread, fixed at creation. */
    assistantId: text("assistant_id").notNull(),
    /** Thread name — auto-generated from the first exchange, or renamed by hand. */
    name: text("name").notNull(),
    /**
     * True while `name` is the placeholder a new thread starts with. The
     * pipeline names the thread from its first exchange and clears this;
     * renaming by hand clears it too — an operator's name is not a placeholder.
     */
    titleProvisional: boolean("title_provisional").notNull().default(false),
    /** Operator-curated free-text description of the thread, or null. */
    notes: text("notes"),
    /** Operator-configured reply language for this thread, or null (default). */
    language: text("language"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("web_threads_user_idx").on(t.userId)],
);

export type WebThreadRow = typeof webThreads.$inferSelect;
export type WebThreadInsert = typeof webThreads.$inferInsert;

/**
 * The thread transcript: every user message and every assistant reply.
 * Append-only log — identity id gives natural insertion order.
 */
export const webMessages = pgTable(
  "web_messages",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    /** The thread this message belongs to; the transcript dies with it. */
    threadId: text("thread_id")
      .notNull()
      .references(() => webThreads.id, { onDelete: "cascade" }),
    /** `user` (the thread's human) or `assistant` (the bound assistant's reply). */
    role: text("role").notNull(),
    /** Full message text. */
    content: text("content").notNull(),
    /** When the message was sent. */
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    /** The message this one answers, or null (unprompted / a fresh turn). */
    replyToMessageId: bigint("reply_to_message_id", { mode: "number" }),
    /**
     * Soft delete: the outbound port can retract what it sent (a browsing
     * acknowledgement it replaces with the real answer). Rows stay so ids
     * never dangle — the thread view and the listings skip them.
     */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("web_messages_thread_sent_idx").on(t.threadId, t.sentAt),
    check("web_messages_role_check", sql`${t.role} in ('user', 'assistant')`),
  ],
);

export type WebMessageRow = typeof webMessages.$inferSelect;
export type WebMessageInsert = typeof webMessages.$inferInsert;

/**
 * Uploaded media attached to one message (image upload / voice note / a
 * produced file). Same describe lifecycle as the tg store's media, with one
 * deliberate difference: **the bytes stay after describing** — a web thread
 * is the only archive its pictures have (see `web-chat/server/media-repository.ts`).
 */
export const webMedia = pgTable(
  "web_media",
  {
    id: text("id").primaryKey(),
    /** The message the media is attached to; media dies with it. */
    messageId: bigint("message_id", { mode: "number" })
      .notNull()
      .references(() => webMessages.id, { onDelete: "cascade" }),
    /** Media kind: `image` | `voice` | `file`. */
    kind: text("kind").notNull(),
    /** Mime hint of the stored payload. */
    mimeType: text("mime_type"),
    /** The vision model's text description / the voice transcript; null until made. */
    description: text("description"),
    /** `pending` | `described` | `unavailable`. */
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Set when a description was produced. */
    describedAt: timestamp("described_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("web_media_message_idx").on(t.messageId),
    index("web_media_status_idx").on(t.status, t.createdAt),
    check("web_media_status_check", sql`${t.status} in ('pending', 'described', 'unavailable')`),
  ],
);

export type WebMediaRow = typeof webMedia.$inferSelect;
export type WebMediaInsert = typeof webMedia.$inferInsert;

/** The binary payload of a {@link webMedia} row, one row per frame. */
export const webMediaBlobs = pgTable(
  "web_media_blobs",
  {
    /** Owning media row; blobs vanish with it. */
    mediaId: text("media_id")
      .notNull()
      .references(() => webMedia.id, { onDelete: "cascade" }),
    /** Position in the frame sequence (0 for a still image / the preview frame). */
    frameIndex: integer("frame_index").notNull(),
    /** Payload bytes (normalized JPEG for images; original container for voice). */
    data: bytea("data").notNull(),
  },
  (t) => [primaryKey({ columns: [t.mediaId, t.frameIndex] })],
);

export type WebMediaBlobRow = typeof webMediaBlobs.$inferSelect;
export type WebMediaBlobInsert = typeof webMediaBlobs.$inferInsert;

/**
 * The generalized conversation store (redesign Phase 7, PLAN.md "Data
 * ownership"): every transport's users, chats, messages, media, search
 * index, summaries and feedbacks in ONE set of tables, keyed by a `source`
 * discriminator plus **source-local text ids**. The former tg store, table
 * for table, with the telegram-shaped columns generalized:
 *
 * - `telegram_message_id bigint` → `source_message_id text` — ordering
 *   always comes from the identity `id`, never from the source id, so a
 *   transport with non-numeric ids costs nothing.
 * - platform stream semantics (telegram's "a group is one shared stream,
 *   a DM is per-bot") arrive as a transport-computed `dedupe_key`; core
 *   code never inspects a chat id's sign.
 *
 * The web chat's `web_*` tables stay separate (it is a core feature, not a
 * transport); unifying them here is a later phase.
 */

/** Every person a transport has seen (the former tg `users`). */
export const sourceUsers = pgTable(
  "source_users",
  {
    /** Which transport knows them. */
    source: text("source").notNull(),
    /** Source-local user id (numeric for telegram, but never assumed so). */
    userId: text("user_id").notNull(),
    /** Platform handle (telegram @username, normalized lowercase), or null. */
    username: text("username"),
    firstName: text("first_name"),
    lastName: text("last_name"),
    /** Operator-curated alternate names/nicknames. */
    aliases: text("aliases").array().notNull().default(sql`ARRAY[]::text[]`),
    /** Operator-configured reply language for this user's direct chat. */
    language: text("language"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.source, t.userId] }),
    index("source_users_username_idx").on(t.source, t.username),
  ],
);

export type SourceUserRow = typeof sourceUsers.$inferSelect;
export type SourceUserInsert = typeof sourceUsers.$inferInsert;

/** Every group conversation a transport participates in (the former tg `chats`). */
export const sourceChats = pgTable(
  "source_chats",
  {
    source: text("source").notNull(),
    /** Source-local chat id. */
    chatId: text("chat_id").notNull(),
    /** Group title, refreshed on every message. */
    title: text("title"),
    /** The platform's own chat type string (`group` / `supergroup` / …). */
    type: text("type"),
    /** Operator-curated free-text description of the group. */
    notes: text("notes"),
    /** Operator-configured reply language for this group. */
    language: text("language"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.source, t.chatId] })],
);

export type SourceChatRow = typeof sourceChats.$inferSelect;
export type SourceChatInsert = typeof sourceChats.$inferInsert;

/** Chat ↔ user membership (the former tg `chat_members`). */
export const sourceChatMembers = pgTable(
  "source_chat_members",
  {
    source: text("source").notNull(),
    chatId: text("chat_id").notNull(),
    userId: text("user_id").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.source, t.chatId, t.userId] }),
    index("source_chat_members_user_idx").on(t.source, t.userId),
  ],
);

export type SourceChatMemberRow = typeof sourceChatMembers.$inferSelect;

/**
 * Which assistants are present in a chat, stamped from what the transport
 * actually delivered to each connection (the former tg `chat_assistants`).
 * The cross-feed and the group fan-out read it.
 */
export const sourceChatAssistants = pgTable(
  "source_chat_assistants",
  {
    source: text("source").notNull(),
    chatId: text("chat_id").notNull(),
    assistantId: text("assistant_id").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.source, t.chatId, t.assistantId] })],
);

export type SourceChatAssistantRow = typeof sourceChatAssistants.$inferSelect;

/**
 * The 1:1 mirror of every transport conversation (the former tg `messages`):
 * every human message and every assistant reply, keyed by chat. Append-only
 * log — identity id preserves insertion order; `dedupe_key` (computed by the
 * owning transport — for telegram `g:<chat>:<msg>` for the shared group
 * stream, `d:<chat>:<assistant>:<msg>` for per-bot DM streams) makes
 * re-deliveries no-ops without the core knowing the platform's stream rules.
 */
export const sourceMessages = pgTable(
  "source_messages",
  {
    /** Monotonic insertion order + PK. Preserved verbatim by the v1 import. */
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    source: text("source").notNull(),
    chatId: text("chat_id").notNull(),
    /**
     * The assistant whose conversation the row belongs to: set on every
     * assistant-authored row and on direct-chat user rows (per-assistant DM
     * streams); null on group user rows — the shared stream.
     */
    assistantId: text("assistant_id"),
    /** Source-local message id within the chat. */
    sourceMessageId: text("source_message_id").notNull(),
    /** Transport-computed stream identity — the idempotence key. */
    dedupeKey: text("dedupe_key").notNull(),
    /** `user` (a human) or `assistant` (a bot reply). */
    role: text("role").notNull(),
    /** Sender's source-local user id for `user` rows; null for `assistant`. */
    userId: text("user_id"),
    /** Full message text (or media caption). */
    content: text("content").notNull(),
    /** Source-local id this message replied to, or null. */
    replyToSourceMessageId: text("reply_to_source_message_id"),
    /** When the message existed on the platform. */
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    /** Set when a later edit rewrote the content. */
    editedAt: timestamp("edited_at", { withTimezone: true }),
    /** Set when the message is known deleted (the bot's own deletions only). */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    /** The bot's own reaction badge on this message (current state, or null). */
    botReaction: text("bot_reaction"),
    /** When the current `bot_reaction` was set. */
    botReactedAt: timestamp("bot_reacted_at", { withTimezone: true }),
    /** Live-processing semaphore — released when the turn settles. */
    processed: boolean("processed").notNull().default(true),
    /** When we captured the row (may differ from `sent_at`). */
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("source_messages_dedupe_idx").on(t.source, t.dedupeKey),
    index("source_messages_chat_sent_idx").on(t.source, t.chatId, t.sentAt),
    index("source_messages_chat_msg_idx").on(t.source, t.chatId, t.sourceMessageId),
    // Serves history_search's arbitrary-substring ILIKE (pg_trgm).
    index("source_messages_content_trgm_idx").using("gin", sql`${t.content} gin_trgm_ops`),
    check("source_messages_role_check", sql`${t.role} in ('user', 'assistant')`),
  ],
);

export type SourceMessageRow = typeof sourceMessages.$inferSelect;
export type SourceMessageInsert = typeof sourceMessages.$inferInsert;

/**
 * The searchable projection of one mirrored message (the former tg
 * `message_search`): message text + rendered media annotation, plus its
 * embedding.
 */
export const sourceMessageSearch = pgTable(
  "source_message_search",
  {
    source: text("source").notNull(),
    chatId: text("chat_id").notNull(),
    sourceMessageId: text("source_message_id").notNull(),
    /** Message text + media annotation — the string that was embedded. */
    content: text("content").notNull(),
    /** Embedding of `content`. Null when no embedding model is configured. */
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    /** When this row was last (re)built. */
    indexedAt: timestamp("indexed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.source, t.chatId, t.sourceMessageId] }),
    // FTS + trgm GIN expression indexes are added by hand in the migration.
    index("source_message_search_embedding_idx").using(
      "hnsw",
      t.embedding.op("vector_cosine_ops"),
    ),
  ],
);

export type SourceMessageSearchRow = typeof sourceMessageSearch.$inferSelect;

/**
 * Media attached to a transport message (the former tg `media`). One row per
 * media-bearing message; bytes live in {@link sourceMediaBlobs} while the
 * row is `pending` and are dropped once described — the platform is its own
 * archive.
 */
export const sourceMedia = pgTable(
  "source_media",
  {
    id: text("id").primaryKey(),
    source: text("source").notNull(),
    chatId: text("chat_id").notNull(),
    sourceMessageId: text("source_message_id").notNull(),
    /** Media kind: `photo` | `sticker` | `image_document` | `animation` | `video` | `voice`. */
    kind: text("kind").notNull(),
    /** Source-local file handle (telegram `file_id`), for re-downloads. */
    fileId: text("file_id").notNull(),
    /** Source-local stable file identity, or null. */
    fileUniqueId: text("file_unique_id"),
    /** Mime hint of the stored payload. */
    mimeType: text("mime_type"),
    /** Extra hint for the describer (a sticker's emoji), or null. */
    visionHint: text("vision_hint"),
    /** The vision model's text description / the voice transcript; null until made. */
    description: text("description"),
    /** `pending` | `described` | `unavailable`. */
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Set when a description was produced and the bytes were dropped. */
    describedAt: timestamp("described_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("source_media_chat_msg_idx").on(t.source, t.chatId, t.sourceMessageId),
    index("source_media_status_idx").on(t.status, t.createdAt),
    check(
      "source_media_status_check",
      sql`${t.status} in ('pending', 'described', 'unavailable')`,
    ),
  ],
);

export type SourceMediaRow = typeof sourceMedia.$inferSelect;

/** The binary payload of a pending {@link sourceMedia} row, one row per frame. */
export const sourceMediaBlobs = pgTable(
  "source_media_blobs",
  {
    /** Owning media row; blobs vanish with it. */
    mediaId: text("media_id")
      .notNull()
      .references(() => sourceMedia.id, { onDelete: "cascade" }),
    /** Position in the frame sequence (0 for a still image / the preview frame). */
    frameIndex: integer("frame_index").notNull(),
    /** Normalized payload bytes of this frame. */
    data: bytea("data").notNull(),
  },
  (t) => [primaryKey({ columns: [t.mediaId, t.frameIndex] })],
);

export type SourceMediaBlobRow = typeof sourceMediaBlobs.$inferSelect;

/**
 * One piece of user feedback on a bot reply, collected via a reaction and
 * the follow-up menu (the former tg `feedbacks`). Raw material; the
 * distilled outputs (preferences, corrections) live in their own tables.
 */
export const sourceFeedbacks = pgTable(
  "source_feedbacks",
  {
    id: text("id").primaryKey(),
    source: text("source").notNull(),
    chatId: text("chat_id").notNull(),
    /** Source-local id of the reacted bot reply. */
    sourceMessageId: text("source_message_id").notNull(),
    /** Who reacted (source-local user id). */
    userId: text("user_id").notNull(),
    /** `up` (👍) or `down` (👎). */
    reaction: text("reaction").notNull(),
    /** The chosen option text or the user's own words; null until answered. */
    feedback: text("feedback"),
    /** `pending` | `awaiting_text` | `completed`. */
    status: text("status").notNull().default("pending"),
    /** `quality` or `addressing`. */
    topic: text("topic").notNull().default("quality"),
    /** Source-local id of the menu message sent (for edits + reply capture). */
    menuMessageId: text("menu_message_id"),
    /** Clean model name that generated the reacted reply (informational). */
    model: text("model"),
    /** The bot's self-reflection on the reacted reply; null until written. */
    reflection: text("reflection"),
    /** Clean model name that wrote `reflection`, or null. */
    reflectionModel: text("reflection_model"),
    /** Preferences version that incorporated this feedback, or null. */
    prefsVersion: integer("prefs_version"),
    /** Self-corrections version that incorporated this feedback, or null. */
    correctionsVersion: integer("corrections_version"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("source_feedbacks_msg_user_idx").on(
      t.source,
      t.chatId,
      t.sourceMessageId,
      t.userId,
    ),
    index("source_feedbacks_status_idx").on(t.status),
    index("source_feedbacks_prefs_idx").on(t.userId, t.prefsVersion),
    check("source_feedbacks_reaction_check", sql`${t.reaction} in ('up', 'down')`),
    check(
      "source_feedbacks_status_check",
      sql`${t.status} in ('pending', 'awaiting_text', 'completed')`,
    ),
    check("source_feedbacks_topic_check", sql`${t.topic} in ('quality', 'addressing')`),
  ],
);

export type SourceFeedbackRow = typeof sourceFeedbacks.$inferSelect;

/**
 * One topic discussed in one chat on one day, distilled by the
 * summarization job (the former tg `summaries`). `message_ids` are
 * source-local message ids (the `#<id>` transcript anchors) — no FK,
 * deliberately.
 */
export const sourceSummaries = pgTable(
  "source_summaries",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    source: text("source").notNull(),
    chatId: text("chat_id").notNull(),
    /** The summarized day (`YYYY-MM-DD`) in the operator timezone. */
    summaryDate: text("summary_date").notNull(),
    /** Self-contained summary of the topic. */
    content: text("content").notNull(),
    /** Source-local message ids belonging to this topic. */
    messageIds: text("message_ids").array().notNull().default([]),
    /** Embedding of `content` for semantic recall. Null when embedding failed. */
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("source_summaries_chat_date_idx").on(t.source, t.chatId, t.summaryDate),
    // The full-text half of the hybrid search is a hand-written expression
    // index in the migration.
    index("source_summaries_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);

export type SourceSummaryRow = typeof sourceSummaries.$inferSelect;

/**
 * Registered transports (redesign Phase 7, PLAN.md "The transport
 * contract"): a transport announces itself at boot — id, name, base URL,
 * MCP path, config schemas — and the row is what every core→transport call
 * resolves against (no more per-transport env vars). `config` is the
 * transport-level opaque blob (telegram's owner identity lives there);
 * `enabled` is the admin's switch.
 */
export const transports = pgTable("transports", {
  /** The source id ("tg"). */
  id: text("id").primaryKey(),
  /** Human name ("Telegram"). */
  name: text("name").notNull(),
  /** The transport's announced internal API base URL. */
  baseUrl: text("base_url").notNull(),
  /** Path of the transport's MCP server on that base, or null when none. */
  mcpPath: text("mcp_path"),
  /**
   * Field descriptors for the per-assistant connection section the dashboard
   * renders (schema-driven forms — no build-time UI package).
   */
  connectionConfigSchema: jsonb("connection_config_schema")
    .$type<TransportConfigField[]>()
    .notNull()
    .default([]),
  /** Field descriptors for the transport-level settings section. */
  transportConfigSchema: jsonb("transport_config_schema")
    .$type<TransportConfigField[]>()
    .notNull()
    .default([]),
  /** The transport-level opaque config blob; the core never interprets it. */
  config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
  /** Admin switch: a disabled transport's events are ignored and it gets no state. */
  enabled: boolean("enabled").notNull().default(true),
  /**
   * The wire-contract major the transport announced (`CONTRACT_MAJOR` of the
   * SDK it was built with). A row whose major differs from this core's is
   * registered but refused: it gets no desired state, its events are dropped,
   * and the roster shows why (user decision, 2026-09-02).
   */
  contractMajor: integer("contract_major").notNull().default(1),
  registeredAt: timestamp("registered_at", { withTimezone: true }).notNull().defaultNow(),
  /** Stamped on every registration/heartbeat — the reachability signal. */
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type TransportRow = typeof transports.$inferSelect;
export type TransportInsert = typeof transports.$inferInsert;

/**
 * Per-assistant transport connections (the former tg `connections`,
 * generalized): the assistant's record carries one opaque config section per
 * transport (a telegram section holds the bot token). Desired state — the
 * transport fetches it at boot and on change events and reconciles; actual
 * state is published on the bus, not stored.
 */
export const assistantTransports = pgTable(
  "assistant_transports",
  {
    id: text("id").primaryKey(),
    assistantId: text("assistant_id")
      .notNull()
      .references(() => assistants.id, { onDelete: "cascade" }),
    /** The owning transport's id (`transports.id` as a plain string). */
    transport: text("transport").notNull(),
    /** The opaque connection config blob (validated only by the transport's schema). */
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    /** Desired state: whether this connection should run. */
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("assistant_transports_idx").on(t.assistantId, t.transport)],
);

export type AssistantTransportRow = typeof assistantTransports.$inferSelect;
export type AssistantTransportInsert = typeof assistantTransports.$inferInsert;

/* ------------------------------------------------------------------
 * Joined at the Phase 10 cutover (fresh start, v1 rows not migrated):
 * browser-agent runs + screenshots, the analytics insight rollups, and
 * the search-engine scoreboard - shapes carried over from v1 verbatim.
 * ------------------------------------------------------------------ */

/**
 * One download completed by a browser-agent run, as stored on the run row.
 * Structural twin of `BrowserDownloadRecord` in `features/browser-agent/types.ts`
 * (jsonb columns cannot import feature types without inverting the dependency).
 */
interface BrowserAgentDownloadJson {
  /** The page the file came from (the link the agent was on). */
  sourceUrl: string;
  filename: string;
  sizeBytes: number;
  /**
   * True when the file itself reached the chat, in which case the server copy was
   * removed. Rows written before 2026-07-29 carry `inline` (small enough to attach)
   * instead — a different question, and absent here it reads as false, which is
   * right for them: back then every download stayed on disk.
   */
  deliveredToChat?: boolean;
  /** True when the file was deleted instead of kept (restricted run, too large to attach). */
  discarded?: boolean;
  /** @deprecated Pre-2026-07-29 rows only; superseded by {@link deliveredToChat}. */
  inline?: boolean;
}

/**
 * One completed action in a run's activity feed (structural twin of
 * `BrowserRunStep` in `features/browser-agent/types.ts`, minus `seq`, which is
 * derived from array order on read).
 */
interface BrowserAgentStepJson {
  tool: string;
  action: string;
  url: string | null;
  ok: boolean;
  summary: string;
  at: string;
}


/**
 * One browser-agent run: a self-contained browsing goal the chat model queued via
 * the `browse_web` tool (or the operator queued from the dashboard), executed in
 * the background by a sub-agent LLM driving the generic browser toolset. The
 * queue is this table — the runner picks up `queued` rows oldest-first, flips
 * them `running`, and settles them `done`/`failed` with the final report.
 *
 * `chat_id` is null for dashboard-started runs: there is no chat to deliver to,
 * so the report is only stored here. `is_owner` is resolved at enqueue time and
 * gates the download tool for the whole run (recorded decision: anyone can start
 * a run; downloads are owner-only). Ids are app-generated UUIDs.
 */
export const browserAgentRuns = pgTable(
  "browser_agent_runs",
  {
    id: text("id").primaryKey(),
    /** Chat the run reports back to, or null for a dashboard-started run. */
    chatId: text("chat_id"),
    /** Forum-topic thread to deliver into, or null (chat root). */
    threadId: bigint("thread_id", { mode: "number" }),
    /** Numeric Telegram user id of whoever asked for the run, or null (dashboard). */
    createdByUserId: text("created_by_user_id"),
    /** Whether the run carries owner rights — gates the download tools. */
    isOwner: boolean("is_owner").notNull().default(false),
    /**
     * True when a standing chat rule drove the run in a group chat (whoever
     * sent the message), or lent the sender rights they did not hold: downloads
     * are then constrained to `source_urls` and must attach to the chat or be
     * discarded (user decisions, 2026-08-01).
     */
    restricted: boolean("restricted").notNull().default(false),
    /** Verbatim http(s) URLs of the triggering message, extracted in code. */
    sourceUrls: jsonb("source_urls")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** The self-contained browsing goal the agent works toward. */
    goal: text("goal").notNull(),
    /** `queued` | `running` | `done` | `failed`. */
    status: text("status").notNull().default("queued"),
    /** The agent's final report (delivered to the chat when one is bound). */
    report: text("report"),
    /** Why the run failed, when `status = 'failed'`. */
    error: text("error"),
    /** Browser actions the agent performed. */
    steps: integer("steps").notNull().default(0),
    /** Ordered activity feed — one entry per completed action (live during a run). */
    activity: jsonb("activity")
      .$type<BrowserAgentStepJson[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Files downloaded during the run (see {@link BrowserAgentDownloadJson}). */
    downloads: jsonb("downloads")
      .$type<BrowserAgentDownloadJson[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Trace id of the run's execution trace, for Debug drill-down. */
    traceId: text("trace_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** When the runner picked the run up, or null while queued. */
    startedAt: timestamp("started_at", { withTimezone: true }),
    /** When the run settled (done/failed), or null. */
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    // The runner scans for queued rows oldest-first.
    index("browser_agent_runs_status_idx").on(t.status, t.createdAt),
    index("browser_agent_runs_chat_idx").on(t.chatId),
    check(
      "browser_agent_runs_status_check",
      sql`${t.status} in ('queued', 'running', 'done', 'failed')`,
    ),
  ],
);

export type BrowserAgentRunRow = typeof browserAgentRuns.$inferSelect;
export type BrowserAgentRunInsert = typeof browserAgentRuns.$inferInsert;

/**
 * Screenshots captured during a browser-agent run, in capture order. The bytes
 * are stored here (JPEG) and served to the dashboard run view; trace events carry
 * only the `(run, seq)` reference — the same "no base64 in trace JSON" convention
 * vision media follows. Rows vanish with their run.
 */
export const browserRunScreenshots = pgTable(
  "browser_run_screenshots",
  {
    /** Owning run. */
    runId: text("run_id")
      .notNull()
      .references(() => browserAgentRuns.id, { onDelete: "cascade" }),
    /** Capture order within the run, starting at 0. */
    seq: integer("seq").notNull(),
    /** Page URL at capture time. */
    url: text("url"),
    /** Page title at capture time. */
    title: text("title"),
    /** JPEG bytes of the viewport screenshot. */
    data: bytea("data").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.seq] })],
);

export type BrowserRunScreenshotRow = typeof browserRunScreenshots.$inferSelect;
export type BrowserRunScreenshotInsert = typeof browserRunScreenshots.$inferInsert;

/**
 * One chat's LLM-derived analytics insight for one **hour** — the base grain of the
 * analytics feature's expensive pass (mood + top topic + word), computed by the
 * nightly insights job from that hour's transcript (and the existing
 * {@link chatSummaries} for the day it belongs to).
 *
 * The hour is the grain because it is the finest thing the dashboard plots: a
 * day-period chart draws 24 points, so mood has to exist at that resolution or it
 * cannot be shown beside every other metric. Everything coarser — a day's mood, a
 * month's word — is a roll-up of these rows into {@link periodInsights}, never a
 * second reading of the transcript.
 *
 * Only hours that actually hold messages are ever scored, so the cost tracks
 * conversation volume rather than the calendar.
 *
 * A scored hour is final: the job never re-reads it because its message count
 * drifted, which keeps the nightly token spend a function of new conversation and
 * nothing else. Rewriting one is an explicit operator action (Regenerate). The job
 * fails closed — an unusable model response leaves the existing row untouched.
 * `model` is the clean model name (`normalizeModelName`); informational only.
 */
export const chatHourInsights = pgTable(
  "chat_hour_insights",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    /** Telegram chat/group id this insight belongs to. */
    chatId: text("chat_id").notNull(),
    /** The insight hour (`YYYY-MM-DD HH`) as wall-clock in the operator timezone. */
    insightHour: text("insight_hour").notNull(),
    /** Mood score 0 (very negative) – 100 (very positive) for the hour's conversation. */
    moodScore: integer("mood_score").notNull(),
    /** Short mood label (e.g. `positive`, `tense`). */
    moodLabel: text("mood_label").notNull(),
    /** One-sentence justification of the mood, for the dashboard. */
    moodSummary: text("mood_summary").notNull(),
    /** The single most-discussed topic of the hour, as named by the model. */
    topTopic: text("top_topic").notNull(),
    /** The standout word of the hour, as named by the model. */
    word: text("word"),
    /** Messages the hour held when it was scored. */
    messageCount: integer("message_count").notNull(),
    /** Clean model name that produced this insight (informational). */
    model: text("model").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("chat_hour_insights_chat_hour_idx").on(t.chatId, t.insightHour)],
);

export type ChatHourInsightRow = typeof chatHourInsights.$inferSelect;
export type ChatHourInsightInsert = typeof chatHourInsights.$inferInsert;

/**
 * The period roll-up of analytics insight — "word of the period", top topic, and an
 * aggregate mood — for one chat at one granularity.
 *
 * Produced by the same nightly job once the hour rows are fresh: the mood is a
 * message-weighted average of the period's {@link chatHourInsights} (deterministic,
 * so it never depends on a fragile parse), while the word and topic are one cheap
 * LLM pass that *selects* from the hours' own words and topics rather than inventing
 * a new phrase.
 *
 * A row is written at **every** granularity an hour touches, `hour` included — the
 * hour row is a straight copy of its {@link chatHourInsights} score, costing no LLM
 * call. That redundancy is deliberate: it means every mood read, from a day's 24
 * hourly points to the all-time figure, is the same query against one table instead
 * of a special case for the finest grain.
 *
 * Always per chat. A cross-chat average of unrelated conversations is not a mood
 * anybody has, so there is no global scope.
 */
export const periodInsights = pgTable(
  "period_insights",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    /** `hour` | `day` | `week` | `month` | `year` | `all`. */
    granularity: text("granularity").notNull(),
    /** Bucket key: `YYYY-MM-DD HH`, `YYYY-MM-DD`, `YYYY-MM`, `YYYY`, or `all`. */
    bucket: text("bucket").notNull(),
    /** Telegram chat/group id this roll-up covers. */
    chatId: text("chat_id").notNull(),
    /** The standout word of the period, as named by the model. */
    wordOfPeriod: text("word_of_period").notNull(),
    /** The most-discussed topic across the period, as named by the model. */
    topTopic: text("top_topic").notNull(),
    /** Message-weighted average mood 0–100 across the period's hour rows. */
    moodScore: integer("mood_score").notNull(),
    /** Aggregate mood label. */
    moodLabel: text("mood_label").notNull(),
    /** Scored hour rows that fed this roll-up. */
    sourceUnits: integer("source_units").notNull(),
    /** Messages across the period when it was computed. */
    messageCount: integer("message_count").notNull(),
    /** Clean model name that produced the word/topic (informational). */
    model: text("model").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("period_insights_key_idx").on(t.granularity, t.bucket, t.chatId),
    check(
      "period_insights_granularity_check",
      sql`${t.granularity} in ('hour', 'day', 'week', 'month', 'year', 'all')`,
    ),
  ],
);

export type PeriodInsightRow = typeof periodInsights.$inferSelect;
export type PeriodInsightInsert = typeof periodInsights.$inferInsert;

/**
 * Scoreboard for the browser agent's search sources — one row per engine (plus the
 * API fallback), counting how often each actually returned results. The cascade
 * sorts itself by these numbers, so an engine that starts blocking us sinks and one
 * that recovers climbs back, instead of every search paying a fixed toll for a
 * dead engine ahead of a working one.
 *
 * Deliberately a live scoreboard, not a history: this holds the current standing,
 * and the per-search story is already in the run's activity feed and trace. Counts
 * are halved once their total passes a cap (see `engine-stats.ts`), so the ranking
 * keeps reacting instead of being anchored by ancient results.
 */
export const searchEngineStats = pgTable("search_engine_stats", {
  /** Source name as the code knows it (`DuckDuckGo`, `Google`, `Bing`, `Tavily`). */
  engine: text("engine").primaryKey(),
  /** Attempts that produced usable results. */
  successes: integer("successes").notNull().default(0),
  /** Attempts that produced none — blocked, captcha'd, empty, or errored. */
  failures: integer("failures").notNull().default(0),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
  /** Why the last failure failed — the operator's first clue about an engine. */
  lastError: text("last_error"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
