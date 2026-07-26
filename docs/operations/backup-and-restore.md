# Backup and restore

There are **two** stores, and only one of them is a database. Backing up Postgres and
calling it done loses the trace archive.

## What state exists

| State | Location | Backed up by | Loss impact |
| --- | --- | --- | --- |
| Everything relational — conversation mirror, summaries, memory, feedback, tasks, settings, personalities, browser runs, media bytes while pending | Postgres | `pg_dump` | Total: the bot forgets everything and loses its configuration |
| Trace archive — **complete** LLM request/response bodies and every system prompt | `TRACES_DIR/traces-YYYY-MM.ndjson` | Nothing automatic | Analytics token/model history and all debug history for past months |
| Browser-agent downloads | `DOWNLOADS_DIR` — `./data/downloads` under Compose, `./downloads` locally | Nothing automatic (but it **is** a mounted host directory, so it survives container replacement) | Files the agent fetched. A file too large to attach to the chat exists only here |
| Running (unsettled) traces | RAM | — | Dropped on any crash. By design |
| Settled-but-unflushed traces | RAM, ≤60s | — | Graceful shutdown flushes first |
| Live job progress, browser live state | RAM | — | Transient by design |

Nothing needs the trace archive to *run*. What it needs it for is history: Analytics'
token and model-performance figures are read from those files, so pruning or losing a
month erases those numbers for that month even though nothing breaks.

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

The Compose `db` service persists into a host directory (`PG_DATA_DIR`, default
`./data/pg`). To wipe the database, stop the stack and delete that directory. The next
start creates a fresh one and the app migrates it.

Note that wiping the database also clears the operator password, so the next dashboard
visit goes to `/setup`.

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

Configuration lives in the `settings` row, so a database dump captures it — including
every API key and the bot token in plaintext. Which is another reason to protect the
dump.

What is *not* in the dump: `DATABASE_URL`, `TRACES_DIR`, `TZ` and the Compose
variables. Keep your `.env` (or your secret files) under the same backup regime, and
remember `<NAME>_FILE` Docker-secret variants exist if you would rather they never
appear in a compose file at all.

## Recommended routine

A minimal, honest setup:

```bash
# nightly, before the daily jobs run time
docker compose exec -T db pg_dump -U bot -d bot -Fc > "/backups/db-$(date +%F).dump"
tar czf "/backups/traces-$(date +%F).tar.gz" -C /srv/llm-tg-bot/data traces
```

- Run it **before** `dailyJobsRunTime` (default `04:00`), so a backup never coincides
  with the night's LLM work.
- Keep the two artifacts together — a database restored next to the wrong month's
  traces will show Analytics figures that do not match its message counts.
- Verify a restore at least once into a scratch database. An unverified backup is a
  guess.

## Disaster recovery

1. Bring up a fresh stack (`docker compose up -d`). Do **not** visit `/setup` yet.
2. Restore the database dump.
3. Unpack the trace archive into `TRACES_DATA_DIR`, ensuring the container user can
   write it.
4. Restart the app so it picks up the restored trace directory and re-warms the
   current month.
5. Sign in with the **restored** operator password (the dump carries the hash — you do
   not run setup again).
6. Check Overview: database, LLM endpoint, model, trace storage, bot. All five should
   be green.
7. Start the bot if it did not autostart.

## Retention

There is no automatic retention for traces (user decision, 2026-07-20). Month files
accumulate until you prune them from the Debug page's Prune card, which deletes every
month **strictly older** than the one you pick.

Prune deliberately, and after you have a backup of the months you are deleting: those
files are the only copy of the full request/response bodies, and Analytics reads token
and model figures from them.

Nothing prunes `chat_messages` either. The mirror grows with the conversation, which is
intended — it is what makes long-term recall possible.
