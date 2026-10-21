#!/usr/bin/env bash
# Restore a backup into an EMPTY database. Usage: restore.sh /var/backups/blinxot/db-YYYYmmdd-HHMMSS.dump [files-YYYYmmdd-HHMMSS.tgz]
# Stop the API first (sudo systemctl stop blinxot-api). Rehearse this on a spare server regularly: an untested backup is not a backup.
set -euo pipefail
DUMP="${1:?path to db-*.dump}"; FILES="${2:-}"
source <(grep -E '^(DATABASE_URL|UPLOAD_DIR)=' /etc/blinxot/server.env | sed 's/^/export /')
echo "Restoring $DUMP into $DATABASE_URL"; read -r -p "This overwrites objects in that database. Type YES to continue: " ok; [ "$ok" = "YES" ]
pg_restore --clean --if-exists --no-owner --dbname "$DATABASE_URL" "$DUMP"
if [ -n "$FILES" ]; then tar -xzf "$FILES" -C "$(dirname "$UPLOAD_DIR")"; fi
echo "Done. Start the API (it applies any newer migrations on boot): sudo systemctl start blinxot-api"
