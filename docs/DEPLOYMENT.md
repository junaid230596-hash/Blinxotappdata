# Production deployment (single VPS, Ubuntu 22.04/24.04)

Recommended layout: **one domain** (`blinxot.com`). nginx serves the built client and proxies `/api`, `/uploads`, `/sitemap.xml`, `/robots.txt` to the Node API on `127.0.0.1:4000`. Same origin means no CORS or cross-domain cookie problems. (Subdomains such as `app.` / `api.` are possible: build the client with `VITE_API_URL=https://api.blinxot.com`, set `CORS_ORIGINS` to the app origin and `COOKIE_DOMAIN=.blinxot.com`, and add the API origin to the CSP `connect-src` in `deploy/nginx.conf`.)

Nothing here assumes DNS is already configured: point `A`/`AAAA` records for `blinxot.com` and `www` at the server first.

## 1. Server packages
```bash
sudo apt update && sudo apt install -y nginx postgresql postgresql-contrib certbot python3-certbot-nginx ufw
# Node 22 LTS: install from https://nodejs.org or NodeSource
sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw enable
sudo adduser --system --group --home /var/lib/blinxot blinxot
```

## 2. Database
```bash
sudo -u postgres psql -c "CREATE ROLE blinxot LOGIN PASSWORD '<strong-random>'"
sudo -u postgres createdb -O blinxot blinxot
sudo -u postgres psql -d blinxot -c "CREATE EXTENSION IF NOT EXISTS citext; CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS btree_gist;"
```
PostgreSQL listens on localhost only by default; keep it that way.

## 3. Code and build
```bash
sudo mkdir -p /var/www && sudo git clone <your-repo> /var/www/blinxot && cd /var/www/blinxot
(cd server && npm ci && npm run build)
(cd client && cp .env.example .env && echo 'VITE_SITE_URL=https://blinxot.com' >> .env && npm ci && npm run build)
```

## 4. Configuration
```bash
sudo mkdir -p /etc/blinxot /var/lib/blinxot/uploads && sudo chown -R blinxot:blinxot /var/lib/blinxot
sudo cp server/.env.example /etc/blinxot/server.env && sudo chmod 600 /etc/blinxot/server.env && sudo chown blinxot: /etc/blinxot/server.env
sudoedit /etc/blinxot/server.env
```
Set at least: `NODE_ENV=production`, `DATABASE_URL`, `JWT_ACCESS_SECRET` (random, ≥32), `APP_URL=https://blinxot.com`, `SITE_URL=https://blinxot.com`, `CORS_ORIGINS=https://blinxot.com`, `UPLOAD_DIR=/var/lib/blinxot/uploads`, `CLIENT_DIST=/var/www/blinxot/client/dist`, the five `SMTP_*` values, and for the first boot only `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD`.

Using cloud storage instead of the server disk? Set `STORAGE_DRIVER=s3` and the `S3_*` values now and run `npm run storage:test` (see `docs/STORAGE.md`).

## 5. Services
```bash
sudo cp deploy/blinxot-api.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now blinxot-api
sudo journalctl -u blinxot-api -f        # expect "migrations applied" then "Blinxot API listening"
# now remove BOOTSTRAP_ADMIN_* from /etc/blinxot/server.env and: sudo systemctl restart blinxot-api
sudo cp deploy/nginx.conf /etc/nginx/sites-available/blinxot && sudo ln -s /etc/nginx/sites-available/blinxot /etc/nginx/sites-enabled/
# edit the domain in that file, then get certificates (certbot rewrites the ssl lines) :
sudo certbot --nginx -d blinxot.com -d www.blinxot.com
sudo nginx -t && sudo systemctl reload nginx
```
Verify: `curl -s https://blinxot.com/api/health`, `curl -s https://blinxot.com/robots.txt`, open the site on a phone.

## 6. Backups
Install the cron job from `deploy/backup.sh`, copy backups off the server, and **rehearse a restore** (see `docs/BACKUP.md`).

## 7. Updating
```bash
cd /var/www/blinxot && git pull
(cd server && npm ci && npm run build) && (cd client && npm ci && npm run build)
sudo systemctl restart blinxot-api        # applies new migrations on boot
```
Take a backup first when a release contains migrations. Installed PWAs show an "Update now" bar when the new client is live. To roll back: restore the previous build and, if a migration ran, restore the pre-update database backup (migrations are forward-only).

## 8. After go-live
- Log in as the super admin → **Admin → Settings**: set the support email (shown on the Contact page).
- Submit `https://blinxot.com/sitemap.xml` in Google Search Console and Bing Webmaster Tools.
- Run Lighthouse and the real-device checks in `docs/LAUNCH_AUDIT.md`.
