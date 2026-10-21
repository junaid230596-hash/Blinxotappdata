# Keeping Blinxot email out of spam

Spam filters judge three things: **who you are** (authentication), **how you behave** (volume, bounces, complaints) and **what you send** (content). Blinxot's emails are transactional (verify, reset, invitations), which is the easiest kind to deliver.

## 1. Start: sending through Gmail (low volume)
- `SMTP_FROM` must be the Gmail address that logs in: `SMTP_FROM="Blinxot <jdwebstudios@gmail.com>"`. Google signs those messages (SPF, DKIM, DMARC all align), so they reach inboxes reliably. If you put another domain in `SMTP_FROM`, Gmail replaces it or the mail fails authentication and lands in spam (the API warns about this at startup).
- Limits: about 500 recipients a day; Google may pause an account that sends many bounces. Fine for launch and testing, not for growth.
- Ask early testers to mark the first message "Not spam" and add the sender to contacts.

## 2. Before real customers: your own domain with a mail provider
Use a transactional provider (Amazon SES, Brevo, Postmark, Resend, Mailgun, SendGrid). Add the SMTP details they give you to `server/.env`, send from an address on **your domain** (for example `no-reply@blinxot.com`), then publish three DNS records at the domain's DNS host:

| Record | Purpose | What to add |
|---|---|---|
| **SPF** (TXT on the domain) | Says which servers may send for you | The provider gives it, e.g. `v=spf1 include:amazonses.com ~all`. Only **one** SPF record per domain: merge `include:`s, never add a second. |
| **DKIM** (CNAME or TXT) | Cryptographic signature on each message | Provider shows 1-3 records; add them exactly, then click "verify". |
| **DMARC** (TXT at `_dmarc.yourdomain`) | Tells receivers what to do when SPF/DKIM fail | Start with `v=DMARC1; p=none; rua=mailto:you@yourdomain` for two weeks, read the reports, then move to `p=quarantine`. |

Gmail and Yahoo now require SPF **and** DKIM **and** DMARC for senders, and reject or spam-folder mail without them.

Also: a reverse-DNS (PTR) record matters only if you run your own mail server; providers handle it for you. Do not run your own mail server.

## 3. How you send
- Send only to people who signed up or were invited. Never buy or scrape lists.
- Keep one consistent From name and address; do not change it often.
- Use a real, monitored `Reply-To`/support address (Settings > support email).
- Remove addresses that bounce; do not retry hard bounces. Keep complaints under 0.1%.
- New domain or provider: ramp up gradually for the first couple of weeks instead of sending a large batch on day one.
- Marketing/newsletters must be separate from transactional mail and need an unsubscribe link (Blinxot only sends transactional mail).

## 4. What Blinxot already does
Each email is multipart (HTML **and** plain text), has a clear subject, one primary link that is also shown as plain text, no images, no link shorteners, no attachments, escapes any user-provided name, and carries `Auto-Submitted: auto-generated` so auto-replies do not loop back. The server also warns at startup if `SMTP_FROM` does not match the sending account.

## 5. Test it
1. Send to yourself on Gmail, Outlook and Yahoo: `cd server && npm run smtp:test -- you@example.com`, then register a test account.
2. In Gmail open the message > **Show original**: you want `SPF: PASS`, `DKIM: PASS`, `DMARC: PASS`.
3. Send a real verification email to the address shown at **mail-tester.com** and aim for 9/10 or higher.
4. Register your domain in **Google Postmaster Tools** to watch reputation once you send daily volume.
5. Check `https://mxtoolbox.com/SuperTool.aspx` (SPF, DKIM, DMARC lookups) after any DNS change; changes can take up to a few hours.

## 6. If mail goes to spam anyway
Check in this order: (1) `Show original` for any FAIL, (2) `SMTP_FROM` domain matches the sender/provider, (3) the sending domain or IP is on a blocklist (mxtoolbox "Blacklist check"), (4) a recent burst of bounces or complaints, (5) the link domain: make sure `APP_URL` is your real HTTPS domain, not an IP address or `localhost`.
