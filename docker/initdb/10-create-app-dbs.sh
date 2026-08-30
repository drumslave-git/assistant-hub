#!/bin/sh
# Creates the transport app's own database next to the core's, on the shared
# Postgres server. Runs ONCE, when the db service initializes an empty data
# directory (the official image's /docker-entrypoint-initdb.d hook) — an
# existing deployment upgrading to the split topology creates it by hand:
#   docker compose exec db createdb -U <user> tg
set -eu
for db in "${TG_POSTGRES_DB:-tg}"; do
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -c "CREATE DATABASE \"$db\""
done
