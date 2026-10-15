import { pool } from "../../db.js";
import { notFound } from "../../lib/errors.js";
import { escapeLike } from "../../lib/sql.js";

export const SEARCH_TYPES = ["business", "marketplace_product", "individual", "job", "product", "employee", "supplier", "customer", "order"] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

// Business-scoped types and the permission each requires. Public types need none.
const NEEDS: Partial<Record<SearchType, string>> = {
  product: "products.view", employee: "employees.view", supplier: "purchases.view", customer: "customers.view", order: "orders.view",
};

async function permissionsFor(userId: string, businessId: string): Promise<Set<string>> {
  const { rows } = await pool.query(
    `SELECT rp.permission_key FROM business_members m JOIN businesses b ON b.id=m.business_id AND b.status='active'
       JOIN role_permissions rp ON rp.role_id=m.role_id WHERE m.business_id=$1 AND m.user_id=$2 AND m.status='active'`, [businessId, userId]);
  if (!rows.length) {
    const { rows: m } = await pool.query("SELECT 1 FROM business_members m JOIN businesses b ON b.id=m.business_id AND b.status='active' WHERE m.business_id=$1 AND m.user_id=$2 AND m.status='active'", [businessId, userId]);
    if (!m[0]) throw notFound();                     // non-members learn nothing, not even that the business exists
  }
  return new Set(rows.map((r) => r.permission_key));
}

type Hit = { id: string; title: string; subtitle?: string | null; slug?: string; businessId?: string };

const QUERIES: Record<SearchType, (like: string, limit: number, businessId?: string) => [string, any[]]> = {
  business: (l, n) => [`SELECT id, name AS title, category AS subtitle, slug FROM businesses WHERE is_public AND status='active' AND (name ILIKE $1 OR description ILIKE $1 OR category ILIKE $1) ORDER BY lower(name) LIMIT $2`, [l, n]],
  marketplace_product: (l, n) => [
    `SELECT p.id, p.name AS title, b.name AS subtitle, p.business_id AS "businessId" FROM products p JOIN businesses b ON b.id=p.business_id AND b.is_public AND b.status='active'
      WHERE p.is_listed AND p.status='active' AND (p.name ILIKE $1 OR p.sku ILIKE $1) ORDER BY lower(p.name) LIMIT $2`, [l, n]],
  individual: (l, n) => [
    `SELECT u.id, u.full_name AS title, p.headline AS subtitle, p.slug FROM users u JOIN profiles p ON p.user_id=u.id
      WHERE p.is_public AND u.status='active' AND (u.full_name ILIKE $1 OR p.headline ILIKE $1 OR EXISTS (SELECT 1 FROM user_skills s WHERE s.user_id=u.id AND s.name::text ILIKE $1))
      ORDER BY lower(u.full_name) LIMIT $2`, [l, n]],
  job: (l, n) => [
    `SELECT j.id, j.title, b.name AS subtitle, j.business_id AS "businessId" FROM jobs j JOIN businesses b ON b.id=j.business_id AND b.is_public AND b.status='active'
      WHERE j.status='open' AND (j.deadline IS NULL OR j.deadline >= CURRENT_DATE) AND (j.title ILIKE $1 OR j.description ILIKE $1) ORDER BY j.published_at DESC LIMIT $2`, [l, n]],
  product: (l, n, b) => [`SELECT id, name AS title, sku AS subtitle FROM products WHERE business_id=$3 AND (name ILIKE $1 OR sku ILIKE $1 OR barcode ILIKE $1) ORDER BY lower(name) LIMIT $2`, [l, n, b]],
  employee: (l, n, b) => [
    `SELECT e.id, u.full_name AS title, COALESCE(e.position, e.department) AS subtitle FROM employees e JOIN users u ON u.id=e.user_id
      WHERE e.business_id=$3 AND (u.full_name ILIKE $1 OR u.email ILIKE $1 OR e.position ILIKE $1 OR e.department ILIKE $1) ORDER BY lower(u.full_name) LIMIT $2`, [l, n, b]],
  supplier: (l, n, b) => [`SELECT id, name AS title, email AS subtitle FROM suppliers WHERE business_id=$3 AND (name ILIKE $1 OR email ILIKE $1 OR contact_name ILIKE $1) ORDER BY lower(name) LIMIT $2`, [l, n, b]],
  customer: (l, n, b) => [`SELECT id, name AS title, COALESCE(email, phone) AS subtitle FROM customers WHERE business_id=$3 AND (name ILIKE $1 OR email ILIKE $1 OR phone ILIKE $1) ORDER BY lower(name) LIMIT $2`, [l, n, b]],
  order: (l, n, b) => [
    `SELECT o.id, o.order_number AS title, COALESCE(c.name, bb.name) AS subtitle FROM orders o LEFT JOIN customers c ON c.id=o.customer_id LEFT JOIN businesses bb ON bb.id=o.buyer_business_id
      WHERE o.business_id=$3 AND (o.order_number ILIKE $1 OR c.name ILIKE $1 OR bb.name ILIKE $1) ORDER BY o.created_at DESC LIMIT $2`, [l, n, b]],
};

export async function search(userId: string, f: { q: string; types?: SearchType[]; businessId?: string; limit: number }) {
  const perms = f.businessId ? await permissionsFor(userId, f.businessId) : null;
  const wanted = f.types?.length ? f.types : [...SEARCH_TYPES];
  const like = `%${escapeLike(f.q)}%`;
  const results: Partial<Record<SearchType, Hit[]>> = {};
  await Promise.all(wanted.map(async (t) => {
    const need = NEEDS[t];
    if (need && (!perms || !perms.has(need))) return;          // not permitted (or no business given): silently skipped
    const [sql, params] = QUERIES[t](like, f.limit, f.businessId);
    const { rows } = await pool.query(sql, params);
    if (rows.length) results[t] = rows;
  }));
  return { query: f.q, total: Object.values(results).reduce((n, a) => n + a!.length, 0), results };
}
