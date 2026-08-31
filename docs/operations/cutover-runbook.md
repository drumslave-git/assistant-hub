# Cutover Runbook — v1 → assistant-hub

The one-time production migration from the v1 `llm-tg-bot` deployment onto
assistant-hub's single core database. Hard requirement: **no brain-data
loss**; downtime during the window is acceptable. Do not start until the
[rehearsal](v1-split.md) has passed clean at least once against a recent
copy of the production database.

What carries over: users, groups, message history, media and vision
descriptions, memory, sender preferences, self-corrections, addressing
exclusions, tasks, personalities (as assistants), settings, the bot token
(as the default assistant's telegram connection), and the operator password
(as the first admin account, username `admin`). The v1 owner's telegram
identity is person-linked to that admin, so owner rights and memory
continuity survive without any global-owner config. Traces, analytics
rollups, browser-agent runs and search-engine stats start fresh.

## Before the window

1. **Rehearse until clean** (see [v1-split.md](v1-split.md)) — both imports
   must end `VERIFICATION PASSED`.
2. Build/pull the release images (`assistant-hub-core`, `assistant-hub-tg`)
   and have the new compose file ready with `DATABASE_URL` pointing at the
   new core database.
3. Confirm the rollback path works: you can restore the backup and start
   the last v1 image.

## The window

1. **Stop the old stack** (bot polling ends; Telegram queues nothing —
   messages sent during downtime arrive when the new poller starts).

   ```bash
   docker compose down
   ```

2. **Back up v1, keep it read-only.** This backup is the rollback.

   ```bash
   docker compose up -d db
   docker compose exec -T db pg_dump -U bot -d bot > v1-final-backup.sql
   ```

   Keep the old `bot` database untouched after this point — the import only
   ever reads it.

3. **Create and migrate the core database** (on the same Postgres service,
   or a new one):

   ```bash
   node packages/db/scripts/create-database.mjs "postgres://bot:bot@localhost:5432/core"
   npm run db:migrate -w @assistant-hub/core     # DATABASE_URL → the core db
   ```

4. **Run both imports** against the LIVE v1 database (it is stopped, so it
   is as consistent as a dump):

   ```bash
   V1_DATABASE_URL=postgres://bot:bot@localhost:5432/bot \
     npm run import:v1 -w @assistant-hub/core
   V1_DATABASE_URL=postgres://bot:bot@localhost:5432/bot \
     npm run import:tg-v1 -w @assistant-hub/core
   ```

5. **Read both verification reports.** Anything but `VERIFICATION PASSED`
   twice → **abort**: fix, re-run the imports against a fresh re-migrated
   core database (drop it first), or roll back. Never start the new stack
   over a failed import.

6. **Start the new stack** with `DATABASE_URL` pointing at the core
   database:

   ```bash
   docker compose up -d
   ```

7. **Smoke-check**, in order:
   - `GET /api/health` → `ok`, database connected, configuration read;
   - sign in at `/login` as `admin` with the old operator password;
   - the core log shows `transport 'tg' registered`, the tg log shows the
     desired connection count, the poller runs as the old bot;
   - send the bot one Telegram message and get a reply;
   - open `/history` and see the old conversations; `/memory` shows the
     documents; the assistant's persona answers as before.

8. Trace files (`data/traces/`) and downloads are directories, not
   database rows — carry the old volumes over if you want the archive, or
   start clean (PLAN allows either; traces are not migrated data).

## Rollback

At any point before new traffic has been served:

```bash
docker compose down
# restore the old image tag in compose, DATABASE_URL back to the v1 db
docker compose up -d
```

The v1 database was never written to, so rollback is a restart, not a
restore. If it was damaged anyway, restore `v1-final-backup.sql` into a
fresh database first.

## After

- Deactivate nothing, delete nothing for at least one comfortable week —
  the old database and backup stay read-only until you trust the new stack.
- The GitHub repository rename to `assistant-hub` is a repo-settings
  action; git remotes redirect automatically.
