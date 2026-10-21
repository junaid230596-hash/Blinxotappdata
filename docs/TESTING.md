# Testing

```bash
pg_ctlcluster 16 main start   # or your service manager; databases blinxot_test and blinxot_client_test must exist (see INSTALLATION.md)
cd server && npm test         # API + integration tests (real PostgreSQL), tests live in ../tests
cd client && npm test         # renders the real React app against the real API; also unit tests for PWA, SEO and the service worker
cd client && npm run build    # type-check + production build
cd server && npm run typecheck
```

What is covered: auth, RBAC and tenancy, attendance (duplicate punches, lateness), salary maths, inventory ledger consistency, purchasing → receiving, orders and OTP, CRM, jobs and hiring, reviews rules, ads, search permissions, reports/exports, admin, plans and limits, dashboards, public pages, sitemap/robots, business hours/social links, AI tool permissions, the install popup state machine (native prompt, iOS, dismissed, installed, unsupported), manifest and icons, service-worker caching rules, mobile menu, and structural accessibility (axe) on about 30 screens.

**Not covered by automation** (needs a real browser/device): visual layout and colour contrast, real touch behaviour, the actual browser install dialog, offline mode on a phone, email delivery through your SMTP provider. Use the manual list in `docs/LAUNCH_AUDIT.md`.
