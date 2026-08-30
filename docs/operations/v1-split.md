# v1 Import — Rehearsal Workflow

How the v1 database is imported into the single v2 core store (PLAN.md,
"Migration"), and how to rehearse that import safely. **Rehearsal is
mandatory before cutover and is repeated until it passes clean.** The
production database is only ever read through a dump; the import scripts are
pointed at copies.

## What moves where

Everything lands in the **one core store** (Phase 7 — transports hold no
data). Two scripts, both in `apps/core`, split the work:

| v1 tables | Destination | Script |
| --- | --- | --- |
| backends, settings, personalities → assistants, memory_*, user_memories, general_memories, users_communication_preferences, self_corrections, addressing_exclusions, tasks, chat_summary_days, memory_extraction_days | core store (brain tables) | `npm run import:v1 -w @assistant-hub/core` |
| known_users, known_groups, group_members, chat_messages, chat_message_search, message_media, media_blobs, users_feedbacks, chat_summaries → the generalized `source_*` tables; settings.telegram_bot_token → `assistant_transports`; settings.owner_username + owner_user_id → the `transports` config blob | core store (conversation tables) | `npm run import:tg-v1 -w @assistant-hub/core` |
| traces (file-backed), analytics rollups, browser_agent_runs + screenshots, search_engine_stats | not migrated (start fresh) | — |

Both scripts derive the **default assistant** the same way (the v1 active
personality's id, else the fixed `assistant-default`), so the transport
connection row and the assistants agree without coordination. Both refuse
to run against a non-empty target, and both end with the verification
report — per-table row-count reconciliation plus spot checks — exiting
non-zero on any mismatch.

## Rehearsal, step by step

Run everything against a local Postgres (the dev compose `db` service works).

1. **Dump production v1** (read-only; see docs/operations/deployment.md
   backups):

   ```bash
   docker compose exec -T db pg_dump -U bot -d bot > v1-rehearsal.sql
   ```

2. **Restore the copy** into a fresh database:

   ```bash
   node packages/db/scripts/create-database.mjs "postgres://bot:bot@localhost:5432/v1_rehearsal"
   docker compose exec -T db psql -U bot -d v1_rehearsal < v1-rehearsal.sql
   ```

3. **Create the target store** (fresh every rehearsal — drop it first if
   it exists from a previous run):

   ```bash
   node packages/db/scripts/create-database.mjs "postgres://bot:bot@localhost:5432/core"
   ```

4. **Migrate the store** (`STORE_DATABASE_URL` in `apps/core/.env`):

   ```bash
   npm run store:migrate -w @assistant-hub/core
   ```

5. **Run the imports**, pointing `V1_DATABASE_URL` at the rehearsal copy:

   ```bash
   npm run import:v1 -w @assistant-hub/core
   npm run import:tg-v1 -w @assistant-hub/core
   ```

6. **Read the verification reports.** Each script prints the reconciliation
   table and spot checks and exits non-zero on any mismatch. A failed
   rehearsal means: fix the script (or record the explained discrepancy),
   drop the target store, repeat from step 3.

A rehearsal is **clean** when both imports exit zero. Cutover (Phase 10)
follows the same steps against the production dump taken during downtime,
with the full runbook (stop old → backup → migrate → verify → start new →
smoke-check → rollback path) written in that phase.

## Integration tests

The same import code runs in CI-shape tests against seeded synthetic
fixtures (`store/import/import.integration.test.ts` in apps/core,
Testcontainers): `npm run test:integration`. The tests build a v1
database from the frozen v1 migration chain, seed invented data, run the
imports, and assert the verification passes plus shape-level spot checks.
