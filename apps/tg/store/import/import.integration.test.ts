import { fileURLToPath } from "node:url";

import {
  applyMigrations,
  startTestPostgres,
  type TestPostgres,
} from "@assistant-hub/db/testing";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runTgImport } from "./run";

/**
 * The v1 migration chain, applied to build the import's SOURCE fixture. A
 * cross-app path on purpose, test-only: the chain is frozen (the split reads
 * it, never extends it), and this whole import — script and test — is deleted
 * with `apps/core/db` at cutover. Runtime code never crosses apps.
 */
const V1_MIGRATIONS = fileURLToPath(new URL("../../../core/db/migrations", import.meta.url));
const TG_MIGRATIONS = fileURLToPath(new URL("../migrations", import.meta.url));

/** All-synthetic v1 fixture — ids, names and tokens invented for this test. */
async function seedV1(v1: Pool): Promise<void> {
  await v1.query(
    `INSERT INTO known_users (user_id, username, first_name, aliases, language)
     VALUES ('1001', 'alice_example', 'Alice', ARRAY['Al'], 'English'),
            ('1002', 'bob_example', 'Bob', ARRAY[]::text[], NULL)`,
  );
  await v1.query(
    `INSERT INTO known_groups (chat_id, title, type, notes)
     VALUES ('-2001', 'Fixture Group', 'supergroup', 'seeded for the import test')`,
  );
  await v1.query(
    `INSERT INTO group_members (chat_id, user_id)
     VALUES ('-2001', '1001'), ('-2001', '1002')`,
  );
  await v1.query(
    `INSERT INTO chat_messages (chat_id, telegram_message_id, role, user_id, content, sent_at)
     VALUES ('-2001', 11, 'user', '1001', 'hello from the fixture', now() - interval '2 hours'),
            ('-2001', 12, 'assistant', NULL, 'fixture reply', now() - interval '1 hour'),
            ('1001',  21, 'user', '1001', 'dm message', now())`,
  );
  await v1.query(
    `INSERT INTO message_media (id, chat_id, telegram_message_id, kind, file_id, status, description)
     VALUES ('media-1', '-2001', 11, 'photo', 'file-abc', 'pending', NULL),
            ('media-2', '1001',  21, 'sticker', 'file-def', 'described', 'a fixture sticker')`,
  );
  await v1.query(`INSERT INTO media_blobs (media_id, frame_index, data) VALUES ('media-1', 0, $1)`, [
    Buffer.from("fixture-jpeg-bytes"),
  ]);
  const vec = `[${Array.from({ length: 1024 }, (_, i) => ((i % 7) / 10).toFixed(1)).join(",")}]`;
  await v1.query(
    `INSERT INTO chat_message_search (chat_id, telegram_message_id, content, embedding)
     VALUES ('-2001', 11, 'hello from the fixture [photo]', $1::vector),
            ('-2001', 12, 'fixture reply', NULL)`,
    [vec],
  );
  await v1.query(
    `INSERT INTO users_feedbacks (id, chat_id, telegram_message_id, user_id, reaction, status, model, feedback)
     VALUES ('fb-1', '-2001', 12, '1001', 'up', 'completed', 'fixture-model', 'nice reply')`,
  );
  await v1.query(
    `INSERT INTO chat_summaries (chat_id, summary_date, content, message_ids)
     VALUES ('-2001', '2026-08-01', 'talked about the fixture', ARRAY[11,12]::bigint[])`,
  );
  await v1.query(
    `INSERT INTO personalities (id, name, prompt) VALUES ('persona-1', 'Fixture Persona', 'be terse')`,
  );
  await v1.query(
    `INSERT INTO settings (id, telegram_bot_token, active_personality_id,
                           owner_username, owner_user_id)
     VALUES ('singleton', '12345:fixture-token', 'persona-1', 'alice_example', '1001')`,
  );
}

describe("v1 → tg store import", () => {
  let pg: TestPostgres;
  let v1Url: string;
  let targetUrl: string;
  let v1: Pool;
  let target: Pool;

  beforeAll(async () => {
    pg = await startTestPostgres();
    v1Url = await pg.createDatabase("v1_fixture");
    targetUrl = await pg.createDatabase("tg_store");
    await applyMigrations(v1Url, V1_MIGRATIONS);
    await applyMigrations(targetUrl, TG_MIGRATIONS);
    v1 = new Pool({ connectionString: v1Url });
    target = new Pool({ connectionString: targetUrl });
    await seedV1(v1);
  });

  afterAll(async () => {
    await v1?.end();
    await target?.end();
    await pg?.stop();
  });

  it("copies everything, binds the bot token, and verifies clean", async () => {
    const report = await runTgImport({ v1Url, targetUrl });
    expect(report.ok, report.render()).toBe(true);

    const users = await target.query(`SELECT user_id, username, aliases FROM users ORDER BY user_id`);
    expect(users.rows).toHaveLength(2);
    expect(users.rows[0]).toMatchObject({ user_id: "1001", username: "alice_example" });
    expect(users.rows[0].aliases).toEqual(["Al"]);

    // The mirror is identity-preserving and byte-faithful.
    const messages = await target.query(
      `SELECT id, chat_id, telegram_message_id, content, role FROM messages ORDER BY id`,
    );
    expect(messages.rows).toHaveLength(3);
    expect(messages.rows.map((r) => Number(r.id))).toEqual([1, 2, 3]);
    expect(messages.rows[0]).toMatchObject({
      chat_id: "-2001",
      content: "hello from the fixture",
      role: "user",
    });

    // The identity sequence continues past the copied ids.
    const next = await target.query(
      `INSERT INTO messages (chat_id, telegram_message_id, role, content, sent_at)
       VALUES ('-2001', 99, 'user', 'post-import row', now()) RETURNING id`,
    );
    expect(Number(next.rows[0].id)).toBe(4);

    // Search rows kept their embeddings (and their absence).
    const search = await target.query(
      `SELECT telegram_message_id, embedding IS NULL AS no_embedding
         FROM message_search ORDER BY telegram_message_id`,
    );
    expect(search.rows).toEqual([
      { telegram_message_id: "11", no_embedding: false },
      { telegram_message_id: "12", no_embedding: true },
    ]);

    // Pending media kept its bytes; described media has none to keep.
    const blob = await target.query(`SELECT data FROM media_blobs WHERE media_id = 'media-1'`);
    expect(blob.rows[0].data.toString()).toBe("fixture-jpeg-bytes");

    // Summaries came along with identity ids and their telegram message ids.
    const summaries = await target.query(
      `SELECT id, chat_id, summary_date, message_ids FROM summaries`,
    );
    expect(summaries.rows).toEqual([
      { id: "1", chat_id: "-2001", summary_date: "2026-08-01", message_ids: ["11", "12"] },
    ]);

    // The v1 bot token became a connection on the converted active personality.
    const connection = await target.query(`SELECT assistant_id, bot_token, enabled FROM connections`);
    expect(connection.rows).toEqual([
      { assistant_id: "persona-1", bot_token: "12345:fixture-token", enabled: true },
    ]);

    // v1 was single-bot, so every message it authored belongs to the derived
    // assistant — DMs (whose ids are per bot) and group replies alike. Group
    // USER rows stay unattributed: the group is one shared stream.
    const authored = await target.query(
      `SELECT telegram_message_id, assistant_id FROM messages
        WHERE telegram_message_id < 99 ORDER BY telegram_message_id`,
    );
    expect(authored.rows).toEqual([
      { telegram_message_id: "11", assistant_id: null },
      { telegram_message_id: "12", assistant_id: "persona-1" },
      { telegram_message_id: "21", assistant_id: "persona-1" },
    ]);

    // And it is recorded as present in the groups it has history in — what
    // the cross-feed reads to know who else is listening in a chat.
    const presence = await target.query(
      `SELECT chat_id, assistant_id FROM chat_assistants ORDER BY chat_id`,
    );
    expect(presence.rows).toEqual([{ chat_id: "-2001", assistant_id: "persona-1" }]);

    // The owner identity now lives in this app's settings singleton.
    const settings = await target.query(`SELECT owner_username, owner_user_id FROM settings`);
    expect(settings.rows).toEqual([{ owner_username: "alice_example", owner_user_id: "1001" }]);
  });

  it("refuses a non-empty target", async () => {
    await expect(runTgImport({ v1Url, targetUrl })).rejects.toThrow(/refusing to import/);
  });
});
