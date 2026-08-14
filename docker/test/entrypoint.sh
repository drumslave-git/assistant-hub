#!/bin/sh
# Entrypoint for the linux test container (`npm run test:linux`).
#
# The repository is bind-mounted, but `node_modules` is a named volume that
# shadows the host's: esbuild, rollup and lightningcss ship per-platform native
# builds, so a Windows or macOS install cannot be executed here. This installs
# a linux tree into that volume once and reuses it.
set -eu

if [ ! -x node_modules/.bin/vitest ]; then
  echo "Installing linux dependencies into the test volume (first run only)..."
  # `npm install --no-save`, not `npm ci`: the lockfile is generated on the host
  # OS, so the linux optional native deps have to resolve here (the same reason
  # the Dockerfile installs rather than cleans-installs) — and `--no-save` keeps
  # that resolution out of the bind-mounted lockfile.
  npm install --no-save --no-audit --no-fund
fi

exec "$@"
