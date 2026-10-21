# Backup and recovery

What to protect: (1) the PostgreSQL database, (2) `UPLOAD_DIR` (public images) and (3) `<UPLOAD_DIR>-private` (employee documents). `deploy/backup.sh` captures all three.

## Backup
```bash
# nightly via cron, as the blinxot user (needs read access to server.env)
15 2 * * *  /var/www/blinxot/deploy/backup.sh >> /var/log/blinxot-backup.log 2>&1
```
Writes `db-<stamp>.dump` (pg_dump custom format, verified with `pg_restore --list`) and `files-<stamp>.tgz` to `/var/backups/blinxot`, deleting copies older than 14 days (`KEEP_DAYS`). **Copy them off the server** (object storage, rclone, rsync) — a backup on the same disk does not survive the disk. Manual one-off: `pg_dump -Fc "$DATABASE_URL" -f blinxot.dump`.

## Restore
```bash
sudo systemctl stop blinxot-api
createdb -O blinxot blinxot_restore            # restore into an empty database (extensions: citext, pgcrypto, btree_gist)
deploy/restore.sh /var/backups/blinxot/db-<stamp>.dump /var/backups/blinxot/files-<stamp>.tgz
sudo systemctl start blinxot-api               # applies any newer migrations
```
Point `DATABASE_URL` at the restored database. Rehearse this on a spare machine at least quarterly and after major releases.

## Point-in-time recovery (optional)
For lower data-loss windows enable WAL archiving (`archive_mode`, `archive_command`) or use your provider's managed PostgreSQL backups.

## Migrations and recovery
Migrations are forward-only. To undo a release that included one, restore the database backup taken before the update.
