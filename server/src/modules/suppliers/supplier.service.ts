import { pool } from "../../db.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { buildSets, escapeLike } from "../../lib/sql.js";
import { audit } from "../audit/audit.service.js";

const pub = (r: any) => ({
  id: r.id, code: r.code, name: r.name, contactName: r.contact_name, email: r.email, phone: r.phone, address: r.address, notes: r.notes,
  linkedBusinessId: r.linked_business_id, linkedBusinessName: r.linked_name ?? null, status: r.status, createdAt: r.created_at,
});
const SEL = "SELECT s.*, b.name AS linked_name FROM suppliers s LEFT JOIN businesses b ON b.id=s.linked_business_id";

async function assertLinkable(linkedId: string | null | undefined, businessId: string) {
  if (!linkedId) return;
  if (linkedId === businessId) throw badRequest("You cannot add your own business as a supplier");
  const { rows } = await pool.query("SELECT 1 FROM businesses WHERE id=$1 AND is_public AND status='active'", [linkedId]);
  if (!rows[0]) throw badRequest("That business is not available on the marketplace");
}

export async function createSupplier(businessId: string, actorId: string, i: any, ip?: string) {
  await assertLinkable(i.linkedBusinessId, businessId);
  try {
    const { rows } = await pool.query(
      `INSERT INTO suppliers (business_id, name, contact_name, email, phone, address, notes, linked_business_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [businessId, i.name, i.contactName ?? null, i.email ?? null, i.phone ?? null, i.address ?? null, i.notes ?? null, i.linkedBusinessId ?? null]);
    await audit({ actorId, businessId, action: "supplier.create", entity: "supplier", entityId: rows[0].id, ip });
    return getSupplier(businessId, rows[0].id);
  } catch (e: any) { if (e.code === "23505") throw conflict("This business is already in your suppliers"); throw e; }
}

export async function listSuppliers(businessId: string, f: { q?: string; status?: string; limit: number; offset: number }) {
  const where = ["s.business_id=$1"]; const v: any[] = [businessId];
  if (f.q) { v.push(`%${escapeLike(f.q)}%`); where.push(`(s.code ILIKE $${v.length} OR s.name ILIKE $${v.length} OR s.email ILIKE $${v.length})`); }
  if (f.status) { v.push(f.status); where.push(`s.status=$${v.length}`); }
  const w = where.join(" AND ");
  const { rows: t } = await pool.query(`SELECT count(*)::int AS n FROM suppliers s WHERE ${w}`, v);
  v.push(f.limit, f.offset);
  const { rows } = await pool.query(`${SEL} WHERE ${w} ORDER BY lower(s.name) LIMIT $${v.length - 1} OFFSET $${v.length}`, v);
  return { suppliers: rows.map(pub), total: t[0].n };
}

export async function getSupplier(businessId: string, id: string) {
  const { rows } = await pool.query(`${SEL} WHERE s.id=$1 AND s.business_id=$2`, [id, businessId]);
  if (!rows[0]) throw notFound();
  return pub(rows[0]);
}

export async function updateSupplier(businessId: string, id: string, actorId: string, patch: any, ip?: string) {
  if ("linkedBusinessId" in patch) await assertLinkable(patch.linkedBusinessId, businessId);
  const { sets, vals } = buildSets({ name: "name", contactName: "contact_name", email: "email", phone: "phone", address: "address", notes: "notes",
    linkedBusinessId: "linked_business_id", status: "status" }, patch);
  if (!sets.length) throw badRequest("Nothing to update");
  vals.push(id, businessId);
  try {
    const r = await pool.query(`UPDATE suppliers SET ${sets.join(", ")}, updated_at=now() WHERE id=$${vals.length - 1} AND business_id=$${vals.length}`, vals);
    if (!r.rowCount) throw notFound();
  } catch (e: any) { if (e.code === "23505") throw conflict("This business is already in your suppliers"); throw e; }
  await audit({ actorId, businessId, action: "supplier.update", entity: "supplier", entityId: id, metadata: { fields: Object.keys(patch) }, ip });
  return getSupplier(businessId, id);
}

// "View supplier products": only what the supplier chose to list on the marketplace.
export async function supplierProducts(businessId: string, supplierId: string, q?: string) {
  const { rows: s } = await pool.query("SELECT linked_business_id FROM suppliers WHERE id=$1 AND business_id=$2", [supplierId, businessId]);
  if (!s[0]) throw notFound();
  if (!s[0].linked_business_id) return { products: [] };
  const v: any[] = [s[0].linked_business_id]; let extra = "";
  if (q) { v.push(`%${escapeLike(q)}%`); extra = ` AND (name ILIKE $2 OR sku ILIKE $2)`; }
  const { rows } = await pool.query(
    `SELECT id, name, sku, description, images, selling_price, tax_rate, unit, (stock_qty > 0) AS in_stock FROM products
      WHERE business_id=$1 AND is_listed AND status='active'${extra} ORDER BY lower(name) LIMIT 200`, v);
  return { products: rows.map((r) => ({ id: r.id, name: r.name, sku: r.sku, description: r.description, images: r.images,
    price: Number(r.selling_price), taxRate: Number(r.tax_rate), unit: r.unit, inStock: r.in_stock })) };
}
