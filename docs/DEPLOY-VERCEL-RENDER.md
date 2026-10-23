# Deploying with Vercel (frontend) + Render (API) + Supabase (database)

This is the layout for `blinxotappdata.vercel.app` (site) and `blinxotappdata.onrender.com` (API).

## Why login bounced and email did not send
1. **Two domains break the login cookie.** A browser on `vercel.app` that logs in against `onrender.com` is a *cross-site* request, and browsers refuse to keep or send the session cookie. Login "succeeds", then the next request has no session and you land back on the login page. **Fix:** `client/vercel.json` makes Vercel forward `/api`, `/uploads`, `/sitemap.xml` and `/robots.txt` to Render, so the browser only ever talks to `blinxotappdata.vercel.app` (same site, cookies work, no CORS).
2. **Render's free plan blocks outgoing SMTP** (ports 25, 465 and 587; Render's policy at the time of writing, check their docs), so Gmail SMTP cannot work there. **Fix:** send through an email service over HTTPS (Brevo or Resend), which is never blocked.
3. **Render's disk is erased on every deploy and restart.** Uploaded images and documents would vanish. **Fix:** use cloud file storage (Supabase Storage works, see below).

## 1. Vercel (frontend)
- Project **Root Directory**: `client` (so Vercel finds `client/vercel.json`). Framework: Vite. Build `npm run build`, output `dist`.
- Environment variables: `VITE_SITE_URL=https://blinxotappdata.vercel.app`. **Do not set `VITE_API_URL`** (leave it empty or delete it). If it is set to the Render address the browser calls Render directly and the cookie problem returns.
- If you ever rename the Render service, change the four `onrender.com` addresses in `client/vercel.json`.
- Redeploy after changing variables (Vite reads them at build time).

## 2. Render (API)
- Root Directory `server` · Build `npm install && npm run build` · Start `npm start` · Health check path `/api/health`.
- Environment variables:

| Name | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | your Supabase connection string (already working) |
| `JWT_ACCESS_SECRET` | a long random string (32+ characters) |
| `APP_URL` | `https://blinxotappdata.vercel.app` (used in email links) |
| `SITE_URL` | `https://blinxotappdata.vercel.app` |
| `CORS_ORIGINS` | `https://blinxotappdata.vercel.app` |
| `TRUST_PROXY` | `2` (Vercel and Render are both in front of the app; with the default of 1 every visitor looks like one IP and rate limits hit everyone together) |
| `BREVO_API_KEY` | from step 3 |
| `SMTP_FROM` | `Blinxot <your-verified-sender@example.com>` |
| `STORAGE_DRIVER` etc. | see step 4 |

Remove the old `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` variables (an API key takes priority anyway, but they only cause confusion). Leave `COOKIE_DOMAIN` unset.

## 3. Email that works on Render
**Brevo (easiest, no domain needed to start; free plan has a daily limit, check Brevo's current terms):**
1. Create an account at brevo.com. Under *Senders, Domains & Dedicated IPs → Senders*, add your sender address and click the verification link Brevo emails you.
2. *SMTP & API → API Keys → Generate*. Copy the key into Render as `BREVO_API_KEY`.
3. Set `SMTP_FROM="Blinxot <that verified address>"` (it must match exactly).
4. Redeploy. In the Render **Logs** you should see `brevo email API verified: email is working`. If not, the log line says why (key rejected, sender not verified...).

Sending from a free Gmail address works but is more likely to land in spam. For real customers, verify your own domain in Brevo (or Resend) and send from an address on it: see `docs/EMAIL_DELIVERABILITY.md`.

**Resend** is the alternative: set `RESEND_API_KEY` and a `SMTP_FROM` on a domain you verified in Resend (while testing it only delivers to your own account email).

## 4. File storage (Render's disk is temporary)
Supabase Storage has an S3-compatible API, so you can use the project you already have:
1. Supabase → **Storage** → create a **private** bucket (e.g. `blinxot-files`).
2. Supabase → **Storage → S3 connection**: note the **endpoint** and **region**, and create an **access key** (shown once).
3. In Render set: `STORAGE_DRIVER=s3`, `S3_BUCKET=blinxot-files`, `S3_ENDPOINT=<endpoint from Supabase>` (looks like `https://<project-ref>.supabase.co/storage/v1/s3`), `S3_REGION=<region from Supabase>`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`.
4. Redeploy and look for `file storage verified: uploads are working` in the logs. Details: `docs/STORAGE.md`.

## 5. Check it works
1. `https://blinxotappdata.vercel.app/api/health` should return `{"status":"ok",...}` (it is the Render API answered through Vercel). If it shows your app's home page instead, `vercel.json` is not in the project's root directory.
2. Register a new account and check the email arrives (also look in spam).
3. Click the verification link, log in: you should reach the dashboard and stay there after a refresh.

## If you are stuck right now
- **An account cannot verify because no email arrived:** in Supabase → SQL editor run
  `update users set email_verified_at = now() where email = 'person@example.com';`
- **Make yourself the platform admin:** set `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` (12+ characters) in Render, redeploy once, log in, then **delete both variables**.
- **First request is very slow or times out:** Render's free plan puts the API to sleep after about 15 minutes idle and takes up to a minute to wake. The Vercel proxy may report a timeout on that first call; reload and it works. For real use, use a paid Render instance or ping `https://blinxotappdata.onrender.com/api/health` every 5 minutes with a free uptime monitor.
- **"Too many attempts" for everyone:** `TRUST_PROXY` is wrong. It should be `2` with this layout and `1` if the browser talks to Render directly.
- **Login still returns to the login page:** open the browser's developer tools → Network → the `login` request: it should be to `blinxotappdata.vercel.app/api/auth/login` (not onrender.com) and the response should contain `Set-Cookie`. If the request goes to onrender.com, `VITE_API_URL` is still set in Vercel.
- **Social-media link previews** for business and product pages show the site-wide preview on this layout (the API cannot see the built frontend). The site itself is unaffected.
