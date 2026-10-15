import { pool, tx } from "../../db.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { buildSets, escapeLike } from "../../lib/sql.js";
import { audit } from "../audit/audit.service.js";
import { applyMovement } from "../inventory/inventory.service.js";
import { assertWithin } from "../plans/plan.service.js";

export const publicProduct = (r: any, canSeeCost: boolean) => ({
  id: r.id, name: r.name, sku: r.sku, hsnCode: r.hsn_code ?? null, barcode: r.barcode, description: r.description, images: r.images,
  categoryId: r.category_id, categoryName: r.category_name ?? null, supplierId: r.supplier_id,
  ...(canSeeCost ? { costPrice: Number(r.cost_price) } : {}),
  sellingPrice: Number(r.selling_price), taxRate: Number(r.tax_rate), unit: r.unit,
  stockQty: Number(r.stock_qty), minStock: Number(r.min_stock), lowStock: Number(r.stock_qty) <= Number(r.min_stock),
  isListed: r.is_listed, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at,
});
const SEL = "SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id=p.category_id";

async function assertOwned(table: "categories" | "suppliers", id: string | null | undefined, businessId: string) {
  if (!id) return;
  const { rows } = await pool.query(`SELECT 1 FROM ${table} WHERE id=$1 AND business_id=$2`, [id, businessId]);
  if (!rows[0]) throw badRequest(`Unknown ${table === "categories" ? "category" : "supplier"}`);
}

function mapUnique(e: any): never {
  if (e.code === "23505") {
    if (String(e.constraint).includes("barcode")) throw conflict("Another product already uses this barcode");
    if (String(e.constraint).includes("sku")) throw conflict("Another product already uses this SKU");
  }
  throw e;
}

export async function createProduct(businessId: string, actorId: string, i: any, canSeeCost: boolean, ip?: string) {
  await assertWithin(businessId, "products");
  await assertOwned("categories", i.categoryId, businessId);
  await assertOwned("suppliers", i.supplierId, businessId);
  const id = await tx(async (c) => {
    let row;
    try {
      row = (await c.query(
        `INSERT INTO products (business_id, category_id, supplier_id, name, sku, barcode, description, images, cost_price, selling_price, tax_rate, unit, min_stock, is_listed, hsn_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id, sku`,
        [businessId, i.categoryId ?? null, i.supplierId ?? null, i.name, i.sku || null, i.barcode || null, i.description ?? null, JSON.stringify(i.images ?? []),
         i.costPrice ?? 0, i.sellingPrice ?? 0, i.taxRate ?? 0, i.unit ?? "pcs", i.minStock ?? 0, i.isListed ?? false, i.hsnCode || null])).rows[0];
    } catch (e) { mapUnique(e); }
    if (i.openingStock > 0) {
      await applyMovement(c, { businessId, productId: row.id, type: "opening", delta: i.openingStock, note: "Opening stock", actorId });
    }
    await audit({ actorId, businessId, action: "product.create", entity: "product", entityId: row.id, metadata: { sku: row.sku }, ip }, c);
    return row.id as string;
  });
  return getProduct(businessId, id, canSeeCost);
}

export async function listProducts(businessId: string, f: any, canSeeCost: boolean) {
  const where = ["p.business_id=$1"]; const v: any[] = [businessId];
  if (f.q) { v.push(`%${escapeLike(f.q)}%`); where.push(`(p.name ILIKE $${v.length} OR p.sku ILIKE $${v.length} OR p.barcode ILIKE $${v.length})`); }
  if (f.categoryId) { v.push(f.categoryId); where.push(`p.category_id=$${v.length}`); }
  if (f.supplierId) { v.push(f.supplierId); where.push(`p.supplier_id=$${v.length}`); }
  if (f.status) { v.push(f.status); where.push(`p.status=$${v.length}`); }
  if (f.lowStock) where.push("p.stock_qty <= p.min_stock AND p.status='active'");
  const w = where.join(" AND ");
  const sorts: Record<string, string> = { name: "lower(p.name)", sku: "p.sku", stock: "p.stock_qty", price: "p.selling_price", created: "p.created_at" };
  const order = `${sorts[f.sort ?? "name"]} ${f.dir === "desc" ? "DESC" : "ASC"}`;
  const { rows: t } = await pool.query(`SELECT count(*)::int AS n FROM products p WHERE ${w}`, v);
  v.push(f.limit, f.offset);
  const { rows } = await pool.query(`${SEL} WHERE ${w} ORDER BY ${order}, p.id LIMIT $${v.length - 1} OFFSET $${v.length}`, v);
  return { products: rows.map((r) => publicProduct(r, canSeeCost)), total: t[0].n };
}

export async function getProduct(businessId: string, id: string, canSeeCost: boolean) {
  const { rows } = await pool.query(`${SEL} WHERE p.id=$1 AND p.business_id=$2`, [id, businessId]);
  if (!rows[0]) throw notFound();
  return publicProduct(rows[0], canSeeCost);
}

export async function updateProduct(businessId: string, id: string, actorId: string, patch: any, canSeeCost: boolean, ip?: string) {
  if ("categoryId" in patch) await assertOwned("categories", patch.categoryId, businessId);
  if ("supplierId" in patch) await assertOwned("suppliers", patch.supplierId, businessId);
  const map = { hsnCode: "hsn_code", name: "name", sku: "sku", barcode: "barcode", description: "description", categoryId: "category_id", supplierId: "supplier_id",
    costPrice: "cost_price", sellingPrice: "selling_price", taxRate: "tax_rate", unit: "unit", minStock: "min_stock", isListed: "is_listed", status: "status" };
  const { sets, vals } = buildSets(map, patch);
  if ("images" in patch) { vals.push(JSON.stringify(patch.images)); sets.push(`images=$${vals.length}`); }
  if (!sets.length) throw badRequest("Nothing to update");
  vals.push(id, businessId);
  try {
    const r = await pool.query(`UPDATE products SET ${sets.join(", ")}, updated_at=now() WHERE id=$${vals.length - 1} AND business_id=$${vals.length}`, vals);
    if (!r.rowCount) throw notFound();
  } catch (e) { mapUnique(e); }
  await audit({ actorId, businessId, action: "product.update", entity: "product", entityId: id, metadata: { fields: Object.keys(patch) }, ip });
  return getProduct(businessId, id, canSeeCost);
}

// Products are never hard-deleted: movements, orders and purchases reference them.
export async function deactivateProduct(businessId: string, id: string, actorId: string, ip?: string) {
  const { rowCount } = await pool.query("UPDATE products SET status='inactive', is_listed=false, updated_at=now() WHERE id=$1 AND business_id=$2", [id, businessId]);
  if (!rowCount) throw notFound();
  await audit({ actorId, businessId, action: "product.deactivate", entity: "product", entityId: id, ip });
}

export async function listCategories(businessId: string) {
  const { rows } = await pool.query(
    `SELECT c.id, c.name, count(p.id)::int AS product_count FROM categories c LEFT JOIN products p ON p.category_id=c.id
      WHERE c.business_id=$1 GROUP BY c.id ORDER BY c.name`, [businessId]);
  return rows.map((r) => ({ id: r.id, name: r.name, productCount: r.product_count }));
}
export async function createCategory(businessId: string, actorId: string, name: string, ip?: string) {
  try {
    const { rows } = await pool.query("INSERT INTO categories (business_id, name) VALUES ($1,$2) RETURNING id, name", [businessId, name]);
    await audit({ actorId, businessId, action: "category.create", entity: "category", entityId: rows[0].id, ip });
    return { id: rows[0].id, name: rows[0].name, productCount: 0 };
  } catch (e: any) { if (e.code === "23505") throw conflict("A category with this name already exists"); throw e; }
}
export async function renameCategory(businessId: string, id: string, name: string) {
  try {
    const { rows } = await pool.query("UPDATE categories SET name=$3 WHERE id=$1 AND business_id=$2 RETURNING id, name", [id, businessId, name]);
    if (!rows[0]) throw notFound();
    return { id: rows[0].id, name: rows[0].name };
  } catch (e: any) { if (e.code === "23505") throw conflict("A category with this name already exists"); throw e; }
}
export async function deleteCategory(businessId: string, id: string, actorId: string, ip?: string) {
  const { rowCount } = await pool.query("DELETE FROM categories WHERE id=$1 AND business_id=$2", [id, businessId]);
  if (!rowCount) throw notFound();
  await audit({ actorId, businessId, action: "category.delete", entity: "category", entityId: id, ip });
}
