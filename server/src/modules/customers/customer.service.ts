import { pool, tx } from "../../db.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { buildSets, escapeLike } from "../../lib/sql.js";
import { audit } from "../audit/audit.service.js";

const STATS = `
  (SELECT COALESCE(SUM(o.total),0) FROM orders o WHERE o.customer_id=c.id AND o.status IN ('delivered','returned'))
  - (SELECT COALESCE(SUM(r.refund_total),0) FROM order_returns r JOIN orders o ON o.id=r.order_id WHERE o.customer_id=c.id) AS total_spent,
  (SELECT count(*)::int FROM orders o WHERE o.customer_id=c.id AND o.status <> 'cancelled') AS order_count,
  GREATEST(c.last_interaction_at, (SELECT max(o.created_at) FROM orders o WHERE o.customer_id=c.id)) AS last_interaction`;
const SEL = `SELECT c.*, ${STATS} FROM customers c`;
const pub = (r: any) => ({
  id: r.id, code: r.code, gstin: r.gstin ?? null, stateCode: r.state_code ?? null, name: r.name, phone: r.phone, email: r.email, address: r.address, notes: r.notes, status: r.status,
  totalSpent: Number(r.total_spent), orderCount: r.order_count, lastInteraction: r.last_interaction, createdAt: r.created_at,
});

export async function createCustomer(businessId: string, actorId: string, i: any, ip?: string) {
  if (i.gstin && i.stateCode && i.gstin.slice(0, 2) !== i.stateCode) throw badRequest("The first two digits of the GSTIN must match the state");
  if (i.gstin && !i.stateCode) i.stateCode = i.gstin.slice(0, 2);
  const { rows } = await pool.query("INSERT INTO customers (business_id, name, phone, email, address, notes, gstin, state_code) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
    [businessId, i.name, i.phone ?? null, i.email ?? null, i.address ?? null, i.notes ?? null, i.gstin || null, i.stateCode || null]);
  await audit({ actorId, businessId, action: "customer.create", entity: "customer", entityId: rows[0].id, ip });
  return getCustomer(businessId, rows[0].id);
}

export async function listCustomers(businessId: string, f: any) {
  const where = ["c.business_id=$1"]; const v: any[] = [businessId];
  if (f.q) { v.push(`%${escapeLike(f.q)}%`); where.push(`(c.code ILIKE $${v.length} OR c.name ILIKE $${v.length} OR c.email ILIKE $${v.length} OR c.phone ILIKE $${v.length})`); }
  if (f.status) { v.push(f.status); where.push(`c.status=$${v.length}`); }
  const w = where.join(" AND ");
  const sorts: Record<string, string> = { name: "lower(c.name)", spent: "total_spent", last: "last_interaction", created: "c.created_at" };
  const { rows: t } = await pool.query(`SELECT count(*)::int AS n FROM customers c WHERE ${w}`, v);
  v.push(f.limit, f.offset);
  const { rows } = await pool.query(
    `SELECT * FROM (${SEL} WHERE ${w}) c ORDER BY ${sorts[f.sort ?? "name"]} ${f.dir === "desc" ? "DESC" : "ASC"} NULLS LAST, c.id LIMIT $${v.length - 1} OFFSET $${v.length}`, v);
  return { customers: rows.map(pub), total: t[0].n };
}

export async function getCustomer(businessId: string, id: string, detail = false) {
  const { rows } = await pool.query(`${SEL} WHERE c.id=$1 AND c.business_id=$2`, [id, businessId]);
  if (!rows[0]) throw notFound();
  if (!detail) return pub(rows[0]);
  const [orders, comms] = await Promise.all([
    pool.query("SELECT id, order_number, status, total, created_at FROM orders WHERE customer_id=$1 AND business_id=$2 ORDER BY created_at DESC LIMIT 20", [id, businessId]),
    pool.query(`SELECT m.id, m.type, m.summary, m.created_at, u.full_name AS author FROM customer_communications m LEFT JOIN users u ON u.id=m.created_by
                 WHERE m.customer_id=$1 ORDER BY m.created_at DESC LIMIT 50`, [id]),
  ]);
  return { ...pub(rows[0]),
    orders: orders.rows.map((o) => ({ id: o.id, orderNumber: o.order_number, status: o.status, total: Number(o.total), createdAt: o.created_at })),
    communications: comms.rows.map((m) => ({ id: m.id, type: m.type, summary: m.summary, authorName: m.author, createdAt: m.created_at })) };
}

export async function updateCustomer(businessId: string, id: string, actorId: string, patch: any, ip?: string) {
  if (patch.gstin) patch.stateCode = patch.gstin.slice(0, 2);
  const { sets, vals } = buildSets({ gstin: "gstin", stateCode: "state_code", name: "name", phone: "phone", email: "email", address: "address", notes: "notes", status: "status" }, patch);
  if (!sets.length) throw badRequest("Nothing to update");
  vals.push(id, businessId);
  const r = await pool.query(`UPDATE customers SET ${sets.join(", ")}, updated_at=now() WHERE id=$${vals.length - 1} AND business_id=$${vals.length}`, vals);
  if (!r.rowCount) throw notFound();
  await audit({ actorId, businessId, action: "customer.update", entity: "customer", entityId: id, metadata: { fields: Object.keys(patch) }, ip });
  return getCustomer(businessId, id);
}

export async function logCommunication(businessId: string, id: string, actorId: string, i: { type: string; summary: string }) {
  await tx(async (c) => {
    const { rows } = await c.query("SELECT 1 FROM customers WHERE id=$1 AND business_id=$2 FOR UPDATE", [id, businessId]);
    if (!rows[0]) throw notFound();
    await c.query("INSERT INTO customer_communications (customer_id, business_id, type, summary, created_by) VALUES ($1,$2,$3,$4,$5)", [id, businessId, i.type, i.summary, actorId]);
    await c.query("UPDATE customers SET last_interaction_at=now() WHERE id=$1", [id]);
  });
  return getCustomer(businessId, id, true);
}
