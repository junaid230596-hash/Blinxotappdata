import type { User } from "./lib/auth";

export interface NavCtx { user: User; can: (...p: string[]) => boolean; hasBusiness: boolean }
export interface NavItem { to: string; label: string; show: (c: NavCtx) => boolean }
export interface NavGroup { label?: string; items: NavItem[] }

const biz = (...perms: string[]) => (c: NavCtx) => c.hasBusiness && c.can(...perms);
const workerOrIndividual = (c: NavCtx) => c.user.accountType === "individual" || c.user.accountType === "employee";
const admin = (c: NavCtx) => c.user.accountType === "super_admin";
const indiv = (c: NavCtx) => c.user.accountType === "individual";
const emp = (c: NavCtx) => c.hasBusiness && c.user.accountType === "employee";

// Only screens that exist appear here, so the menu never contains dead links.
export const NAV: NavGroup[] = [
  { items: [{ to: "/app", label: "Dashboard", show: () => true }] },
  { label: "Products & sales", items: [
    { to: "/app/products", label: "All products", show: biz("products.view") },
    { to: "/app/products/new", label: "Add product", show: biz("products.manage") },
    { to: "/app/inventory", label: "Inventory", show: biz("inventory.view") },
    { to: "/app/inventory/movements", label: "Stock movements", show: biz("inventory.view") },
    { to: "/app/inventory/low", label: "Low stock", show: biz("inventory.view") },
    { to: "/app/categories", label: "Categories", show: biz("products.view") },
    { to: "/app/orders", label: "Orders", show: biz("orders.view") },
    { to: "/app/orders/new", label: "New order", show: biz("orders.create") },
    { to: "/app/invoices", label: "Invoices", show: biz("orders.view") },
    { to: "/app/returns", label: "Returns", show: biz("orders.view") },
    { to: "/app/customers", label: "Customers", show: biz("customers.view") },
  ] },
  { label: "Purchasing", items: [
    { to: "/app/suppliers", label: "Suppliers", show: biz("purchases.view") },
    { to: "/app/purchases", label: "Purchases", show: biz("purchases.view") },
    { to: "/app/purchases/new", label: "New purchase", show: biz("purchases.manage") },
    { to: "/app/marketplace", label: "Marketplace", show: biz("purchases.manage") },
  ] },
  { label: "CRM", items: [
    { to: "/app/crm", label: "Overview", show: biz("crm.view") },
    { to: "/app/crm/leads", label: "Leads", show: biz("crm.view") },
    { to: "/app/crm/contacts", label: "Contacts", show: biz("crm.view") },
    { to: "/app/crm/companies", label: "Companies", show: biz("crm.view") },
    { to: "/app/crm/pipeline", label: "Pipeline", show: biz("crm.view") },
    { to: "/app/crm/activities", label: "Follow-ups", show: biz("crm.view") },
  ] },
  { label: "Team", items: [
    { to: "/app/employees", label: "All employees", show: biz("employees.view") },
    { to: "/app/employees/new", label: "Add employee", show: biz("employees.create") },
    { to: "/app/attendance", label: "Attendance", show: (c) => c.hasBusiness && (c.user.accountType === "employee" || c.can("attendance.view")) },
    { to: "/app/tasks", label: "Tasks", show: biz("tasks.view") },
    { to: "/app/leave", label: "Leave", show: (c) => emp(c) || biz("leave.view")(c) },
    { to: "/app/performance", label: "Performance", show: (c) => emp(c) || biz("performance.view")(c) },
    { to: "/app/documents", label: "Documents", show: (c) => emp(c) || biz("documents.view")(c) },
  ] },
  { label: "Hiring and promotion", items: [
    { to: "/app/jobs/manage", label: "Job postings", show: biz("jobs.manage") },
    { to: "/app/applicants", label: "Applicants", show: biz("jobs.manage") },
    { to: "/app/ads", label: "Advertisements", show: biz("ads.manage") },
  ] },
  { label: "Business", items: [
    { to: "/app/reports", label: "Reports", show: biz("reports.view") },
    { to: "/app/reputation", label: "Reviews", show: biz("business.manage") },
    { to: "/app/subscription", label: "Subscription", show: (c) => c.hasBusiness && c.user.accountType !== "employee" },
    { to: "/app/settings", label: "Settings", show: (c) => c.hasBusiness && (c.can("business.manage") || c.can("members.view") || c.can("audit.view")) },
  ] },
  { label: "Shopping", items: [
    { to: "/app/shop", label: "Shop", show: indiv },
    { to: "/app/cart", label: "Cart", show: indiv },
    { to: "/app/my-orders", label: "My orders", show: indiv },
  ] },
  { label: "My work", items: [
    { to: "/app/profile", label: "My profile", show: workerOrIndividual },
    { to: "/app/jobs", label: "Find jobs", show: workerOrIndividual },
    { to: "/app/applications", label: "My applications", show: workerOrIndividual },
    { to: "/app/my-reviews", label: "My reviews", show: workerOrIndividual },
  ] },
  { label: "Platform", items: [
    { to: "/app/admin/users", label: "Users", show: admin }, { to: "/app/admin/businesses", label: "Businesses", show: admin },
    { to: "/app/admin/employees", label: "Employees", show: admin }, { to: "/app/admin/products", label: "Products", show: admin }, { to: "/app/admin/orders", label: "Orders", show: admin },
    { to: "/app/admin/reviews", label: "Review moderation", show: admin }, { to: "/app/admin/ads", label: "Ad moderation", show: admin },
    { to: "/app/admin/categories", label: "Categories", show: admin }, { to: "/app/admin/audit", label: "Audit log", show: admin }, { to: "/app/admin/settings", label: "Settings", show: admin },
  ] },
  { label: "Account", items: [
    { to: "/app/notifications", label: "Notifications", show: () => true },
  ] },
];
