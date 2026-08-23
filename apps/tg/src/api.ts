import { Hono } from "hono";

import type { TgDb } from "./db";
import type { BotManager } from "./bot-manager";

/**
 * This app's HTTP surface (Hono — user decision, 2026-08-23). Two zones:
 *
 * - `/health` — liveness/readiness for compose and the dashboard.
 * - `/internal/*` — the API only the core reaches (through its proxy /
 *   server code), authenticated by the shared `INTERNAL_API_TOKEN` header
 *   (user decision, 2026-08-23: shared secret, not network topology —
 *   dev runs everything on localhost). The operator listing/CRUD API and
 *   the media/search/summaries endpoints land here slice by slice.
 */

export function createApi(input: {
  db: TgDb;
  manager: BotManager;
  internalToken: string;
}): Hono {
  const app = new Hono();

  app.get("/health", async (c) => {
    // Probe the real thing, not configuration: the database answers, and the
    // poller states are reported as they are.
    try {
      await input.db.execute("select 1");
    } catch {
      return c.json({ ok: false, error: "database unreachable" }, 503);
    }
    return c.json({ ok: true, connections: input.manager.statuses() });
  });

  const internal = new Hono();
  internal.use("*", async (c, next) => {
    if (c.req.header("x-internal-token") !== input.internalToken) {
      return c.json({ error: { message: "unauthorized" } }, 401);
    }
    await next();
  });
  // First real internal endpoint: the connection statuses the dashboard's
  // bot card shows (reached via the core proxy).
  internal.get("/connections", (c) => c.json({ connections: input.manager.statuses() }));
  app.route("/internal", internal);

  return app;
}
