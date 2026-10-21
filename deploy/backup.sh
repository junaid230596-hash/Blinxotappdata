#!/usr/bin/env bash
# Nightly backup of the database and uploaded files. Cron example (as the blinxot user):
#   15 2 * * *  /var/www/blinxot/deploy/backup.sh >> /var/log/blinxot-backup.log 2>&1
# Config comes from /etc/blinxot/server.env (DATABASE_URL, UPLOAD_DIR). Copy $BACKUP_DIR off the server too (rclone/rsync/object storage).
set -euo pipefail
source <(grep -E '^(DATABASE_URL|UPLOAD_DIR)=' /etc/blinxot/server.env | sed 's/^/export /')
BACKUP_DIR="${BACKUP_DIR:-/var/backups/blinxot}"; KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"; mkdir -p "$BACKUP_DIR"; umask 077

pg_dump --format=custom --no-owner "$DATABASE_URL" --file "$BACKUP_DIR/db-$STAMP.dump"
# Public uploads plus the private employee-documents folder (<UPLOAD_DIR>-private).
tar -czf "$BACKUP_DIR/files-$STAMP.tgz" -C "$(dirname "$UPLOAD_DIR")" "$(basename "$UPLOAD_DIR")" "$(basename "$UPLOAD_DIR")-private" 2>/dev/null || tar -czf "$BACKUP_DIR/files-$STAMP.tgz" -C "$(dirname "$UPLOAD_DIR")" "$(basename "$UPLOAD_DIR")"

pg_restore --list "$BACKUP_DIR/db-$STAMP.dump" > /dev/null          # proves the dump is readable
find "$BACKUP_DIR" -type f \( -name 'db-*.dump' -o -name 'files-*.tgz' \) -mtime +"$KEEP_DAYS" -delete
echo "backup $STAMP ok"
