# Security checklist

| Control | Where / how |
|---|---|
| Password hashing | bcrypt (cost 12); never stored or logged in plaintext |
| Sessions | httpOnly + `Secure` (production) + `SameSite=Lax` cookies; refresh-token rotation with reuse detection; lockout after 5 failures; suspended users are signed out immediately |
| CSRF | custom header required on every cookie-authenticated write |
| Authorisation | `requireAuth` / `requireBusinessAccess(permission)` on every business route; non-members get 404; tests cover cross-tenant access |
| Input validation | zod on every body/query/param; parameterised SQL everywhere; `LIKE` input escaped |
| XSS | React escaping; JSON-LD is serialised with `<` escaped; all rendered links pass `safeHref` (http/https only); the API also rejects non-http(s) website, social, ad and project URLs; strict CSP in `deploy/nginx.conf` |
| Uploads | type detected by magic bytes (png, jpg, webp, pdf only), size-capped, server-generated names, `nosniff`; employee documents stored privately (outside the web root, or in a private bucket) and served only through authorised endpoints; with cloud storage the bucket is never public and keys are limited to that bucket |
| Rate limiting | auth, public discovery, search, AI tools, review creation, OTP attempts |
| Headers | helmet on the API; HSTS, CSP, Referrer-Policy, Permissions-Policy in nginx |
| Secrets | environment variables only; `.env` git-ignored; env validated at boot; bootstrap admin credentials meant to be removed after first boot |
| Audit | login, business/employee/product/inventory/order/purchase/permission changes, report exports, AI tool calls |
| Delivery OTP | 6 digits, HMAC-stored, 24 h expiry, 5 attempts, regeneration invalidates the old code |
| Errors | central handler; no stack traces to clients |
| AI | closed read-only tool list, per-user permissions, strict input schemas, audited |

Run before each release: `cd server && npm audit --omit=dev`, `cd client && npm audit --omit=dev`.

Known gaps: see `docs/LAUNCH_AUDIT.md` (uploads are not tracked per owner; no virus scanning; no encryption at rest beyond disk encryption; no 2FA).
