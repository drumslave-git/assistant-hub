import { DEFAULT_ASSISTANT_ID } from "@assistant-hub/contracts";
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
 * One-shot v1 → tg-store import (PLAN.md, "Migration"): the telegram half of
 * the split. Reads the v1 database with plain SQL (frozen schema, no code
 * dependency on the v1 module), writes the tg store created by
 * `store/migrations`, and reconciles row counts per table pair.
 *
 * Mapping (v1 → tg store):
 * - known_users → users, known_groups → chats, group_members → chat_members.
 * - chat_messages → messages (identity ids preserved — the mirror stays
 *   byte-faithful), chat_message_search → message_search (embeddings copied,
 *   not re-computed), message_media → media, media_blobs (pending bytes so
 *   the vision backfill can continue), users_feedbacks → feedbacks.
 * - chat_summaries → summaries (identity ids preserved) — conversation-
 *   derived content lives with the mirror it summarizes (user decision,
 *   2026-08-22); the core keeps only the job's coverage markers.
 * - settings.telegram_bot_token → one `connections` row bound to the default
 *   assistant (the v1 active personality's id, else DEFAULT_ASSISTANT_ID —
 *   the same rule the core import applies, so the ids agree without
 *   coordination). No token → no row (noted, not an error).
 * - settings.owner_username / owner_user_id → this app's settings singleton
 *   (owner identity is the source app's to hold and resolve — user
 *   decision, 2026-08-22).
 */

const TARGET_TABLES = [
  "users",
  "chats",
  "chat_members",
  "chat_assistants",
  "messages",
  "message_search",
  "media",
  "media_blobs",
  "feedbacks",
  "summaries",
  "connections",
  "settings",
];

export async function runTgImport(input: {
  v1Url: string;
  targetUrl: string;
  log?: (line: string) => void;
}): Promise<ImportReport> {
  const log = input.log ?? (() => {});
  return withPools(input.v1Url, input.targetUrl, async (v1, target) => {
    const report = new ImportReport();
    await requireEmptyTarget(target, TARGET_TABLES);

    // --- users / chats / membership ---
    log("users + chats…");
    const users = await v1.query(
      `SELECT user_id, username, first_name, last_name, aliases, language,
              first_seen_at, updated_at
         FROM known_users`,
    );
    await insertBatch(target, {
      table: "users",
      columns: [
        "user_id",
        "username",
        "first_name",
        "last_name",
        "aliases",
        "language",
        "first_seen_at",
        "updated_at",
      ],
      casts: { aliases: "::text[]" },
      rows: users.rows.map((r: Record<string, unknown>) => [
        r.user_id,
        r.username,
        r.first_name,
        r.last_name,
        r.aliases,
        r.language,
        r.first_seen_at,
        r.updated_at,
      ]),
    });
    report.count(
      "users",
      users.rows.length,
      await countRows(target, `SELECT count(*) AS count FROM users`),
    );

    const chats = await v1.query(
      `SELECT chat_id, title, type, notes, language, first_seen_at, updated_at FROM known_groups`,
    );
    await insertBatch(target, {
      table: "chats",
      columns: ["chat_id", "title", "type", "notes", "language", "first_seen_at", "updated_at"],
      rows: chats.rows.map((r: Record<string, unknown>) => [
        r.chat_id,
        r.title,
        r.type,
        r.notes,
        r.language,
        r.first_seen_at,
        r.updated_at,
      ]),
    });
    report.count(
      "chats",
      chats.rows.length,
      await countRows(target, `SELECT count(*) AS count FROM chats`),
    );

    const members = await v1.query(
      `SELECT chat_id, user_id, first_seen_at, last_seen_at FROM group_members`,
    );
    await insertBatch(target, {
      table: "chat_members",
      columns: ["chat_id", "user_id", "first_seen_at", "last_seen_at"],
      rows: members.rows.map((r: Record<string, unknown>) => [
        r.chat_id,
        r.user_id,
        r.first_seen_at,
        r.last_seen_at,
      ]),
    });
    report.count(
      "chat_members",
      members.rows.length,
      await countRows(target, `SELECT count(*) AS count FROM chat_members`),
    );

    // --- the message mirror (identity-preserving) ---
    log("messages…");
    const messageCols = [
      "id",
      "chat_id",
      "telegram_message_id",
      "role",
      "user_id",
      "content",
      "reply_to_message_id",
      "sent_at",
      "edited_at",
      "deleted_at",
      "bot_reaction",
      "bot_reacted_at",
      "processed",
      "created_at",
    ];
    const messagesCopied = await keysetCopy<Record<string, unknown>>({
      from: v1,
      page: (cursor) => ({
        text: `SELECT ${messageCols.join(", ")} FROM chat_messages WHERE id > $1 ORDER BY id LIMIT 1000`,
        values: [cursor ? cursor.id : 0],
      }),
      write: (rows) =>
        insertBatch(target, {
          table: "messages",
          columns: messageCols,
          overridingSystemValue: true,
          rows: rows.map((r) => messageCols.map((c) => r[c])),
        }),
    });
    await syncIdentitySequence(target, "messages");
    report.count(
      "messages",
      messagesCopied,
      await countRows(target, `SELECT count(*) AS count FROM messages`),
    );

    // --- search projection (embeddings copied verbatim) ---
    log("message search…");
    const searchCopied = await keysetCopy<Record<string, unknown>>({
      from: v1,
      page: (cursor) => ({
        text:
          `SELECT chat_id, telegram_message_id, content, embedding::text AS embedding, indexed_at
             FROM chat_message_search
            WHERE (chat_id, telegram_message_id) > ($1, $2)
            ORDER BY chat_id, telegram_message_id LIMIT 200`,
        values: cursor ? [cursor.chat_id, cursor.telegram_message_id] : ["", 0],
      }),
      write: (rows) =>
        insertBatch(target, {
          table: "message_search",
          columns: ["chat_id", "telegram_message_id", "content", "embedding", "indexed_at"],
          casts: { embedding: "::vector" },
          rows: rows.map((r) => [
            r.chat_id,
            r.telegram_message_id,
            r.content,
            r.embedding,
            r.indexed_at,
          ]),
        }),
    });
    report.count(
      "message_search",
      searchCopied,
      await countRows(target, `SELECT count(*) AS count FROM message_search`),
    );

    // --- media (+ pending bytes, so the backfill can continue) ---
    log("media…");
    const mediaCols = [
      "id",
      "chat_id",
      "telegram_message_id",
      "kind",
      "file_id",
      "file_unique_id",
      "mime_type",
      "vision_hint",
      "description",
      "status",
      "created_at",
      "described_at",
    ];
    const mediaCopied = await keysetCopy<Record<string, unknown>>({
      from: v1,
      page: (cursor) => ({
        text: `SELECT ${mediaCols.join(", ")} FROM message_media WHERE id > $1 ORDER BY id LIMIT 500`,
        values: [cursor ? cursor.id : ""],
      }),
      write: (rows) =>
        insertBatch(target, {
          table: "media",
          columns: mediaCols,
          rows: rows.map((r) => mediaCols.map((c) => r[c])),
        }),
    });
    report.count(
      "media",
      mediaCopied,
      await countRows(target, `SELECT count(*) AS count FROM media`),
    );

    const blobsCopied = await keysetCopy<Record<string, unknown>>({
      from: v1,
      page: (cursor) => ({
        text:
          `SELECT media_id, frame_index, data FROM media_blobs
            WHERE (media_id, frame_index) > ($1, $2)
            ORDER BY media_id, frame_index LIMIT 25`,
        values: cursor ? [cursor.media_id, cursor.frame_index] : ["", -1],
      }),
      write: (rows) =>
        insertBatch(target, {
          table: "media_blobs",
          columns: ["media_id", "frame_index", "data"],
          rows: rows.map((r) => [r.media_id, r.frame_index, r.data]),
        }),
    });
    report.count(
      "media_blobs",
      blobsCopied,
      await countRows(target, `SELECT count(*) AS count FROM media_blobs`),
    );

    // --- feedbacks ---
    log("feedbacks…");
    const feedbackCols = [
      "id",
      "chat_id",
      "telegram_message_id",
      "user_id",
      "reaction",
      "feedback",
      "status",
      "topic",
      "menu_message_id",
      "model",
      "reflection",
      "reflection_model",
      "prefs_version",
      "corrections_version",
      "created_at",
      "updated_at",
    ];
    const feedbacks = await v1.query(`SELECT ${feedbackCols.join(", ")} FROM users_feedbacks`);
    await insertBatch(target, {
      table: "feedbacks",
      columns: feedbackCols,
      rows: feedbacks.rows.map((r: Record<string, unknown>) => feedbackCols.map((c) => r[c])),
    });
    report.count(
      "feedbacks",
      feedbacks.rows.length,
      await countRows(target, `SELECT count(*) AS count FROM feedbacks`),
    );

    // --- chat summaries (identity-preserving) ---
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
          table: "summaries",
          columns: [
            "id",
            "chat_id",
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
            r.chat_id,
            r.summary_date,
            r.content,
            r.message_ids,
            r.embedding,
            r.created_at,
          ]),
        }),
    });
    await syncIdentitySequence(target, "summaries");
    report.count(
      "summaries",
      summariesCopied,
      await countRows(target, `SELECT count(*) AS count FROM summaries`),
    );

    // --- the bot token → a connection; the owner → this app's settings ---
    log("connection + settings…");
    const v1Settings = await v1.query(
      `SELECT telegram_bot_token, active_personality_id, owner_username, owner_user_id
         FROM settings`,
    );
    const token: string | null = v1Settings.rows[0]?.telegram_bot_token ?? null;
    const assistantId: string = v1Settings.rows[0]?.active_personality_id ?? DEFAULT_ASSISTANT_ID;
    // DM streams are per assistant since Phase 3 (a DM's chat id is the
    // peer's user id, shared by every bot) — v1 was single-bot, so its whole
    // DM history belongs to the one derived assistant.
    const stamped = await target.query(
      `UPDATE messages SET assistant_id = $1 WHERE chat_id NOT LIKE '-%'`,
      [assistantId],
    );
    report.note(`stamped ${stamped.rowCount ?? 0} DM message(s) with assistant '${assistantId}'`);
    // Group replies get the same author for the same reason: v1 had one bot,
    // so every assistant line in every group is that assistant's. Unstamped
    // they would read as "You" to a SECOND assistant added to the group
    // later, which would have it claim words it never said.
    const stampedGroup = await target.query(
      `UPDATE messages SET assistant_id = $1
        WHERE chat_id LIKE '-%' AND role = 'assistant'`,
      [assistantId],
    );
    report.note(
      `stamped ${stampedGroup.rowCount ?? 0} group repl(ies) with assistant '${assistantId}'`,
    );
    // …and it is present in every group it has history in, which is what the
    // cross-feed reads (a poller refreshes this on the next message anyway).
    const presence = await target.query(
      `INSERT INTO chat_assistants (chat_id, assistant_id)
       SELECT chat_id, $1 FROM chats
       ON CONFLICT (chat_id, assistant_id) DO NOTHING`,
      [assistantId],
    );
    report.note(`assistant '${assistantId}' marked present in ${presence.rowCount ?? 0} chat(s)`);
    if (token) {
      await insertBatch(target, {
        table: "connections",
        columns: ["id", "assistant_id", "bot_token", "enabled"],
        rows: [[crypto.randomUUID(), assistantId, token, true]],
      });
      report.note(`connection created for assistant '${assistantId}'`);
    } else {
      report.note("v1 has no telegram bot token — no connection row created");
    }
    report.count(
      "connections",
      token ? 1 : 0,
      await countRows(target, `SELECT count(*) AS count FROM connections`),
    );

    if (v1Settings.rows.length > 0) {
      await insertBatch(target, {
        table: "settings",
        columns: ["id", "owner_username", "owner_user_id"],
        rows: [["singleton", v1Settings.rows[0].owner_username, v1Settings.rows[0].owner_user_id]],
      });
    }
    report.count(
      "settings",
      v1Settings.rows.length,
      await countRows(target, `SELECT count(*) AS count FROM settings`),
    );

    // --- spot checks ---
    log("verifying…");
    await spotCheckMessages(v1, target, report);
    if (token) {
      const stored = await target.query(`SELECT bot_token, assistant_id FROM connections`);
      report.check(
        stored.rows[0]?.bot_token === token && stored.rows[0]?.assistant_id === assistantId,
        "connection carries the v1 bot token bound to the default assistant",
      );
    }
    if (v1Settings.rows.length > 0) {
      const owner = await target.query(`SELECT owner_username, owner_user_id FROM settings`);
      report.check(
        owner.rows[0]?.owner_username === v1Settings.rows[0].owner_username &&
          owner.rows[0]?.owner_user_id === v1Settings.rows[0].owner_user_id,
        "owner identity moved into this app's settings",
      );
    }
    const pendingBlobless = await countRows(
      target,
      `SELECT count(*) AS count FROM media m
        WHERE m.status = 'pending'
          AND NOT EXISTS (SELECT 1 FROM media_blobs b WHERE b.media_id = m.id)`,
    );
    const sourcePendingBlobless = await countRows(
      v1,
      `SELECT count(*) AS count FROM message_media m
        WHERE m.status = 'pending'
          AND NOT EXISTS (SELECT 1 FROM media_blobs b WHERE b.media_id = m.id)`,
    );
    report.check(
      pendingBlobless === sourcePendingBlobless,
      "every pending media row kept its bytes",
    );

    return report;
  });
}

/** Compare a sample of mirrored messages field-by-field across the copy. */
async function spotCheckMessages(v1: Pool, target: Pool, report: ImportReport): Promise<void> {
  const sample = await v1.query(
    `SELECT id, chat_id, telegram_message_id, content, sent_at, role
       FROM chat_messages ORDER BY id DESC LIMIT 5`,
  );
  for (const row of sample.rows) {
    const copied = await target.query(
      `SELECT id, content, sent_at, role FROM messages
        WHERE chat_id = $1 AND telegram_message_id = $2`,
      [row.chat_id, row.telegram_message_id],
    );
    const c = copied.rows[0];
    report.check(
      c != null &&
        Number(c.id) === Number(row.id) &&
        c.content === row.content &&
        c.role === row.role &&
        new Date(c.sent_at).getTime() === new Date(row.sent_at).getTime(),
      `message ${row.chat_id}/#${row.telegram_message_id} copied verbatim (id, content, role, sent_at)`,
    );
  }
  if (sample.rows.length === 0) {
    report.note("no messages in the source to spot-check");
  }
}
