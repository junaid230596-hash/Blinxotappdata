import { pool } from "../../db.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { escapeLike } from "../../lib/sql.js";
import { audit } from "../audit/audit.service.js";
import { notify } from "../notifications/notification.service.js";

type Page = { limit: number; offset: number };

export async function overview() {
  const one = async (sql: string) => (await pool.query(sql)).rows;
  const [users, businesses, orders, products, plans, reports, adsPending] = await Promise.all([
    one("SELECT status, count(*)::int AS n FROM users GROUP BY status"),
    one("SELECT status, count(*)::int AS n FROM businesses GROUP BY status"),
    one("SELECT count(*)::int AS total, count(*) FILTER (WHERE created_at >= date_trunc('month', now()))::int AS this_month FROM orders"),
    one("SELECT count(*)::int AS n FROM products"),
    one("SELECT plan_key, count(*)::int AS n FROM subscriptions GROUP BY plan_key"),
    one("SELECT count(*)::int AS n FROM review_reports WHERE status='open'"),
    one("SELECT count(*)::int AS n FROM advertisements WHERE moderation_status='rejected'"),
  ]);
  const by = (rows: any[], k: string) => Object.fromEntries(rows.map((r) => [r[k], r.n]));
  return { users: by(users, "status"), businesses: by(businesses, "status"), orders: { total: orders[0].total, thisMonth: orders[0].this_month },
    products: products[0].n, subscriptionsByPlan: by(plans, "plan_key"), openReviewReports: reports[0].n, rejectedAds: adsPending[0].n };
}

const pubUser = (r: any) => ({ id: r.id, email: r.email, fullName: r.full_name, accountType: r.account_type, status: r.status, emailVerified: !!r.email_verified_at,
  lastLoginAt: r.last_login_at, createdAt: r.created_at });

export async function listUsers(f: Page & { q?: string; status?: string; accountType?: string }) {
  const where: string[] = ["true"]; const v: any[] = [];
  if (f.q) { v.push(`%${escapeLike(f.q)}%`); where.push(`(email ILIKE $${v.length} OR full_name ILIKE $${v.length})`); }
  if (f.status) { v.push(f.status); where.push(`status=$${v.length}`); }
  if (f.accountType) { v.push(f.accountType); where.push(`account_type=$${v.length}`); }
  const w = where.join(" AND ");
  const { rows: t } = await pool.query(`SELECT count(*)::int AS n FROM users WHERE ${w}`, v);
  v.push(f.limit, f.offset);
  const { rows } = await pool.query(`SELECT * FROM users WHERE ${w} ORDER BY created_at DESC, id LIMIT $${v.length - 1} OFFSET $${v.length}`, v);
  return { total: t[0].n, users: rows.map(pubUser) };
}

export async function getUser(id: string) {
  const { rows } = await pool.query("SELECT * FROM users WHERE id=$1", [id]);
  if (!rows[0]) throw notFound();
  const { rows: m } = await pool.query(
    `SELECT b.id, b.name, b.status, r.name AS role FROM business_members bm JOIN businesses b ON b.id=bm.business_id JOIN roles r ON r.id=bm.role_id WHERE bm.user_id=$1 AND bm.status='active'`, [id]);
  const { rows: s } = await pool.query("SELECT count(*)::int AS n FROM sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at > now()", [id]);
  return { ...pubUser(rows[0]), businesses: m, activeSessions: s[0].n };
}

export async function setUserStatus(adminId: string, id: string, status: "active" | "suspended", reason: string | undefined, ip?: string) {
  if (id === adminId) throw forbidden("You cannot change your own status");
  const { rows } = await pool.query("SELECT account_type, status FROM users WHERE id=$1", [id]);
  if (!rows[0]) throw notFound();
  if (rows[0].account_type === "super_admin") throw forbidden("Super admins cannot be suspended here");
  if (rows[0].status === status) throw conflict(`This user is already ${status}`);
  await pool.query("UPDATE users SET status=$2, updated_at=now() WHERE id=$1", [id, status]);
  // Suspension takes effect immediately: access tokens are re-checked per request, and refresh sessions are revoked.
  if (status === "suspended") await pool.query("UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [id]);
  await audit({ actorId: adminId, action: `admin.user_${status === "suspended" ? "suspend" : "reactivate"}`, entity: "user", entityId: id, metadata: { reason }, ip });
  return getUser(id);
}

export async function listBusinesses(f: Page & { q?: string; status?: string }) {
  const where: string[] = ["true"]; const v: any[] = [];
  if (f.q) { v.push(`%${escapeLike(f.q)}%`); where.push(`(b.name ILIKE $${v.length} OR b.slug ILIKE $${v.length})`); }
  if (f.status) { v.push(f.status); where.push(`b.status=$${v.length}`); }
  const w = where.join(" AND ");
  const { rows: t } = await pool.query(`SELECT count(*)::int AS n FROM businesses b WHERE ${w}`, v);
  v.push(f.limit, f.offset);
  const { rows } = await pool.query(
    `SELECT b.id, b.name, b.slug, b.category, b.status, b.created_at, u.email AS owner_email, u.full_name AS owner_name, s.plan_key,
            (SELECT count(*)::int FROM business_members m WHERE m.business_id=b.id AND m.status='active') AS members
       FROM businesses b JOIN users u ON u.id=b.owner_id LEFT JOIN subscriptions s ON s.business_id=b.id
      WHERE ${w} ORDER BY b.created_at DESC, b.id LIMIT $${v.length - 1} OFFSET $${v.length}`, v);
  return { total: t[0].n, businesses: rows.map((r) => ({ id: r.id, name: r.name, slug: r.slug, category: r.category, status: r.status, ownerName: r.owner_name,
    ownerEmail: r.owner_email, plan: r.plan_key, members: r.members, createdAt: r.created_at })) };
}

export async function setBusinessStatus(adminId: string, id: string, status: "active" | "suspended", reason: string | undefined, ip?: string) {
  const { rows } = await pool.query("UPDATE businesses SET status=$2, updated_at=now() WHERE id=$1 AND status<>$2 RETURNING owner_id, name", [id, status]);
  if (!rows[0]) {
    const { rows: ex } = await pool.query("SELECT status FROM businesses WHERE id=$1", [id]);
    if (!ex[0]) throw notFound();
    throw conflict(`This business is already ${status}`);
  }
  await audit({ actorId: adminId, businessId: id, action: `admin.business_${status === "suspended" ? "suspend" : "reactivate"}`, entity: "business", entityId: id, metadata: { reason }, ip });
  await notify(rows[0].owner_id, { type: "business.status", title: status === "suspended" ? `${rows[0].name} was suspended` : `${rows[0].name} was reactivated`, body: reason, data: { businessId: id } });
  return { id, status };
}

export async function listEmployees(f: Page & { q?: string; businessId?: string }) {
  const where: string[] = ["true"]; const v: any[] = [];
  if (f.q) { v.push(`%${escapeLike(f.q)}%`); where.push(`(u.full_name ILIKE $${v.length} OR u.email ILIKE $${v.length})`); }
  if (f.businessId) { v.push(f.businessId); where.push(`e.business_id=$${v.length}`); }
  const w = where.join(" AND ");
  const { rows: t } = await pool.query(`SELECT count(*)::int AS n FROM employees e JOIN users u ON u.id=e.user_id WHERE ${w}`, v);
  v.push(f.limit, f.offset);
  const { rows } = await pool.query(
    `SELECT e.id, u.full_name, u.email, e.position, e.status, b.id AS business_id, b.name AS business_name FROM employees e JOIN users u ON u.id=e.user_id JOIN businesses b ON b.id=e.business_id
      WHERE ${w} ORDER BY lower(u.full_name), e.id LIMIT $${v.length - 1} OFFSET $${v.length}`, v);   // deliberately no salary data
  return { total: t[0].n, employees: rows.map((r) => ({ id: r.id, fullName: r.full_name, email: r.email, position: r.position, status: r.status, businessId: r.business_id, businessName: r.business_name })) };
}

export async function listProducts(f: Page & { q?: string; businessId?: string }) {
  const where: string[] = ["true"]; const v: any[] = [];
  if (f.q) { v.push(`%${escapeLike(f.q)}%`); where.push(`(p.name ILIKE $${v.length} OR p.sku ILIKE $${v.length})`); }
  if (f.businessId) { v.push(f.businessId); where.push(`p.business_id=$${v.length}`); }
  const w = where.join(" AND ");
  const { rows: t } = await pool.query(`SELECT count(*)::int AS n FROM products p WHERE ${w}`, v);
  v.push(f.limit, f.offset);
  const { rows } = await pool.query(
    `SELECT p.id, p.name, p.sku, p.status, p.is_listed, p.stock_qty, p.selling_price, b.id AS business_id, b.name AS business_name FROM products p JOIN businesses b ON b.id=p.business_id
      WHERE ${w} ORDER BY lower(p.name), p.id LIMIT $${v.length - 1} OFFSET $${v.length}`, v);
  return { total: t[0].n, products: rows.map((r) => ({ id: r.id, name: r.name, sku: r.sku, status: r.status, isListed: r.is_listed, stockQty: Number(r.stock_qty), sellingPrice: Number(r.selling_price), businessId: r.business_id, businessName: r.business_name })) };
}

export async function setProductStatus(adminId: string, id: string, patch: { status?: "active" | "inactive"; isListed?: boolean }, ip?: string) {
  const sets: string[] = []; const v: any[] = [];
  if (patch.status) { v.push(patch.status); sets.push(`status=$${v.length}`); }
  if (patch.isListed !== undefined) { v.push(patch.isListed); sets.push(`is_listed=$${v.length}`); }
  if (!sets.length) throw badRequest("Nothing to update");
  v.push(id);
  const { rows } = await pool.query(`UPDATE products SET ${sets.join(", ")}, updated_at=now() WHERE id=$${v.length} RETURNING business_id`, v);
  if (!rows[0]) throw notFound();
  await audit({ actorId: adminId, businessId: rows[0].business_id, action: "admin.product_update", entity: "product", entityId: id, metadata: patch, ip });
}

export async function listOrders(f: Page & { q?: string; status?: string; businessId?: string }) {
  const where: string[] = ["true"]; const v: any[] = [];
  if (f.q) { v.push(`%${escapeLike(f.q)}%`); where.push(`o.order_number ILIKE $${v.length}`); }
  if (f.status) { v.push(f.status); where.push(`o.status=$${v.length}`); }
  if (f.businessId) { v.push(f.businessId); where.push(`o.business_id=$${v.length}`); }
  const w = where.join(" AND ");
  const { rows: t } = await pool.query(`SELECT count(*)::int AS n FROM orders o WHERE ${w}`, v);
  v.push(f.limit, f.offset);
  const { rows } = await pool.query(
    `SELECT o.id, o.order_number, o.status, o.total, o.created_at, b.name AS seller, bb.name AS buyer_business FROM orders o JOIN businesses b ON b.id=o.business_id LEFT JOIN businesses bb ON bb.id=o.buyer_business_id
      WHERE ${w} ORDER BY o.created_at DESC, o.id LIMIT $${v.length - 1} OFFSET $${v.length}`, v);
  return { total: t[0].n, orders: rows.map((r) => ({ id: r.id, orderNumber: r.order_number, status: r.status, total: Number(r.total), seller: r.seller, buyerBusiness: r.buyer_business, createdAt: r.created_at })) };
}

export async function listAudit(f: Page & { actorId?: string; businessId?: string; action?: string; from?: string; to?: string }) {
  const where: string[] = ["true"]; const v: any[] = [];
  if (f.actorId) { v.push(f.actorId); where.push(`a.actor_id=$${v.length}`); }
  if (f.businessId) { v.push(f.businessId); where.push(`a.business_id=$${v.length}`); }
  if (f.action) { v.push(`${escapeLike(f.action)}%`); where.push(`a.action ILIKE $${v.length}`); }
  if (f.from) { v.push(f.from); where.push(`a.created_at >= $${v.length}::date`); }
  if (f.to) { v.push(f.to); where.push(`a.created_at < ($${v.length}::date + 1)`); }
  const w = where.join(" AND ");
  const { rows: t } = await pool.query(`SELECT count(*)::int AS n FROM audit_logs a WHERE ${w}`, v);
  v.push(f.limit, f.offset);
  const { rows } = await pool.query(
    `SELECT a.id, a.action, a.entity, a.entity_id, a.metadata, a.ip, a.created_at, a.business_id, u.full_name AS actor, u.email AS actor_email FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id
      WHERE ${w} ORDER BY a.id DESC LIMIT $${v.length - 1} OFFSET $${v.length}`, v);
  return { total: t[0].n, entries: rows.map((r) => ({ id: Number(r.id), action: r.action, entity: r.entity, entityId: r.entity_id, metadata: r.metadata, ip: r.ip, businessId: r.business_id, actorName: r.actor, actorEmail: r.actor_email, createdAt: r.created_at })) };
}

export const listCategories = async (kind?: string) => {
  const { rows } = await pool.query("SELECT id, kind, name::text AS name FROM platform_categories WHERE ($1::text IS NULL OR kind=$1) ORDER BY kind, lower(name::text)", [kind ?? null]);
  return rows;
};
export async function createCategory(adminId: string, kind: string, name: string) {
  try {
    const { rows } = await pool.query("INSERT INTO platform_categories (kind, name) VALUES ($1,$2) RETURNING id, kind, name::text AS name", [kind, name]);
    await audit({ actorId: adminId, action: "admin.category_create", entity: "category", entityId: rows[0].id, metadata: { kind, name } });
    return rows[0];
  } catch (e: any) { if (e.code === "23505") throw conflict("This category already exists"); throw e; }
}
export async function renameCategory(adminId: string, id: string, name: string) {
  try {
    const { rows } = await pool.query("UPDATE platform_categories SET name=$2 WHERE id=$1 RETURNING id, kind, name::text AS name", [id, name]);
    if (!rows[0]) throw notFound();
    await audit({ actorId: adminId, action: "admin.category_rename", entity: "category", entityId: id, metadata: { name } });
    return rows[0];
  } catch (e: any) { if (e.code === "23505") throw conflict("This category already exists"); throw e; }
}
export async function deleteCategory(adminId: string, id: string) {
  const r = await pool.query("DELETE FROM platform_categories WHERE id=$1", [id]);
  if (!r.rowCount) throw notFound();
  await audit({ actorId: adminId, action: "admin.category_delete", entity: "category", entityId: id });
}
