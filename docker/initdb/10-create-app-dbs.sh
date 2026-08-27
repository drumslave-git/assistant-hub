#!/bin/sh
# Creates each source app's own database next to the core's, on the shared
# Postgres server (PLAN.md: one server, one database per app). Runs ONCE, when
# the db service initializes an empty data directory (the official image's
# /docker-entrypoint-initdb.d hook) — an existing deployment upgrading to the
# split topology creates them by hand:
#   docker compose exec db createdb -U <user> tg
#   docker compose exec db createdb -U <user> chat
set -eu
for db in "${TG_POSTGRES_DB:-tg}" "${CHAT_POSTGRES_DB:-chat}"; do
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -c "CREATE DATABASE \"$db\""
done
