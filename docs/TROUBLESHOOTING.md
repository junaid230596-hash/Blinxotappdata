# Troubleshooting

| Symptom | Cause / fix |
|---|---|
| API exits at start with "Invalid environment configuration" | A required variable is missing or invalid (`DATABASE_URL`, `JWT_ACCESS_SECRET` ≥ 32 chars). |
| `permission denied to create extension` during migration | Create `citext`, `pgcrypto`, `btree_gist` once as a superuser (see INSTALLATION.md). |
| Users never receive verification / reset emails | Run `cd server && npm run smtp:test -- you@example.com`; it names the problem (placeholder host, wrong or missing password, wrong port, blocked connection). The boot log also says "SMTP connection verified" or why not. The variable is `SMTP_PASSWORD` (`SMTP_PASS` also works). Users cannot create a business until their email is verified. |
| "Greeting never received" | The connection opened but the server said nothing: port and SSL do not match (465 needs SSL, 587 needs `SMTP_SECURE=false`), an antivirus mail shield is holding the connection, or the network blocks mail. `npm run smtp:test` tests the other standard combinations and tells you which one works. |
| Email lands in spam | See `docs/EMAIL_DELIVERABILITY.md`. |
| "self signed certificate in certificate chain" when sending email | Antivirus/proxy is re-signing the connection. See "self signed certificate" in `docs/ENVIRONMENT.md`: disable its email/SSL scanning, or set `SMTP_CA_FILE`. |
| Login works but session drops immediately in production | Site served over `http://` (cookies are `Secure`), or API and site on different domains without `COOKIE_DOMAIN`/`CORS_ORIGINS`. |
| 403 "Missing CSRF header" from a script | Send `X-Requested-With: blinxot` on writes, or use Bearer auth. |
| Blank page after a deploy | Stale cached `index.html`; ensure nginx sends `no-cache` for it and `sw.js` (provided config does). Installed apps show an "Update now" bar. |
| Install popup never appears | Needs HTTPS, a valid manifest, not already installed, not dismissed in the last 14 days (clear `bx_install_dismissed_at` in local storage), and Chrome/Edge/Android (iOS shows instructions instead). |
| Two icons for the app | An old install from a previous manifest `id`/scope; uninstall it, keep only the current one. |
| Sitemap shows wrong domain | Set `SITE_URL` on the server. |
| Link previews show default text | Set `CLIENT_DIST` on the server and use the `/b/`, `/p/`, `/products/` proxy block from `deploy/nginx.conf`; also set `VITE_SITE_URL` at build time. |
| Uploads fail or return 502 with cloud storage | Run `cd server && npm run storage:test`; it names the problem (key, bucket, region, permission, network). See `docs/STORAGE.md`. |
| Uploaded images 404 behind nginx | `/uploads/` must proxy to the API; `UPLOAD_DIR` must be writable by the service user. |
| `npm test` cannot connect | PostgreSQL not running or test databases missing. |
