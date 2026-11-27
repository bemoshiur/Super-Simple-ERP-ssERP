#!/usr/bin/env bash
# Integration tests against a throwaway local PostgreSQL (see scripts/pg-throwaway.sh).
# Skips cleanly (exit 0) when the PostgreSQL server binaries are not installed.
set -uo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/pg-throwaway.sh
. scripts/pg-throwaway.sh

pg_find_bins || {
  echo "SKIPPED: test:db needs the PostgreSQL server binaries (initdb, pg_ctl) on PATH."
  echo "         Install PostgreSQL (e.g. 'brew install postgresql@16' or 'apt install postgresql') to run the DB tests."
  exit 0
}
trap pg_stop EXIT INT TERM
pg_start || exit 1

echo "Throwaway PostgreSQL ready ($("$PG_CTL" --version | head -1))."
DATABASE_URL="$PG_URL" DB_DRIVER=pg AUTH_SECRET="${AUTH_SECRET:-test-secret-test-secret-test-secret-0123456789}" \
  npx vitest run -c vitest.db.config.mts "$@"
