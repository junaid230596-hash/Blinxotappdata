# Environment variables

Server variables live in `server/.env` (development) or `/etc/blinxot/server.env` (production, mode `600`, owned by the service user). Client variables are read **at build time** from `client/.env`. Never commit either file. `server/.env.example` and `client/.env.example` list everything with comments.

## Server
| Variable | Required | Default | Notes |
|---|---|---|---|
| `NODE_ENV` | no | `development` | `production` turns on `Secure` cookies. Tests use `test`. |
| `PORT` | no | `4000` | Bind behind nginx; do not expose directly. |
| `DATABASE_URL` | **yes** | – | `postgres://user:pass@host:5432/blinxot`. PostgreSQL 15+ with `citext`, `pgcrypto`, `btree_gist`. |
| `JWT_ACCESS_SECRET` | **yes** | – | ≥ 32 chars. `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`. Rotating it signs everyone out. |
| `ACCESS_TOKEN_TTL_MIN` / `REFRESH_TOKEN_TTL_DAYS` | no | `15` / `30` | |
| `APP_URL` | no | `http://localhost:5173` | Public origin; used in email links (verify, reset, invitations). |
| `SITE_URL` | no | `APP_URL` | Origin written into `sitemap.xml` and `robots.txt`. |
| `CLIENT_DIST` | recommended | – | Path to the built client (`/var/www/blinxot/client/dist`). Enables per-page link-preview meta tags for business, product and profile pages. |
| `CORS_ORIGINS` | no | `http://localhost:5173` | Comma-separated. With the recommended single-origin setup this is just your domain. |
| `COOKIE_DOMAIN` | no | – | Only for split domains, e.g. `.blinxot.com`. |
| `SMTP_HOST` `SMTP_PORT` `SMTP_USER` `SMTP_PASSWORD` `SMTP_FROM` | for email | port `587` | Without `SMTP_HOST` a warning is logged and **no email is sent**: nobody can verify their email (required to create a business) or reset a password. Required for production. |
| `BREVO_API_KEY` / `RESEND_API_KEY` / `EMAIL_PROVIDER` | no | – | Send email through an HTTPS API instead of SMTP (works on hosts that block SMTP, such as Render's free plan). With a key set it is used automatically; `EMAIL_PROVIDER=smtp\|brevo\|resend` forces one. `SMTP_FROM` must be a verified sender/domain with the provider. Test: `npm run email:test -- you@example.com`. |
| `TRUST_PROXY` | no | `1` | Number of proxies in front of the API. `1` for nginx or Render alone; `2` when Vercel forwards to Render. Wrong values make all visitors share one rate-limit bucket. |
| `SMTP_PASS` / `SMTP_SECURE` | no | – | `SMTP_PASS` is accepted as an alias of `SMTP_PASSWORD`. `SMTP_SECURE=true` forces SSL; by default only port 465 uses SSL (587 uses STARTTLS). |
| `SMTP_CA_FILE` / `SMTP_TLS_INSECURE` | no | – | `SMTP_CA_FILE` = path to a PEM certificate authority to trust (private mail relay, or the root of an antivirus/proxy that re-signs traffic). `SMTP_TLS_INSECURE=true` skips certificate checks for local development only and is **ignored when `NODE_ENV=production`**. |
| `UPLOAD_DIR` | no | `./uploads` | Used with `STORAGE_DRIVER=local`: public images; private employee documents go to `<UPLOAD_DIR>-private`. Both must be writable and backed up. |
| `STORAGE_DRIVER` | no | `local` | `local` or `s3` (any S3-compatible bucket). See `docs/STORAGE.md`. |
| `S3_BUCKET` `S3_ACCESS_KEY_ID` `S3_SECRET_ACCESS_KEY` | with `s3` | – | Required when `STORAGE_DRIVER=s3`; the app will not start without them. |
| `S3_REGION` `S3_ENDPOINT` `S3_PREFIX` `S3_FORCE_PATH_STYLE` | no | `us-east-1` / – / – / auto | `S3_ENDPOINT` is needed for every provider except AWS. `S3_PREFIX` is an optional folder inside the bucket. |
| `MAX_UPLOAD_MB` | no | `5` | |
| `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` | first boot | – | Creates the first super admin if none exists (password ≥ 12 chars). **Remove both after the first start.** |

## Client (build time)
| Variable | Notes |
|---|---|
| `VITE_API_URL` | Leave empty when nginx serves `/api` on the same origin (recommended). Otherwise the API origin. |
| `VITE_SITE_URL` | Public origin, e.g. `https://blinxot.com`. Adds absolute canonical / Open Graph tags to `index.html`. |

## Environments
- **Development**: `server/.env` + `npm run dev` in both folders.
- **Test**: values are set in `server/vitest.config.ts` and `client/vite.config.ts` (databases `blinxot_test`, `blinxot_client_test`). Tests never touch your development database.
- **Production**: `/etc/blinxot/server.env`, `NODE_ENV=production`, client built with the production `VITE_*` values.

## Testing email
```bash
cd server && npm run smtp:test -- you@example.com
```
Prints the settings it found (never the password), connects and logs in, explains any failure in plain words, then sends one real test message. The API also checks SMTP when it starts and logs either `SMTP connection verified` or the exact reason email will not work.

**Gmail:** `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`, `SMTP_USER=<full address>`, `SMTP_PASSWORD=<16-character App Password>` (Google Account > Security > 2-Step Verification > App passwords), `SMTP_FROM="Blinxot <that same address>"`. Gmail caps sending at roughly 500 messages a day and may rewrite the From address; for a production launch use a transactional provider (Amazon SES, Brevo, Postmark, Resend) and set up SPF and DKIM for your domain so messages reach the inbox.

### "self signed certificate in certificate chain"
Something between your computer and the mail server is replacing the server's certificate with its own, so Node refuses to trust it. With Gmail this is almost always an antivirus feature (Avast, Kaspersky, Bitdefender, ESET: "email shield", "SSL/HTTPS scanning"), a company/school proxy, or a router that inspects traffic. In order of preference:
1. Turn off the scanner's email / SSL scanning, or run from a network without the proxy. A normal VPS has none of this and does not show the error.
2. Trust the interceptor's root certificate: export it as a `.pem` file and set `SMTP_CA_FILE=/path/to/root.pem` (or `NODE_EXTRA_CA_CERTS=/path/to/root.pem` when starting Node).
3. Local development only: `SMTP_TLS_INSECURE=true` (the test command prints a warning; the API refuses it in production).
Never turn certificate checking off on a production server: it lets anyone on the network read your SMTP password.
