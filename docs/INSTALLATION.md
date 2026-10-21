# Installation (development)

Requirements: Node.js 22+, PostgreSQL 15+ (with the `postgresql-contrib` package for `citext`, `pgcrypto`, `btree_gist`).

```bash
# 1. Databases (one for dev, two for the test suites)
sudo -u postgres psql -c "CREATE ROLE blinxot LOGIN PASSWORD 'blinxot_dev' CREATEDB"
for d in blinxot blinxot_test blinxot_client_test; do sudo -u postgres createdb -O blinxot $d; done
# the extensions need a superuser once per database:
for d in blinxot blinxot_test blinxot_client_test; do sudo -u postgres psql -d $d -c "CREATE EXTENSION IF NOT EXISTS citext; CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS btree_gist;"; done

# 2. API
cd server && cp .env.example .env     # set DATABASE_URL and JWT_ACCESS_SECRET
npm install && npm run dev            # migrations run automatically; API on :4000

# 3. Client (second terminal)
cd client && npm install && npm run dev   # http://localhost:5173, proxies /api, /uploads, /sitemap.xml, /robots.txt
```

First admin: set `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` in `server/.env`, start the API once, then delete both lines. Log in at `/login`; the **Admin** menu appears.

## Migrations
Plain SQL in `database/migrations/` (`001_…` to `006_…`), applied in order inside a transaction each, recorded in `schema_migrations`. They run on every API start; to run them alone: `cd server && npm run migrate`. Never edit an applied migration; add a new numbered file.
