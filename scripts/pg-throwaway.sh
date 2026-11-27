#!/usr/bin/env bash
# Throwaway local PostgreSQL (initdb + pg_ctl, no Docker, no cloud). SOURCE this file, then:
#   pg_find_bins || exit 0      # 1 when the server binaries are not installed (callers decide: skip or fail)
#   pg_start                    # sets PG_URL (postgres superuser, db "postgres") and PG_DIR; retries other ports
#   pg_stop                     # stops the server and deletes PG_DIR (safe to call twice; use it in an EXIT trap)
# Used by scripts/test-db.sh (npm run test:db) and scripts/e2e.sh (npm run test:e2e).

pg_find_bin() {
  local name="$1" d
  if command -v "$name" >/dev/null 2>&1; then command -v "$name"; return 0; fi
  for d in /opt/homebrew/bin /usr/local/bin /opt/homebrew/opt/postgresql@*/bin /usr/local/opt/postgresql@*/bin \
           /usr/lib/postgresql/*/bin /usr/pgsql-*/bin /Applications/Postgres.app/Contents/Versions/*/bin; do
    [ -x "$d/$name" ] && { echo "$d/$name"; return 0; }
  done
  return 1
}

pg_find_bins() {
  PG_INITDB=$(pg_find_bin initdb) && PG_CTL=$(pg_find_bin pg_ctl)
}

PG_STARTED=0
PG_DIR=""
PG_URL=""

pg_stop() {
  if [ "$PG_STARTED" = 1 ] && [ -n "$PG_DIR" ]; then "$PG_CTL" -D "$PG_DIR/data" -m immediate stop >/dev/null 2>&1 || true; fi
  PG_STARTED=0
  if [ -n "$PG_DIR" ]; then rm -rf "$PG_DIR"; fi
  PG_DIR=""
}

pg_start() {
  # Short path: unix socket paths are limited to ~100 bytes.
  PG_DIR=$(mktemp -d "${TMPDIR:-/tmp}/sserp-pg.XXXXXX" 2>/dev/null) || PG_DIR=$(mktemp -d /tmp/sserp-pg.XXXXXX) || return 1
  local sock="$PG_DIR/s" port try
  mkdir -p "$sock"
  if ! "$PG_INITDB" -D "$PG_DIR/data" -U postgres -A trust -E UTF8 --no-locale >"$PG_DIR/initdb.log" 2>&1; then
    echo "ERROR: initdb failed:" >&2; cat "$PG_DIR/initdb.log" >&2; return 1
  fi
  _pg_try() { # $1 = listen_addresses, $2 = port
    "$PG_CTL" -D "$PG_DIR/data" -w -t 30 -l "$PG_DIR/pg.log" \
      -o "-c listen_addresses='$1' -p $2 -k $sock -c fsync=off -c synchronous_commit=off -c full_page_writes=off" start >/dev/null 2>&1
  }
  for try in 1 2 3 4 5; do
    port=$(( 20000 + RANDOM % 20000 ))
    if _pg_try 127.0.0.1 "$port"; then
      PG_STARTED=1; PG_URL="postgresql://postgres@127.0.0.1:$port/postgres"; return 0
    fi
    # Port taken: retry another one. TCP blocked entirely (sandboxes): fall back to a unix-domain socket only.
    if grep -qi "address already in use" "$PG_DIR/pg.log" 2>/dev/null; then : >"$PG_DIR/pg.log"; continue; fi
    if _pg_try '' "$port"; then
      PG_STARTED=1
      PG_URL="postgresql://postgres@$(printf '%s' "$sock" | sed 's|/|%2F|g'):$port/postgres"
      echo "NOTE: TCP unavailable, using unix socket." >&2
      return 0
    fi
  done
  echo "ERROR: could not start PostgreSQL:" >&2; cat "$PG_DIR/pg.log" >&2 2>/dev/null
  return 1
}
