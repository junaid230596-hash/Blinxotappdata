# Architecture

```
Browser (React PWA)  →  nginx  →  Express API  →  services  →  PostgreSQL
                                   routes → validation (zod) → auth/permission middleware → service → SQL
```

- **client/** React + TypeScript + Vite. `pages/` screens, `components/` shared UI, `lib/` API client, auth, SEO, PWA runtime. No business logic in components beyond presentation; rules live on the server. Pages are code-split; the public website (`pages/public.tsx`) is separate from the signed-in app (`/app/*`).
- **server/src/modules/** one folder per domain (`auth, businesses, employees, attendance, salary, tasks, products, inventory, suppliers, purchases, orders, customers, crm, jobs, profiles, reviews, ads, notifications, search, reports, plans, hr, admin, dashboard, settings, uploads, seo, ai`). Each has `*.routes.ts` (HTTP, validation, permission checks) and `*.service.ts` (rules + SQL). `middleware/` holds auth, CSRF, maintenance mode, validation, errors. `lib/` has money, pagination, uploads, email, limits.
- **database/migrations/** plain forward-only SQL. 
- **tests/** API/integration tests (real PostgreSQL). **client/tests/** renders the real app against the real API.

## Key decisions
- **Multi-tenancy**: every business-owned row carries `business_id`; `requireBusinessAccess(permission)` loads the caller's membership and returns **404** to non-members, so IDs cannot be probed.
- **RBAC**: 36 permissions (e.g. `inventory.manage`, `salary.view`, `reports.view`) attached to roles; system roles (Business Owner, Business Admin, Manager, Employee) are cloned per business so owners can customise them. Platform `super_admin` is an account type, not a business role, and is only reachable under `/api/admin`.
- **Inventory integrity**: `products.stock_qty` changes only through `applyMovement()` in a transaction with the row locked; every change writes an `inventory_movements` row; a DB `CHECK (stock_qty >= 0)` prevents overselling.
- **Money** is computed in integer cents / `NUMERIC`, never floats.
- **Sessions**: httpOnly cookies + refresh-token rotation with reuse detection; CSRF header on cookie-authenticated writes; Bearer tokens for API/mobile clients.
- **Subscriptions**: plans are rows with a JSON `limits` object; limits are enforced at creation time. `setPlan()` is the single place a payment webhook should call.

## Public website and SEO
Client-rendered pages set title, description, canonical, Open Graph/Twitter and JSON-LD per page (`lib/seo.ts`). The API serves `/robots.txt` and a live `/sitemap.xml` (static pages plus public businesses, listed products and public profiles). Anything not explicitly marked indexable is `noindex` (signed-in app, login, not-found).

## AI readiness (`server/src/modules/ai`)
A vendor-neutral seam, no provider connected by default.
- `ai.provider.ts`: `AiProvider` interface + `getProvider()`; connect GPT/Claude/etc. by implementing it.
- `ai.tools.ts`: the **closed list** of actions an agent may take: `business_dashboard`, `low_stock_products`, `list_reports`, `run_report`, `search`. All are read-only, scoped to one business, require the same permissions as the matching screen, validate input with strict zod schemas, and are audit-logged (`ai.tool`). There is no SQL tool, no write tool, no cross-business tool.
- `GET /api/businesses/:id/ai/tools` lists what the *current user* may use (hand this to the model); `POST …/ai/tools/:name` executes one as that user. An agent therefore can never do more than the person it acts for.
- To add a capability, add one entry to `TOOLS` with `needs`, `input`, `run`, and a test.

## Adding an industry module (schools, clinics, restaurants…)
1. New folder `server/src/modules/<vertical>/` with routes + service; mount it in `modules/businesses/business.routes.ts` under `/:businessId/<vertical>`.
2. New migration with tables keyed by `business_id`.
3. New permissions (insert into `permissions`, map to system roles in the migration).
4. Client: new page file, routes in `App.tsx`, entries in `nav.ts` (`show:` by permission).
Core tables (users, businesses, members, roles, audit, notifications, plans) need no change; gate the vertical per plan via `limits` if desired.
