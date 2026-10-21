# Launch audit

Status as of this build. "Verified" means exercised by an automated test or command run against a real PostgreSQL database; "Manual" means it needs a real device/provider and has **not** been verified yet.

## Verified
| Area | Evidence |
|---|---|
| API + integration | 24 files, **208 tests** passing (`cd server && npm test`) |
| Client + full-app flows | 10 files, **100 tests** passing against the real API/DB (`cd client && npm test`) |
| Type checks, production builds | `tsc --noEmit` clean in both; `vite build` and `tsc` builds succeed; compiled API boots in production mode |
| Dependencies | `npm audit --omit=dev`: 0 vulnerabilities (server and client) |
| Auth, RBAC, tenancy | register/verify/login/logout/reset, lockout, refresh rotation, cross-tenant 404s |
| Business, employees, attendance, salary | employee login, punch in/out, duplicate-session prevention, salary models |
| Products, inventory, purchasing, orders | ledger equals stock after every workflow; PO → supplier order → OTP delivery → receipt |
| CRM, tasks, jobs, reviews, ads, notifications, reports, admin, plans | per-module test files |
| Link previews, contact form | per-page meta served by the API (escaped, 404 noindex for private/missing), contact form validation, header-injection and honeypot protection |
| GST invoicing | GSTIN format + check-character validation, HSN/SAC, place of supply, CGST+SGST vs IGST (odd paisa preserved), HSN summary, amount in words (lakh/crore), unregistered-seller layout, credit notes equal to refunds, financial-year numbering across the 1 April IST boundary, snapshot immutability, UI layouts (axe-clean) |
| Automatic numbering + invoices | trigger-assigned codes (sequential, per business, 20 concurrent creates unique and gapless), hand-typed SKU collisions skipped, backfill of existing rows verified on a populated database, invoice issue/void/never-reused numbers, frozen snapshot, tenant and buyer isolation |
| Individual shopping | listed-only products, server-side pricing, stock check, one-seller cart, OTP-confirmed delivery, buyer cancel while pending, privacy between buyers, review only after delivery |
| Public website | home, features, pricing (from DB), about, contact, discovery, product, business, person and job pages; hostile data cannot create script links or break JSON-LD |
| SEO | per-page title/description/canonical/OG/Twitter/JSON-LD; `noindex` on app/auth/not-found; live `robots.txt` and `sitemap.xml` (private/suspended content excluded) |
| PWA | manifest + real icons, single manifest link, install popup states (native prompt, dismissed, installed, iOS, unsupported, sign-in screens), service-worker rules (no API caching, update waits for user, old caches removed, offline fallback) |
| Mobile structure | hamburger menus (app and public), tables→cards, 44 px targets, structural axe audit (~30 screens, 0 violations) |
| AI boundary | closed read-only tool list, permission filtering, audit, strict inputs |
| Branding | no Univora/Fynlo/Inventra/template text in UI or manifest (asserted by tests) |

## Manual checks still required before announcing launch
1. **Real SMTP**: send yourself verification, reset, invitation and order-code emails with production `SMTP_*`.
2. **Real devices** (Android Chrome, iPhone Safari, desktop Chrome/Edge): install from the popup — confirm exactly one app/icon; iOS instructions; offline page; update bar after a second deploy (`docs/PWA.md`).
3. **Visual QA + Lighthouse** on mobile for home, pricing, a business page, dashboard: colour contrast, spacing, touch behaviour, performance. jsdom cannot judge these and no real browser was available while building.
4. **Backup restore rehearsal** on a spare machine (`docs/BACKUP.md`).
5. TLS/HSTS/CSP in place on the real domain (`curl -I`), and CSP shows no console violations.
6. Set the support email in **Admin → Settings**; submit the sitemap to search consoles.

## Known limitations
- GST: no e-invoicing (IRN / QR code), e-way bill, reverse charge, composition scheme, cess, TCS/TDS, GSTR report exports, or multi-state GSTINs per business. Invoices issued before GST support keep their original number format and simple layout. Confirm the invoice layout and rules with your accountant before relying on it for filing.
- **Page-specific meta needs `CLIENT_DIST` + the nginx routes** (both in the deployment guide). Pages other than business/product/person profiles share the site-wide preview; those pages' own tags are set by JavaScript.
- **No online payments.** Plans are rows with limits; upgrades are admin-activated until a provider (e.g. Razorpay) calls `setPlan()`. Orders have no payment tracking. The pricing page says so.
- Contact messages are emailed to the support address (not stored); they require SMTP and a configured support email.
- Uploaded files are not tracked per owner: a file URL is an unguessable capability. No virus scanning; no encryption at rest beyond disk encryption. No two-factor authentication.
- Purchases cannot be edited once saved (cancel and recreate); CRM tags are plain text; admin lists are mostly read-only.
- Returns are recorded by the seller only; valuation is weighted-average cost (no FIFO).
- Leave does not feed salary/attendance; no leave balances.
- Reports are on-demand (no scheduled/emailed reports); PDF layout is a simple table.
- Search uses `ILIKE` (fine for thousands of rows per business; add trigram/full-text indexes at larger scale).
- Ad serving is random among eligible ads (no targeting/budgets/billing).
- No AI provider is connected (by design); the tool boundary is ready.
- Email goes through SMTP only; failures are logged, not retried.
