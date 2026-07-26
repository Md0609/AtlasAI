#!/usr/bin/env bash
#
# Dump the database and restore it into a scratch copy, then verify the copy.
#
# Backup is not the test — restore is. A dump nobody has ever restored is a
# file, not a recovery plan, and Atlas's core asset is hand-entered transaction
# history and an immutable thesis ledger that a user cannot re-derive from
# anywhere.
#
# Deliberately platform-neutral: it is pg_dump and psql, so it runs identically
# on a laptop, in CI, and against a managed instance. WHERE dumps are stored,
# how often they run, and how long they are retained are deployment decisions
# and are not made here.
#
# Usage:
#   ops/backup-restore.sh                       # dump + restore-verify (default)
#   ops/backup-restore.sh dump                  # dump only
#   ops/backup-restore.sh verify <dump-file>    # restore an existing dump
#
# Env:
#   ATLAS_DATABASE_URL   source database (required)
#   ATLAS_BACKUP_DIR     where dumps are written (default: ./ops/backups)
#
# Requires: the role in ATLAS_DATABASE_URL must have CREATEDB, because the
# verification restores into a scratch database rather than over anything real.
#   ALTER ROLE <role> CREATEDB;
#
# Rehearsed 2026-07-26 against the development database: 12 users, 11
# portfolios, 23 transactions, 1 thesis, 1 decision, 2 rules, all recovered and
# row-count matched at migration 022.

set -euo pipefail

SRC="${ATLAS_DATABASE_URL:-}"
if [[ -z "$SRC" ]]; then
  echo "ATLAS_DATABASE_URL is not set." >&2
  exit 1
fi

BACKUP_DIR="${ATLAS_BACKUP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/backups}"
mkdir -p "$BACKUP_DIR"

# A scratch database on the same server as the source, so no extra credentials
# are needed. Named by pid so concurrent runs cannot collide.
SCRATCH="atlas_restore_check_$$"
SERVER_URL="${SRC%/*}"

dump() {
  local out="$BACKUP_DIR/atlas-$(date -u +%Y%m%dT%H%M%SZ).dump"
  echo "==> dumping to $out"
  # Custom format: compressed, and pg_restore can filter it if a partial
  # recovery is ever needed.
  pg_dump --format=custom --no-owner --no-privileges --file="$out" "$SRC"
  echo "$out"
}

verify() {
  local dump_file="$1"
  [[ -f "$dump_file" ]] || { echo "no such dump: $dump_file" >&2; exit 1; }

  echo "==> restoring into scratch database $SCRATCH"
  # shellcheck disable=SC2064
  trap "psql -q '$SERVER_URL/postgres' -c 'DROP DATABASE IF EXISTS $SCRATCH' >/dev/null 2>&1 || true" EXIT
  psql -q "$SERVER_URL/postgres" -c "DROP DATABASE IF EXISTS $SCRATCH" >/dev/null
  psql -q "$SERVER_URL/postgres" -c "CREATE DATABASE $SCRATCH" >/dev/null
  pg_restore --no-owner --no-privileges --dbname="$SERVER_URL/$SCRATCH" "$dump_file" >/dev/null

  echo "==> verifying the restored copy"
  local failed=0

  # 1. The schema is at the same migration as the source. A restore that lands
  #    on an older schema is a restore of the wrong thing.
  local src_mig dst_mig
  src_mig=$(psql -tAq "$SRC" -c "SELECT count(*) FROM schema_migrations")
  dst_mig=$(psql -tAq "$SERVER_URL/$SCRATCH" -c "SELECT count(*) FROM schema_migrations")
  if [[ "$src_mig" == "$dst_mig" ]]; then
    echo "    migrations: $dst_mig (matches source)"
  else
    echo "    migrations: $dst_mig, source has $src_mig  <-- MISMATCH" >&2
    failed=1
  fi

  # 2. The tables that hold what a user cannot re-enter. Counting them is the
  #    difference between "the file restored" and "the data came back".
  for table in users portfolios transactions theses decisions rules; do
    local a b
    a=$(psql -tAq "$SRC" -c "SELECT count(*) FROM $table")
    b=$(psql -tAq "$SERVER_URL/$SCRATCH" -c "SELECT count(*) FROM $table")
    if [[ "$a" == "$b" ]]; then
      printf '    %-14s %s rows\n' "$table" "$b"
    else
      printf '    %-14s %s rows, source has %s  <-- MISMATCH\n' "$table" "$b" "$a" >&2
      failed=1
    fi
  done

  if [[ "$failed" -ne 0 ]]; then
    echo "==> RESTORE VERIFICATION FAILED" >&2
    exit 1
  fi
  echo "==> restore verified"
}

case "${1:-all}" in
  dump)   dump ;;
  verify) verify "${2:?usage: $0 verify <dump-file>}" ;;
  all)    verify "$(dump | tail -1)" ;;
  *)      echo "usage: $0 [dump|verify <file>|all]" >&2; exit 1 ;;
esac
