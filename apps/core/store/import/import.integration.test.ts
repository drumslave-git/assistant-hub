import { fileURLToPath } from "node:url";

import {
  applyMigrations,
  startTestPostgres,
  type TestPostgres,
} from "@assistant-hub/db/testing";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runCoreImport } from "./run";

// The frozen v1 chain builds the SOURCE fixture; the store chain builds the
// target. Both are this app's own directories.
const V1_MIGRATIONS = fileURLToPath(new URL("../../db/migrations", import.meta.url));
const STORE_MIGRATIONS = fileURLToPath(new URL("../migrations", import.meta.url));

const vec = (seed: number): string =>
  `[${Array.from({ length: 1024 }, (_, i) => (((i + seed) % 9) / 10).toFixed(1)).join(",")}]`;

/** All-synthetic v1 fixture — ids, names and prompts invented for this test. */
async function seedV1(v1: Pool): Promise<void> {
  await v1.query(
    `INSERT INTO known_users (user_id, username, first_name)
     VALUES ('1001', 'alice_example', 'Alice'), ('1002', 'bob_example', 'Bob')`,
  );
  await v1.query(
    `INSERT INTO backends (id, name, base_url, api_key, type)
     VALUES ('backend-1', 'Fixture Backend', 'http://backend.invalid/v1', 'sk-fixture', 'llama-cpp')`,
  );
  await v1.query(
    `INSERT INTO personalities (id, name, prompt)
     VALUES ('persona-1', 'Fixture Persona', 'be terse'),
            ('persona-2', 'Spare Persona', 'be verbose')`,
  );
  await v1.query(
    `INSERT INTO settings (id, chat_backend_id, model, active_personality_id,
                           telegram_bot_token, operator_password_hash, timezone,
                           daily_jobs_run_time, maintenance_mode_enabled,
                           owner_username, owner_user_id)
     VALUES ('singleton', 'backend-1', 'fixture-model', 'persona-1',
             '12345:fixture-token', 'scrypt:fixture', 'Europe/Kyiv', '05:30', true,
             'alice_example', '1001')`,
  );
  await v1.query(
    `INSERT INTO memory_entries (id, scope, user_id, content, chat_id)
     VALUES ('note-1', 'user', '1001', 'moved to Lisbon', '-2001'),
            ('note-2', 'general', NULL, 'the group plays chess on Fridays', '-2001')`,
  );
  await v1.query(
    `INSERT INTO user_memories (user_id, content, embedding)
     VALUES ('1001', 'Alice: durable facts', $1::vector), ('1002', 'Bob: durable facts', NULL)`,
    [vec(1)],
  );
  await v1.query(
    `INSERT INTO general_memories (id, content) VALUES ('singleton', 'shared knowledge doc')`,
  );
  await v1.query(
    `INSERT INTO users_communication_preferences (id, user_id, model, likes, dislikes, version)
     VALUES ('pref-1', '1001', 'fixture-model', 'brevity', 'emoji', 1),
            ('pref-2', '1001', 'fixture-model', 'brevity and wit', 'emoji', 2)`,
  );
  await v1.query(
    `INSERT INTO self_corrections (id, model, correction, version)
     VALUES ('corr-1', 'fixture-model', 'stop apologizing', 1)`,
  );
  await v1.query(
    `INSERT INTO addressing_exclusions (id, term, normalized, bot_display_name, chat_id,
                                        telegram_message_id, user_id)
     VALUES ('excl-1', 'Igor', 'igor', 'FixtureBot', '-2001', 12, '1002')`,
  );
  await v1.query(
    `INSERT INTO tasks (id, chat_id, created_by_user_id, source, instruction, trigger,
                        target_user_ids, time_of_day, enabled)
     VALUES ('task-1', '-2001', '1001', 'chat', 'remind about standup', 'schedule',
             ARRAY['1001','1002'], '09:00', true),
            ('task-2', NULL, NULL, 'dashboard', 'always answer in haiku', 'on-reply',
             ARRAY[]::text[], NULL, true)`,
  );
  await v1.query(
    `INSERT INTO chat_summaries (chat_id, summary_date, content, message_ids, embedding)
     VALUES ('-2001', '2026-08-01', 'talked about the fixture', ARRAY[11,12]::bigint[], $1::vector)`,
    [vec(2)],
  );
  await v1.query(
    `INSERT INTO chat_summary_days (chat_id, summary_date, message_count, topic_count)
     VALUES ('-2001', '2026-08-01', 2, 1)`,
  );
  await v1.query(
    `INSERT INTO memory_extraction_days (chat_id, extraction_date, message_count, note_count)
     VALUES ('-2001', '2026-08-01', 2, 1)`,
  );
}

describe("v1 → core store import", () => {
  let pg: TestPostgres;
  let v1Url: string;
  let targetUrl: string;
  let v1: Pool;
  let target: Pool;

  beforeAll(async () => {
    pg = await startTestPostgres();
    v1Url = await pg.createDatabase("v1_fixture");
    targetUrl = await pg.createDatabase("core_store");
    await applyMigrations(v1Url, V1_MIGRATIONS);
    await applyMigrations(targetUrl, STORE_MIGRATIONS);
    v1 = new Pool({ connectionString: v1Url });
    target = new Pool({ connectionString: targetUrl });
    await seedV1(v1);
  });

  afterAll(async () => {
    await v1?.end();
    await target?.end();
    await pg?.stop();
  });

  it("splits the brain into the core store and verifies clean", async () => {
    const report = await runCoreImport({ v1Url, targetUrl });
    expect(report.ok, report.render()).toBe(true);

    // Settings survive minus what left the core (token → tg, persona → assistants).
    const settings = await target.query(`SELECT * FROM settings`);
    expect(settings.rows[0]).toMatchObject({
      chat_backend_id: "backend-1",
      model: "fixture-model",
      timezone: "Europe/Kyiv",
      daily_jobs_run_time: "05:30",
      maintenance_mode_enabled: true,
      operator_password_hash: "scrypt:fixture",
    });
    expect(settings.rows[0].telegram_bot_token).toBeUndefined();
    expect(settings.rows[0].active_personality_id).toBeUndefined();
    // Owner identity is the tg app's now — the columns do not exist here.
    expect(settings.rows[0].owner_username).toBeUndefined();
    expect(settings.rows[0].owner_user_id).toBeUndefined();

    // Personalities became assistants, id-preserving; the active one is the
    // default, so no synthetic assistant was created.
    const assistants = await target.query(`SELECT id, name, persona FROM assistants ORDER BY id`);
    expect(assistants.rows).toEqual([
      { id: "persona-1", name: "Fixture Persona", persona: "be terse" },
      { id: "persona-2", name: "Spare Persona", persona: "be verbose" },
    ]);

    // Memory keys became scoped refs.
    const entries = await target.query(
      `SELECT id, scope, user_ref, origin_chat_ref FROM memory_entries ORDER BY id`,
    );
    expect(entries.rows).toEqual([
      { id: "note-1", scope: "user", user_ref: "tg:user:1001", origin_chat_ref: "tg:chat:-2001" },
      { id: "note-2", scope: "general", user_ref: null, origin_chat_ref: "tg:chat:-2001" },
    ]);
    const memories = await target.query(
      `SELECT user_ref, embedding IS NULL AS no_embedding FROM user_memories ORDER BY user_ref`,
    );
    expect(memories.rows).toEqual([
      { user_ref: "tg:user:1001", no_embedding: false },
      { user_ref: "tg:user:1002", no_embedding: true },
    ]);

    // Tasks belong to the default assistant and carry scoped refs.
    const tasks = await target.query(
      `SELECT id, assistant_id, chat_ref, created_by_user_ref, target_user_refs
         FROM tasks ORDER BY id`,
    );
    expect(tasks.rows).toEqual([
      {
        id: "task-1",
        assistant_id: "persona-1",
        chat_ref: "tg:chat:-2001",
        created_by_user_ref: "tg:user:1001",
        target_user_refs: ["tg:user:1001", "tg:user:1002"],
      },
      {
        id: "task-2",
        assistant_id: "persona-1",
        chat_ref: null,
        created_by_user_ref: null,
        target_user_refs: [],
      },
    ]);

    // Summaries are tg-store content now — only the job's coverage markers
    // land here, identity-preserved, with the sequence continuing.
    const days = await target.query(
      `SELECT id, chat_ref, summary_date, message_count FROM chat_summary_days`,
    );
    expect(days.rows).toEqual([
      { id: "1", chat_ref: "tg:chat:-2001", summary_date: "2026-08-01", message_count: 2 },
    ]);
    const nextSummary = await target.query(
      `INSERT INTO chat_summary_days (chat_ref, summary_date, message_count, topic_count)
       VALUES ('tg:chat:-2001', '2026-08-02', 1, 0) RETURNING id`,
    );
    expect(Number(nextSummary.rows[0].id)).toBe(2);

    // Person links exist as empty foundations (nothing to link yet).
    const links = await target.query(`SELECT count(*) AS count FROM person_links`);
    expect(Number(links.rows[0].count)).toBe(0);
  });

  it("refuses a non-empty target", async () => {
    await expect(runCoreImport({ v1Url, targetUrl })).rejects.toThrow(/refusing to import/);
  });
});
