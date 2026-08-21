import { fileURLToPath } from "node:url";

import {
  applyMigrations,
  startTestPostgres,
  type TestPostgres,
} from "@assistant-hub/db/testing";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MIGRATIONS = fileURLToPath(new URL("./migrations", import.meta.url));

/**
 * The chat store has no v1 import (web chat is new in v2) — this proves the
 * migration chain applies cleanly and the core constraints hold.
 */
describe("chat store migrations", () => {
  let pg: TestPostgres;
  let pool: Pool;

  beforeAll(async () => {
    pg = await startTestPostgres();
    const url = await pg.createDatabase("chat_store");
    await applyMigrations(url, MIGRATIONS);
    pool = new Pool({ connectionString: url });
  });

  afterAll(async () => {
    await pool?.end();
    await pg?.stop();
  });

  it("creates the store and enforces its shape", async () => {
    await pool.query(
      `INSERT INTO users (id, name, is_operator) VALUES ('user-1', 'Operator', true)`,
    );
    await pool.query(
      `INSERT INTO threads (id, user_id, assistant_id, name)
       VALUES ('thread-1', 'user-1', 'assistant-1', 'First thread')`,
    );
    const msg = await pool.query(
      `INSERT INTO messages (thread_id, role, content, sent_at)
       VALUES ('thread-1', 'user', 'hello', now()) RETURNING id`,
    );
    expect(Number(msg.rows[0].id)).toBe(1);

    // Role is constrained.
    await expect(
      pool.query(
        `INSERT INTO messages (thread_id, role, content, sent_at)
         VALUES ('thread-1', 'system', 'nope', now())`,
      ),
    ).rejects.toThrow(/messages_role_check/);

    // Deleting a user cascades through threads to messages.
    await pool.query(`DELETE FROM users WHERE id = 'user-1'`);
    const left = await pool.query(`SELECT count(*) AS count FROM messages`);
    expect(Number(left.rows[0].count)).toBe(0);
  });
});
