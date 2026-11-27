#!/usr/bin/env bash
# npm run test:e2e: Playwright smoke test against a throwaway local PostgreSQL and a production build of the app.
#   E2E_SKIP_BUILD=1   reuse the existing .next build (it must be a normal `npm run build`)
#   E2E_PORT=4321      fixed app port (default: a free one)
# Extra arguments go to `playwright test` (e.g. --headed, --debug, -g "install").
set -uo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/pg-throwaway.sh
. scripts/pg-throwaway.sh

pg_find_bins || {
  echo "ERROR: test:e2e needs the PostgreSQL server binaries (initdb, pg_ctl). Install PostgreSQL (brew install postgresql@16 / apt install postgresql)." >&2
  exit 1
}

SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; fi
  pg_stop
}
trap cleanup EXIT INT TERM

pg_start || exit 1
echo "Throwaway PostgreSQL ready ($("$PG_CTL" --version | head -1))."

export DATABASE_URL="$PG_URL" DB_DRIVER=pg NEXT_TELEMETRY_DISABLED=1
export AUTH_SECRET="e2e-secret-e2e-secret-e2e-secret-0123456789"
export INSTALL_TOKEN="e2e-install-token-0123456789"
export APP_TIMEZONE="${APP_TIMEZONE:-Asia/Dhaka}"

if [ "${E2E_SKIP_BUILD:-0}" != 1 ]; then
  npm run build || exit 1
fi

PORT="${E2E_PORT:-$(node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")}"
mkdir -p test-results
npx next start -H 127.0.0.1 -p "$PORT" >test-results/server.log 2>&1 &
SERVER_PID=$!
BASE="http://127.0.0.1:$PORT"
for _ in $(seq 1 120); do
  curl -fsS "$BASE/api/health" >/dev/null 2>&1 && break
  kill -0 "$SERVER_PID" 2>/dev/null || { echo "ERROR: the app server exited:" >&2; cat test-results/server.log >&2; exit 1; }
  sleep 0.5
done
curl -fsS "$BASE/api/health" >/dev/null || { echo "ERROR: the app did not start on $BASE" >&2; cat test-results/server.log >&2; exit 1; }
echo "App ready on $BASE"

# E2E_HARNESS marks a run started by this script: the specs refuse to run otherwise (they install, seed and write data, so
# they must only ever see this throwaway database, passed explicitly as E2E_DATABASE_URL).
E2E_HARNESS=1 E2E_DATABASE_URL="$PG_URL" E2E_BASE_URL="$BASE" E2E_INSTALL_TOKEN="$INSTALL_TOKEN" npx playwright test "$@"
