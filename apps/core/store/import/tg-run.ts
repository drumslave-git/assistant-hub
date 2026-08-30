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
 * One-shot v1 → conversation-store import (PLAN.md, "Migration"): the
 * telegram half, retargeted from the tg app's own store to the core's
 * generalized `source_*` tables (redesign Phase 7 — one store, stateless
 * transports). Reads the v1 database with plain SQL (frozen schema), writes
 * the core store created by `store/migrations`, and reconciles row counts
 * per table pair.
 *
 * Mapping (v1 → conversation store, everything under `source = 'tg'`):
 * - known_users → source_users, known_groups → source_chats,
 *   group_members → source_chat_members.
 * - chat_messages → source_messages (identity ids preserved; source-local
 *   ids stored as text; the dedupe key computed here the way the transport
 *   computes it at runtime — chat-wide for groups, per-assistant for DMs).
 * - chat_message_search → source_message_search (embeddings copied, not
 *   re-computed), message_media → source_media (+ pending bytes),
 *   users_feedbacks → source_feedbacks, chat_summaries → source_summaries.
 * - settings.telegram_bot_token → one `assistant_transports` row bound to
 *   the default assistant (config `{ botToken }`).
 * - settings.owner_username / owner_user_id → the `transports` row's config
 *   blob (the transport-level opaque section; the base URL is a placeholder
 *   the transport's first self-registration overwrites).
 *
 * This import is telegram-specific by nature (it reads v1 telegram tables),
 * so telegram stream rules — group ids are negative — are applied HERE, not
 * in core runtime code.
 */

const SOURCE = "tg";

const TARGET_TABLES = [
  "source_users",
  "source_chats",
  "source_chat_members",
  "source_chat_assistants",
  "source_messages",
  "source_message_search",
  "source_media",
  "source_media_blobs",
  "source_feedbacks",
  "source_summaries",
  "assistant_transports",
];

/** The runtime dedupe convention, applied by the import (telegram-aware). */
function tgDedupeKey(chatId: string, telegramMessageId: unknown, assistantId: string): string {
  return chatId.startsWith("-")
    ? `${chatId}:${telegramMessageId}`
    : `${chatId}:${assistantId}:${telegramMessageId}`;
}

export async function runTgImport(input: {
  v1Url: string;
  targetUrl: string;
  log?: (line: string) => void;
}): Promise<ImportReport> {
  const log = input.log ?? (() => {});
  return withPools(input.v1Url, input.targetUrl, async (v1, target) => {
    const report = new ImportReport();
    await requireEmptyTarget(target, TARGET_TABLES);

    // Resolved up front: the dedupe key of a DM row carries the assistant.
    const v1Settings = await v1.query(
      `SELECT telegram_bot_token, active_personality_id, owner_username, owner_user_id
         FROM settings`,
    );
    const token: string | null = v1Settings.rows[0]?.telegram_bot_token ?? null;
    const assistantId: string = v1Settings.rows[0]?.active_personality_id ?? DEFAULT_ASSISTANT_ID;

    // --- users / chats / membership ---
    log("users + chats…");
    const users = await v1.query(
      `SELECT user_id, username, first_name, last_name, aliases, language,
              first_seen_at, updated_at
         FROM known_users`,
    );
    await insertBatch(target, {
      table: "source_users",
      columns: [
        "source",
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
        SOURCE,
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
      "source_users",
      users.rows.length,
      await countRows(target, `SELECT count(*) AS count FROM source_users`),
    );

    const chats = await v1.query(
      `SELECT chat_id, title, type, notes, language, first_seen_at, updated_at FROM known_groups`,
    );
    await insertBatch(target, {
      table: "source_chats",
      columns: [
        "source",
        "chat_id",
        "title",
        "type",
        "notes",
        "language",
        "first_seen_at",
        "updated_at",
      ],
      rows: chats.rows.map((r: Record<string, unknown>) => [
        SOURCE,
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
      "source_chats",
      chats.rows.length,
      await countRows(target, `SELECT count(*) AS count FROM source_chats`),
    );

    const members = await v1.query(
      `SELECT chat_id, user_id, first_seen_at, last_seen_at FROM group_members`,
    );
    await insertBatch(target, {
      table: "source_chat_members",
      columns: ["source", "chat_id", "user_id", "first_seen_at", "last_seen_at"],
      rows: members.rows.map((r: Record<string, unknown>) => [
        SOURCE,
        r.chat_id,
        r.user_id,
        r.first_seen_at,
        r.last_seen_at,
      ]),
    });
    report.count(
      "source_chat_members",
      members.rows.length,
      await countRows(target, `SELECT count(*) AS count FROM source_chat_members`),
    );

    // --- the message mirror (identity-preserving) ---
    log("messages…");
    const targetMessageCols = [
      "id",
      "source",
      "chat_id",
      "assistant_id",
      "source_message_id",
      "dedupe_key",
      "role",
      "user_id",
      "content",
      "reply_to_source_message_id",
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
        text: `SELECT id, chat_id, telegram_message_id, role, user_id, content,
                      reply_to_message_id, sent_at, edited_at, deleted_at,
                      bot_reaction, bot_reacted_at, processed, created_at
                 FROM chat_messages WHERE id > $1 ORDER BY id LIMIT 1000`,
        values: [cursor ? cursor.id : 0],
      }),
      write: (rows) =>
        insertBatch(target, {
          table: "source_messages",
          columns: targetMessageCols,
          overridingSystemValue: true,
          rows: rows.map((r) => {
            const chatId = String(r.chat_id);
            const isGroup = chatId.startsWith("-");
            // v1 was single-bot: DM history and every group assistant line
            // belong to the one derived assistant (unstamped group replies
            // would read as "You" to a second assistant added later).
            const rowAssistant = isGroup
              ? r.role === "assistant"
                ? assistantId
                : null
              : assistantId;
            return [
              r.id,
              SOURCE,
              chatId,
              rowAssistant,
              String(r.telegram_message_id),
              tgDedupeKey(chatId, r.telegram_message_id, assistantId),
              r.role,
              r.user_id,
              r.content,
              r.reply_to_message_id == null ? null : String(r.reply_to_message_id),
              r.sent_at,
              r.edited_at,
              r.deleted_at,
              r.bot_reaction,
              r.bot_reacted_at,
              r.processed,
              r.created_at,
            ];
          }),
        }),
    });
    await syncIdentitySequence(target, "source_messages");
    report.count(
      "source_messages",
      messagesCopied,
      await countRows(target, `SELECT count(*) AS count FROM source_messages`),
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
          table: "source_message_search",
          columns: ["source", "chat_id", "source_message_id", "content", "embedding", "indexed_at"],
          casts: { embedding: "::vector" },
          rows: rows.map((r) => [
            SOURCE,
            r.chat_id,
            String(r.telegram_message_id),
            r.content,
            r.embedding,
            r.indexed_at,
          ]),
        }),
    });
    report.count(
      "source_message_search",
      searchCopied,
      await countRows(target, `SELECT count(*) AS count FROM source_message_search`),
    );

    // --- media (+ pending bytes, so the backfill can continue) ---
    log("media…");
    const mediaCopied = await keysetCopy<Record<string, unknown>>({
      from: v1,
      page: (cursor) => ({
        text: `SELECT id, chat_id, telegram_message_id, kind, file_id, file_unique_id,
                      mime_type, vision_hint, description, status, created_at, described_at
                 FROM message_media WHERE id > $1 ORDER BY id LIMIT 500`,
        values: [cursor ? cursor.id : ""],
      }),
      write: (rows) =>
        insertBatch(target, {
          table: "source_media",
          columns: [
            "id",
            "source",
            "chat_id",
            "source_message_id",
            "kind",
            "file_id",
            "file_unique_id",
            "mime_type",
            "vision_hint",
            "description",
            "status",
            "created_at",
            "described_at",
          ],
          rows: rows.map((r) => [
            r.id,
            SOURCE,
            r.chat_id,
            String(r.telegram_message_id),
            r.kind,
            r.file_id,
            r.file_unique_id,
            r.mime_type,
            r.vision_hint,
            r.description,
            r.status,
            r.created_at,
            r.described_at,
          ]),
        }),
    });
    report.count(
      "source_media",
      mediaCopied,
      await countRows(target, `SELECT count(*) AS count FROM source_media`),
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
          table: "source_media_blobs",
          columns: ["media_id", "frame_index", "data"],
          rows: rows.map((r) => [r.media_id, r.frame_index, r.data]),
        }),
    });
    report.count(
      "source_media_blobs",
      blobsCopied,
      await countRows(target, `SELECT count(*) AS count FROM source_media_blobs`),
    );

    // --- feedbacks ---
    log("feedbacks…");
    const feedbacks = await v1.query(
      `SELECT id, chat_id, telegram_message_id, user_id, reaction, feedback, status, topic,
              menu_message_id, model, reflection, reflection_model, prefs_version,
              corrections_version, created_at, updated_at
         FROM users_feedbacks`,
    );
    await insertBatch(target, {
      table: "source_feedbacks",
      columns: [
        "id",
        "source",
        "chat_id",
        "source_message_id",
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
      ],
      rows: feedbacks.rows.map((r: Record<string, unknown>) => [
        r.id,
        SOURCE,
        r.chat_id,
        String(r.telegram_message_id),
        r.user_id,
        r.reaction,
        r.feedback,
        r.status,
        r.topic,
        r.menu_message_id == null ? null : String(r.menu_message_id),
        r.model,
        r.reflection,
        r.reflection_model,
        r.prefs_version,
        r.corrections_version,
        r.created_at,
        r.updated_at,
      ]),
    });
    report.count(
      "source_feedbacks",
      feedbacks.rows.length,
      await countRows(target, `SELECT count(*) AS count FROM source_feedbacks`),
    );

    // --- chat summaries (identity-preserving) ---
    log("summaries…");
    const summariesCopied = await keysetCopy<Record<string, unknown>>({
      from: v1,
      page: (cursor) => ({
        text:
          `SELECT id, chat_id, summary_date, content, message_ids::text[] AS message_ids,
                  embedding::text AS embedding, created_at
             FROM chat_summaries WHERE id > $1 ORDER BY id LIMIT 500`,
        values: [cursor ? cursor.id : 0],
      }),
      write: (rows) =>
        insertBatch(target, {
          table: "source_summaries",
          columns: [
            "id",
            "source",
            "chat_id",
            "summary_date",
            "content",
            "message_ids",
            "embedding",
            "created_at",
          ],
          casts: { message_ids: "::text[]", embedding: "::vector" },
          overridingSystemValue: true,
          rows: rows.map((r) => [
            r.id,
            SOURCE,
            r.chat_id,
            r.summary_date,
            r.content,
            r.message_ids,
            r.embedding,
            r.created_at,
          ]),
        }),
    });
    await syncIdentitySequence(target, "source_summaries");
    report.count(
      "source_summaries",
      summariesCopied,
      await countRows(target, `SELECT count(*) AS count FROM source_summaries`),
    );

    // --- presence, the connection, and the transport config ---
    log("presence + connection + transport config…");
    // The assistant is present in every group it has history in, which is
    // what the cross-feed reads (a poller refreshes this on the next message).
    const presence = await target.query(
      `INSERT INTO source_chat_assistants (source, chat_id, assistant_id)
       SELECT source, chat_id, $1 FROM source_chats WHERE source = $2
       ON CONFLICT (source, chat_id, assistant_id) DO NOTHING`,
      [assistantId, SOURCE],
    );
    report.note(`assistant '${assistantId}' marked present in ${presence.rowCount ?? 0} chat(s)`);

    if (token) {
      await insertBatch(target, {
        table: "assistant_transports",
        columns: ["id", "assistant_id", "transport", "config", "enabled"],
        casts: { config: "::jsonb" },
        rows: [[crypto.randomUUID(), assistantId, SOURCE, JSON.stringify({ botToken: token }), true]],
      });
      report.note(`telegram connection created for assistant '${assistantId}'`);
    } else {
      report.note("v1 has no telegram bot token — no connection row created");
    }
    report.count(
      "assistant_transports",
      token ? 1 : 0,
      await countRows(target, `SELECT count(*) AS count FROM assistant_transports`),
    );

    // The transport row: owner identity in the opaque config blob; the base
    // URL is a placeholder the transport's first self-registration overwrites
    // (registration preserves config and the enabled flag).
    const ownerConfig = {
      ownerUsername: v1Settings.rows[0]?.owner_username ?? null,
      ownerUserId: v1Settings.rows[0]?.owner_user_id ?? null,
    };
    await target.query(
      `INSERT INTO transports (id, name, base_url, config, enabled)
       VALUES ($1, 'Telegram', '', $2::jsonb, true)
       ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config`,
      [SOURCE, JSON.stringify(ownerConfig)],
    );
    report.note("owner identity stored in the tg transport's config blob");

    // --- spot checks ---
    log("verifying…");
    await spotCheckMessages(v1, target, report);
    if (token) {
      const stored = await target.query(
        `SELECT config, assistant_id FROM assistant_transports WHERE transport = $1`,
        [SOURCE],
      );
      report.check(
        stored.rows[0]?.config?.botToken === token && stored.rows[0]?.assistant_id === assistantId,
        "connection carries the v1 bot token bound to the default assistant",
      );
    }
    const owner = await target.query(`SELECT config FROM transports WHERE id = $1`, [SOURCE]);
    report.check(
      owner.rows[0]?.config?.ownerUsername === (v1Settings.rows[0]?.owner_username ?? null) &&
        owner.rows[0]?.config?.ownerUserId === (v1Settings.rows[0]?.owner_user_id ?? null),
      "owner identity moved into the transport config blob",
    );
    const pendingBlobless = await countRows(
      target,
      `SELECT count(*) AS count FROM source_media m
        WHERE m.status = 'pending'
          AND NOT EXISTS (SELECT 1 FROM source_media_blobs b WHERE b.media_id = m.id)`,
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
      `SELECT id, content, sent_at, role FROM source_messages
        WHERE source = 'tg' AND chat_id = $1 AND source_message_id = $2`,
      [row.chat_id, String(row.telegram_message_id)],
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
