# Backup and restore

There are **three** stores, and only one of them is a database. Backing up Postgres and
calling it done loses the trace archive — and the messages that were in flight
between the transport and the core.

## What state exists

| State | Location | Backed up by | Loss impact |
| --- | --- | --- | --- |
| Everything relational — accounts, assistants and their bot connections, the conversation mirror, summaries, memory, person links, feedback, tasks, settings, the backends catalog, tool connections, web-chat threads, browser runs, media bytes while pending | Postgres | `pg_dump` | Total: the bot forgets everything and loses its configuration |
| Queued transport events and inbound turns not yet consumed by the core | `data/redis` (the Redis append-only file) | Nothing automatic | Only what was queued at that moment. Safe to lose **only** if you accept dropping the messages the transport had forwarded but the core had not yet answered |
| Trace archive — **complete** LLM request/response bodies and every system prompt | `data/traces/traces-YYYY-MM.ndjson` | Nothing automatic | Analytics token/model history and all debug history for past months |
| Browser-agent downloads | `data/downloads` | Nothing automatic (but it **is** a mounted host directory, so it survives container replacement) | Files the agent fetched. A file too large to attach to the chat exists only here |
| Running (unsettled) traces | RAM | — | Dropped on any crash. By design |
| Settled-but-unflushed traces | RAM, ≤60s | — | Graceful shutdown flushes first |
| Live job progress, browser live state, poller state | RAM | — | Transient by design; the transport rebuilds its pollers from the core's desired state at boot |

Nothing needs the trace archive to *run*. What it needs it for is history: Analytics'
token and model-performance figures are read from those files, so pruning or losing a
month erases those numbers for that month even though nothing breaks.

The Telegram transport itself holds nothing: no database, no files. Everything it
needs — bot tokens included — it fetches from the core at registration.

## Database

### Dump

With the Compose stack up (credentials default to `bot`/`bot`/`bot`):

```bash
docker compose exec -T db pg_dump -U bot -d bot > backup.sql
```

For a custom-format dump (compressed, restorable selectively):

```bash
docker compose exec -T db pg_dump -U bot -d bot -Fc > backup.dump
```

### Restore

Into a fresh database:

```bash
docker compose exec -T db psql -U bot -d bot < backup.sql
```

From a custom-format dump:

```bash
docker compose exec -T db pg_restore -U bot -d bot --clean --if-exists < backup.dump
```

The restored database must have the `vector` and `pg_trgm` extensions available — the
`pgvector/pgvector:pg17` image provides both, and the migrations enable them. After
restoring into a database at an older schema, bring the app up: its entrypoint applies
pending migrations before serving.

### Reset

The Compose `db` service persists into a host directory (`./data/pg`). To wipe the
database, stop the stack and delete that directory. The next start creates a fresh one
and the app migrates it.

Note that wiping the database also clears every **account**, so the next dashboard
visit goes to `/setup` and whoever reaches it first creates the new first admin. It
also clears every assistant and bot connection: the transport re-registers with the
empty core and idles until a bot is connected again.

## Redis

The `redis` service persists its append-only file into `./data/redis`. It holds
exactly what is queued right now — transport events the core has not consumed, turns
the pipeline has not run — and nothing durable: once the core has answered, the
message lives in Postgres and the traces.

So this directory needs a backup only if you cannot accept dropping in-flight
messages across a disaster. Copy it while the stack is stopped for a clean file; the
transport re-registers automatically and the core drains whatever the restored queue
holds when it starts.

## Trace archive

Ordinary files. Copy the directory:

```bash
tar czf traces-backup.tar.gz -C ./data traces
```

Restore by unpacking it back into place with the container user able to write it. The
store discovers month files by name (`traces-YYYY-MM.ndjson`), so a restored month is
picked up without any registration step.

Two cautions:

- **Treat it like the database dump, or more carefully.** It is effectively a full
  chat-log archive plus every system prompt the bot has been given. Do not share it
  casually; restrict its filesystem permissions.
- **Copy it while the app is stopped, or accept a partial tail.** The current month's
  file is appended to every 60s. A copy taken mid-flush can end with a truncated final
  line — which the reader tolerates, but you lose that trace.

## Configuration

Configuration lives in the database — the `settings` row, the `backends` catalog and
each assistant's transport connection — so a database dump captures it, **including
every backend API key, the Tavily key and every bot token in plaintext**, plus the
accounts' password hashes and session secrets. Which is another reason to protect the
dump.

What is *not* in the dump: `DATABASE_URL`, `REDIS_URL`, `INTERNAL_API_TOKEN`, `TZ`,
the transport's `CORE_API_URL`/`SELF_URL` and the Compose variables. Keep your `.env`
(or your secret files) under the same backup regime, and remember `<NAME>_FILE`
Docker-secret variants exist on the core if you would rather they never appear in a
compose file at all. A restored stack with a *different* `INTERNAL_API_TOKEN` on one
side simply never registers its transport — set it once, for both.

## Recommended routine

A minimal, honest setup:

```bash
# nightly, before the daily jobs run time
docker compose exec -T db pg_dump -U bot -d bot -Fc > "/backups/db-$(date +%F).dump"
tar czf "/backups/traces-$(date +%F).tar.gz" -C /srv/assistant-hub/data traces
```

- Run it **before** `dailyJobsRunTime` (default `04:00`), so a backup never coincides
  with the night's LLM work.
- Keep the two artifacts together — a database restored next to the wrong month's
  traces will show Analytics figures that do not match its message counts.
- Verify a restore at least once into a scratch database. An unverified backup is a
  guess.

## Disaster recovery

1. Bring up a fresh stack (`docker compose up -d`) with the same `INTERNAL_API_TOKEN`.
   Do **not** visit `/setup` yet.
2. Restore the database dump.
3. Unpack the trace archive into `./data/traces`, ensuring the container user can
   write it. Restore `./data/redis` too if you kept it; otherwise accept that whatever
   was queued is gone.
4. Restart the core (`docker compose restart app`) so it picks up the restored trace
   directory and re-warms the current month. The transport re-registers by itself and
   rebuilds its pollers from the restored connections.
5. Sign in with a **restored** account (the dump carries the password hashes — you do
   not run setup again). If nobody remembers a password, see
   [Locked out of the dashboard](troubleshooting.md#locked-out-of-the-dashboard).
6. Check Overview. Core: Database, LLM endpoint, Model, Bots. Storage: Trace
   storage, Downloads. All six should be green; the bots card reads Running with the
   bot's `@username`.
7. Start any connection that shows Stopped — from its assistant's editor on
   `/assistants`.

## Retention

There is no automatic retention for traces (user decision, 2026-07-20). Month files
accumulate until you prune them from the Debug page's Prune card, which deletes every
month **strictly older** than the one you pick.

Prune deliberately, and after you have a backup of the months you are deleting: those
files are the only copy of the full request/response bodies, and Analytics reads token
and model figures from them.

Nothing prunes the conversation mirror (`source_messages`) either. It grows with the
conversation, which is intended — it is what makes long-term recall possible.
