#!/usr/bin/env bash
# Nightly dump of every salon database.
#
# This is the one script that must not silently fail: wa_auth lives in
# Postgres, so losing it means every salon re-scans a QR — and WhatsApp
# throttles device linking after repeated attempts.
#
# Install:  crontab -e
#   15 3 * * * /opt/salon-bot/scripts/backup.sh >> /var/log/salon-backup.log 2>&1
set -euo pipefail

STACK_DIR="${STACK_DIR:-/opt/salon-bot}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/salon-bot}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/all-$STAMP.sql.gz"

mkdir -p "$BACKUP_DIR"
cd "$STACK_DIR"

docker compose exec -T postgres pg_dumpall -U postgres | gzip > "$OUT"

# A dump that failed mid-stream still leaves a valid gzip file, so check the
# content, not just the exit code.
if ! gzip -dc "$OUT" | tail -c 200 | grep -q 'PostgreSQL database cluster dump complete'; then
  echo "BACKUP FAILED: $OUT is truncated" >&2
  rm -f "$OUT"
  exit 1
fi

echo "$(date -Is) ok $(du -h "$OUT" | cut -f1) $OUT"

# Off-box copy. A backup that only exists on the machine it protects is not
# a backup — configure an rclone remote and uncomment.
# rclone copy "$OUT" "backup:salon-bot/" || echo "WARN: off-box copy failed" >&2

find "$BACKUP_DIR" -name 'all-*.sql.gz' -mtime "+$KEEP_DAYS" -delete
