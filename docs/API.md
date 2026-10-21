# API

Base path `/api`. JSON in and out. Interactive docs are not generated; the full endpoint tables, permissions and behaviour notes are in the repository `README.md` (sections *Step 2–5*), and every endpoint is exercised by the tests in `tests/`.

## Conventions
- **Auth**: browsers use httpOnly cookies (`bx_at`, `bx_rt`) and must send `X-Requested-With: blinxot` on writes. API/mobile clients send `Authorization: Bearer <accessToken>` (returned by login).
- **Errors**: `{ "error": { "code": "VALIDATION|FORBIDDEN|NOT_FOUND|…", "message": "…", "details": { "field": "reason" } } }` with proper status codes (400/401/403/404/409/429). No stack traces.
- **Lists**: `?limit=&offset=` → `{ total, <items> }`. Public lists cap `limit`.
- **Tenancy**: `/api/businesses/:businessId/…` requires membership; non-members get 404.
- **Rate limits**: auth endpoints (per 15 min), public discovery (per minute), review creation (daily), OTP attempts (5).
- **Health**: `GET /api/health`.

## Index
| Area | Base |
|---|---|
| Auth | `/api/auth` (register, verify-email, resend-verification, login, refresh, logout, forgot/reset/change-password) |
| Me / profile / resume | `/api/me` |
| Individual shopping (individual accounts only) | `POST /api/me/orders` (`businessId`, `items[{productId,quantity}]`, `deliveryAddress`, `phone`, `notes`), `GET /api/me/orders`, `GET /api/me/orders/:id`, `POST /api/me/orders/:id/cancel` (pending only) |
| Business (members, roles, audit, dashboard) | `/api/businesses/:id` |
| Employees, attendance, salary, tasks, leave, performance, documents | `/api/businesses/:id/{employees,attendance,attendance-settings,me,salary,tasks,leave,performance,documents}` |
| Products, categories, inventory | `/api/businesses/:id/{products,categories,inventory}` |
| Suppliers, purchases, orders, returns, customers | `/api/businesses/:id/{suppliers,purchases,orders,returns,customers}` |
| CRM | `/api/businesses/:id/crm/{dashboard,leads,contacts,companies,deals,stages,activities}` |
| Jobs, applications, ads | `/api/businesses/:id/{jobs,applications,ads}`; applying: `/api/jobs/:jobId/apply` |
| Invoices | `GET /api/businesses/:id/invoices` (`q`, `status=issued|void`), `GET …/invoices/:invoiceId`, `GET …/invoices/by-order/:orderId` (permission `orders.view`); buyers: `GET /api/me/orders/:id/invoice` |
| Reviews | `/api/reviews` |
| Reports | `/api/businesses/:id/reports[/:type?from&to&format=json|csv|pdf]` |
| Subscription / plans | `/api/businesses/:id/subscription`, `GET /api/plans` |
| Search | `GET /api/search` |
| Notifications | `/api/notifications` |
| Uploads | `POST /api/uploads` |
| AI tools | `/api/businesses/:id/ai/{status,tools,tools/:name}` |
| Admin (super admin only) | `/api/admin/*` |
| Public (no login, rate limited) | `/api/public/{businesses/:slug,marketplace/*,people/:slug,jobs,categories,ads,site}` |
| SEO | `/robots.txt`, `/sitemap.xml` |

Business profile fields now include `businessHours` (`{mon:{open:"09:00",close:"18:00"},sun:{closed:true}}`) and `socialLinks` (`facebook, instagram, x, linkedin, youtube, whatsapp`, http(s) only), updated with `PATCH /api/businesses/:id`.

## One business per order
An order can contain many items (up to 50 for individual shoppers, 200 per purchase order) but **every item must come from a single business**. Individuals: `POST /api/me/orders` takes one `businessId` and refuses any product that is not that business's listed product. Businesses: a purchase order has one `supplierId`, and for suppliers on Blinxot every line must be one of that supplier's listed products (price set by the supplier); this is enforced on create and on edit. To buy from several businesses, place one order per business. The shopping cart (`/app/cart`) holds one business at a time and asks before replacing it; the purchase screen clears its items when the supplier is changed. Order numbers count per business, so two shops can each have an `ORD-000001`.

## Automatic numbers
Created by a database trigger on insert, so every code path gets one. Per business, 6 digits, sequential, never reused:

| Record | Format | | Record | Format |
|---|---|---|---|---|
| Product (`sku`, optional on create) | `SKU-000001` | | Task | `TSK-000001` |
| Invoice / Credit note | `INV/26-27/000001` / `CN/26-27/000001` (restart each April, IST) | | Lead / Deal | `LEAD-000001` / `DEAL-000001` |
| Order / Purchase order | `ORD-000001` / `PO-000001` | | Job | `JOB-000001` |
| Customer | `CUS-000001` | | Return | `RET-000001` |
| Employee | `EMP-000001` | | Payslip (salary record) | `PAY-000001` |
| Supplier | `SUP-000001` | | | |

A hand-typed SKU is kept as typed; a generated number skips any value already in use. Invoices are issued when an order is accepted and voided (number kept) if it is cancelled. Records expose the number as `code` (products: `sku`, invoices: `number`) and lists can be searched by it.

## GST (India)
- **Seller profile** (`PATCH /api/businesses/:id`): `legalName`, `gstin` (15 characters, format and check character validated, stored upper case), `stateCode` (2-digit GST state code; derived from the GSTIN when one is given, and the two must agree). Send `""` to clear.
- **Products**: `hsnCode` (HSN/SAC, 4-8 digits). **Customers**: `gstin`, `stateCode`.
- **Orders**: optional `placeOfSupply` (state code) on `POST …/orders`; individual buyers send `stateCode` on `POST /api/me/orders`. Default: the customer's / buying business's state, otherwise the seller's.
- **Invoices** (`…/invoices`, `…/invoices/by-order/:orderId`, buyer: `/api/me/orders/:id/invoice`) carry `details` with the seller and buyer GST identities, place of supply, per-line `hsn`, `taxable`, `cgst`, `sgst`, `igst`, totals, an HSN summary and the amount in words. A **registered** seller (GSTIN set) issues a *Tax Invoice*: CGST + SGST (half each, any odd paisa to SGST) when place of supply is the seller's state, otherwise IGST. An **unregistered** seller issues a plain *Invoice* with no split. Everything is frozen at issue time.
- **Credit notes** are issued automatically when goods are returned against an invoiced order, for exactly the refunded amount (tax split the same way), and are returned inside the invoice response as `creditNotes` (also in the buyer's copy). Orders accepted before invoicing existed have no invoice and therefore no credit note.
