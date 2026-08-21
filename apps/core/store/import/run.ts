import { DEFAULT_ASSISTANT_ID, scopedRef } from "@assistant-hub/contracts";
import {
  ImportReport,
  countRows,
  insertBatch,
  keysetCopy,
  requireEmptyTarget,
  syncIdentitySequence,
  withPools,
} from "@assistant-hub/db/import";
import type { Pool } from "pg";

/**
 * One-shot v1 → core-store import (PLAN.md, "Migration"): the brain half of
 * the split. Reads the v1 database with plain SQL (the v1 schema is frozen;
 * no code dependency on the v1 schema module), writes the core store created
 * by `store/migrations`, and reconciles row counts per table pair.
 *
 * Mapping (v1 → core store):
 * - backends, settings (minus telegram_bot_token / active_personality_id),
 *   self_corrections, general_memories — copied verbatim.
 * - personalities → assistants, id-preserving; when v1 has no active
 *   personality a default assistant is created under DEFAULT_ASSISTANT_ID so
 *   the tg import can bind the bot token to the same id.
 * - memory_entries / user_memories / users_communication_preferences /
 *   addressing_exclusions — known-user FKs become `tg:user:<id>` scoped
 *   refs; chat provenance becomes `tg:chat:<id>`.
 * - tasks — chat/creator/target ids become scoped refs; every task is
 *   assigned to the default assistant.
 * - chat_summaries / chat_summary_days / memory_extraction_days — identity
 *   ids preserved; chat ids become scoped refs.
 *
 * NOT copied (deliberately): telegram tables (the tg import owns them),
 * analytics rollups and browser-agent runs (start fresh), search-engine
 * stats (self-healing scoreboard), traces (file-backed, not migrated).
 */

const TARGET_TABLES = [
  "backends",
  "settings",
  "assistants",
  "memory_entries",
  "user_memories",
  "general_memories",
  "communication_preferences",
  "self_corrections",
  "addressing_exclusions",
  "tasks",
  "chat_summaries",
  "chat_summary_days",
  "memory_extraction_days",
  "person_links",
  "person_link_members",
];

const tgUser = (id: string | null): string | null => (id == null ? null : scopedRef("tg", "user", id));
const tgChat = (id: string | null): string | null => (id == null ? null : scopedRef("tg", "chat", id));

async function copyAll(
  v1: Pool,
  target: Pool,
  report: ImportReport,
  opts: { table: string; targetTable?: string; columns: string[]; sql: string },
): Promise<void> {
  const res = await v1.query(opts.sql);
  await insertBatch(target, {
    table: opts.targetTable ?? opts.table,
    columns: opts.columns,
    rows: res.rows.map((r: Record<string, unknown>) => opts.columns.map((c) => r[c])),
  });
  report.count(
    opts.targetTable ?? opts.table,
    res.rows.length,
    await countRows(target, `SELECT count(*) AS count FROM "${opts.targetTable ?? opts.table}"`),
  );
}

export async function runCoreImport(input: {
  v1Url: string;
  targetUrl: string;
  log?: (line: string) => void;
}): Promise<ImportReport> {
  const log = input.log ?? (() => {});
  return withPools(input.v1Url, input.targetUrl, async (v1, target) => {
    const report = new ImportReport();
    await requireEmptyTarget(target, TARGET_TABLES);

    // --- backends (verbatim) ---
    log("backends…");
    await copyAll(v1, target, report, {
      table: "backends",
      columns: ["id", "name", "base_url", "api_key", "type", "created_at", "updated_at"],
      sql: `SELECT id, name, base_url, api_key, type, created_at, updated_at FROM backends`,
    });

    // --- settings (singleton, minus what left the core) ---
    log("settings…");
    const settingsCols = [
      "id",
      "chat_backend_id",
      "model",
      "operator_password_hash",
      "session_secret",
      "tavily_api_key",
      "embedding_backend_id",
      "embedding_model",
      "image_backend_id",
      "image_model",
      "speech_backend_id",
      "speech_model",
      "speech_voice",
      "audio_backend_id",
      "audio_model",
      "audio_transcription_mode",
      "vision_backend_id",
      "vision_model",
      "classifier_backend_id",
      "classifier_model",
      "background_backend_id",
      "background_model",
      "browser_backend_id",
      "browser_model",
      "owner_username",
      "owner_user_id",
      "maintenance_mode_enabled",
      "timezone",
      "daily_jobs_run_time",
      "browser_download_limit_gb",
      "updated_at",
    ];
    await copyAll(v1, target, report, {
      table: "settings",
      columns: settingsCols,
      sql: `SELECT ${settingsCols.join(", ")} FROM settings`,
    });

    // --- personalities → assistants (id-preserving) + default assistant ---
    log("assistants…");
    const personalities = await v1.query(
      `SELECT id, name, prompt, created_at, updated_at FROM personalities`,
    );
    const activeRes = await v1.query(`SELECT active_personality_id FROM settings`);
    const activePersonalityId: string | null =
      activeRes.rows[0]?.active_personality_id ?? null;
    await insertBatch(target, {
      table: "assistants",
      columns: ["id", "name", "persona", "created_at", "updated_at"],
      rows: personalities.rows.map((p: Record<string, unknown>) => [
        p.id,
        p.name,
        p.prompt,
        p.created_at,
        p.updated_at,
      ]),
    });
    let createdDefault = false;
    if (activePersonalityId == null) {
      await insertBatch(target, {
        table: "assistants",
        columns: ["id", "name", "persona"],
        rows: [[DEFAULT_ASSISTANT_ID, "Assistant", ""]],
      });
      createdDefault = true;
    }
    const defaultAssistantId = activePersonalityId ?? DEFAULT_ASSISTANT_ID;
    report.count(
      "assistants",
      personalities.rows.length + (createdDefault ? 1 : 0),
      await countRows(target, `SELECT count(*) AS count FROM assistants`),
    );
    report.note(
      createdDefault
        ? `default assistant created as '${DEFAULT_ASSISTANT_ID}' (v1 had no active personality)`
        : `default assistant is the converted active personality '${defaultAssistantId}'`,
    );

    // --- memory ---
    log("memory…");
    const entries = await v1.query(
      `SELECT id, scope, user_id, content, chat_id, created_at FROM memory_entries`,
    );
    await insertBatch(target, {
      table: "memory_entries",
      columns: ["id", "scope", "user_ref", "content", "origin_chat_ref", "created_at"],
      rows: entries.rows.map((r: Record<string, unknown>) => [
        r.id,
        r.scope,
        tgUser(r.user_id as string | null),
        r.content,
        tgChat(r.chat_id as string | null),
        r.created_at,
      ]),
    });
    report.count(
      "memory_entries",
      entries.rows.length,
      await countRows(target, `SELECT count(*) AS count FROM memory_entries`),
    );

    const userMemories = await v1.query(
      `SELECT user_id, content, embedding::text AS embedding, updated_at FROM user_memories`,
    );
    await insertBatch(target, {
      table: "user_memories",
      columns: ["user_ref", "content", "embedding", "updated_at"],
      casts: { embedding: "::vector" },
      rows: userMemories.rows.map((r: Record<string, unknown>) => [
        tgUser(r.user_id as string),
        r.content,
        r.embedding,
        r.updated_at,
      ]),
    });
    report.count(
      "user_memories",
      userMemories.rows.length,
      await countRows(target, `SELECT count(*) AS count FROM user_memories`),
    );

    await copyAll(v1, target, report, {
      table: "general_memories",
      columns: ["id", "content", "updated_at"],
      sql: `SELECT id, content, updated_at FROM general_memories`,
    });

    // --- self-improvement ---
    log("self-improvement…");
    const prefs = await v1.query(
      `SELECT id, user_id, model, likes, dislikes, version, created_at
         FROM users_communication_preferences`,
    );
    await insertBatch(target, {
      table: "communication_preferences",
      columns: ["id", "user_ref", "model", "likes", "dislikes", "version", "created_at"],
      rows: prefs.rows.map((r: Record<string, unknown>) => [
        r.id,
        tgUser(r.user_id as string),
        r.model,
        r.likes,
        r.dislikes,
        r.version,
        r.created_at,
      ]),
    });
    report.count(
      "communication_preferences",
      prefs.rows.length,
      await countRows(target, `SELECT count(*) AS count FROM communication_preferences`),
    );

    await copyAll(v1, target, report, {
      table: "self_corrections",
      columns: ["id", "model", "correction", "version", "created_at"],
      sql: `SELECT id, model, correction, version, created_at FROM self_corrections`,
    });

    const exclusions = await v1.query(
      `SELECT id, term, normalized, bot_display_name, chat_id, telegram_message_id,
              user_id, feedback_id, created_at
         FROM addressing_exclusions`,
    );
    await insertBatch(target, {
      table: "addressing_exclusions",
      columns: [
        "id",
        "term",
        "normalized",
        "bot_display_name",
        "chat_ref",
        "source_message_id",
        "user_ref",
        "feedback_id",
        "created_at",
      ],
      rows: exclusions.rows.map((r: Record<string, unknown>) => [
        r.id,
        r.term,
        r.normalized,
        r.bot_display_name,
        tgChat(r.chat_id as string | null),
        r.telegram_message_id,
        tgUser(r.user_id as string | null),
        r.feedback_id,
        r.created_at,
      ]),
    });
    report.count(
      "addressing_exclusions",
      exclusions.rows.length,
      await countRows(target, `SELECT count(*) AS count FROM addressing_exclusions`),
    );

    // --- tasks (assigned to the default assistant) ---
    log("tasks…");
    const tasks = await v1.query(
      `SELECT id, chat_id, thread_id, created_by_user_id, source, instruction, context,
              trigger, target_user_ids, every_minutes, delay_minutes, time_of_day,
              weekdays, run_date, enabled, attempts, recent_deliveries, last_run_at,
              next_run_at, created_at, updated_at
         FROM tasks`,
    );
    await insertBatch(target, {
      table: "tasks",
      columns: [
        "id",
        "assistant_id",
        "chat_ref",
        "thread_id",
        "created_by_user_ref",
        "source",
        "instruction",
        "context",
        "trigger",
        "target_user_refs",
        "every_minutes",
        "delay_minutes",
        "time_of_day",
        "weekdays",
        "run_date",
        "enabled",
        "attempts",
        "recent_deliveries",
        "last_run_at",
        "next_run_at",
        "created_at",
        "updated_at",
      ],
      casts: { target_user_refs: "::text[]", weekdays: "::integer[]", recent_deliveries: "::jsonb" },
      rows: tasks.rows.map((r: Record<string, unknown>) => [
        r.id,
        defaultAssistantId,
        tgChat(r.chat_id as string | null),
        r.thread_id,
        tgUser(r.created_by_user_id as string | null),
        r.source,
        r.instruction,
        r.context,
        r.trigger,
        (r.target_user_ids as string[]).map((id) => tgUser(id)),
        r.every_minutes,
        r.delay_minutes,
        r.time_of_day,
        r.weekdays,
        r.run_date,
        r.enabled,
        r.attempts,
        JSON.stringify(r.recent_deliveries),
        r.last_run_at,
        r.next_run_at,
        r.created_at,
        r.updated_at,
      ]),
    });
    report.count(
      "tasks",
      tasks.rows.length,
      await countRows(target, `SELECT count(*) AS count FROM tasks`),
    );

    // --- conversation-derived knowledge (identity-preserving, scoped refs) ---
    log("summaries…");
    const summariesCopied = await keysetCopy<Record<string, unknown>>({
      from: v1,
      page: (cursor) => ({
        text:
          `SELECT id, chat_id, summary_date, content, message_ids,
                  embedding::text AS embedding, created_at
             FROM chat_summaries WHERE id > $1 ORDER BY id LIMIT 500`,
        values: [cursor ? cursor.id : 0],
      }),
      write: (rows) =>
        insertBatch(target, {
          table: "chat_summaries",
          columns: [
            "id",
            "chat_ref",
            "summary_date",
            "content",
            "message_ids",
            "embedding",
            "created_at",
          ],
          casts: { message_ids: "::bigint[]", embedding: "::vector" },
          overridingSystemValue: true,
          rows: rows.map((r) => [
            r.id,
            tgChat(r.chat_id as string),
            r.summary_date,
            r.content,
            r.message_ids,
            r.embedding,
            r.created_at,
          ]),
        }),
    });
    await syncIdentitySequence(target, "chat_summaries");
    report.count(
      "chat_summaries",
      summariesCopied,
      await countRows(target, `SELECT count(*) AS count FROM chat_summaries`),
    );

    for (const [source, targetTable, dateCol, countCol, atCol] of [
      ["chat_summary_days", "chat_summary_days", "summary_date", "topic_count", "summarized_at"],
      [
        "memory_extraction_days",
        "memory_extraction_days",
        "extraction_date",
        "note_count",
        "extracted_at",
      ],
    ] as const) {
      const rows = await v1.query(
        `SELECT id, chat_id, ${dateCol}, message_count, ${countCol}, ${atCol} FROM ${source} ORDER BY id`,
      );
      await insertBatch(target, {
        table: targetTable,
        columns: ["id", "chat_ref", dateCol, "message_count", countCol, atCol],
        overridingSystemValue: true,
        rows: rows.rows.map((r: Record<string, unknown>) => [
          r.id,
          tgChat(r.chat_id as string),
          r[dateCol],
          r.message_count,
          r[countCol],
          r[atCol],
        ]),
      });
      await syncIdentitySequence(target, targetTable);
      report.count(
        targetTable,
        rows.rows.length,
        await countRows(target, `SELECT count(*) AS count FROM "${targetTable}"`),
      );
    }

    // --- spot checks ---
    log("verifying…");
    const [v1Settings, coreSettings] = await Promise.all([
      v1.query(`SELECT model, timezone, daily_jobs_run_time, operator_password_hash FROM settings`),
      target.query(`SELECT model, timezone, daily_jobs_run_time, operator_password_hash FROM settings`),
    ]);
    report.check(
      JSON.stringify(v1Settings.rows[0] ?? null) === JSON.stringify(coreSettings.rows[0] ?? null),
      "settings singleton fields survived (model, timezone, daily jobs time, password hash)",
    );
    const defaultExists = await countRows(
      target,
      `SELECT count(*) AS count FROM assistants WHERE id = $1`,
      [defaultAssistantId],
    );
    report.check(defaultExists === 1, `default assistant '${defaultAssistantId}' exists`);
    const badRefs = await countRows(
      target,
      `SELECT count(*) AS count FROM memory_entries
        WHERE user_ref IS NOT NULL AND user_ref NOT LIKE 'tg:user:%'`,
    );
    report.check(badRefs === 0, "every memory entry user_ref is a tg:user scoped ref");
    const [v1Latest, coreLatest] = await Promise.all([
      v1.query(`SELECT COALESCE(MAX(version), 0) AS v FROM self_corrections`),
      target.query(`SELECT COALESCE(MAX(version), 0) AS v FROM self_corrections`),
    ]);
    report.check(
      Number(v1Latest.rows[0].v) === Number(coreLatest.rows[0].v),
      "latest self-correction version survived",
    );

    return report;
  });
}
