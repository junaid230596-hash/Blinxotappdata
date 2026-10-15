import type { PoolClient } from "pg";
import { pool, tx } from "../../db.js";
import { AppError, notFound } from "../../lib/errors.js";
import { audit } from "../audit/audit.service.js";
import { notify } from "../notifications/notification.service.js";

export type MoveType = "opening" | "stock_in" | "stock_out" | "adjustment" | "purchase_receipt" | "sale" | "sale_cancel" | "sale_return" | "damaged";

export interface Movement {
  businessId: string; productId: string; type: MoveType;
  delta: number | string;               // signed quantity; negative removes stock
  unitCost?: number | null;             // when > 0 delta and set, updates weighted-average cost
  refType?: string; refId?: string; note?: string; actorId?: string | null;
}
export interface MoveResult { productId: string; name: string; before: number; after: number; crossedLow: boolean }

/**
 * THE ONLY function allowed to change products.stock_qty.
 * Must run inside a transaction: it locks the product row, applies the change atomically in SQL
 * (so decimals stay exact), relies on CHECK(stock_qty >= 0) to make overselling impossible,
 * and writes the movement row that makes every change traceable.
 */
export async function applyMovement(c: PoolClient, m: Movement): Promise<MoveResult> {
  const { rows } = await c.query(
    "SELECT name, stock_qty, min_stock FROM products WHERE id=$1 AND business_id=$2 FOR UPDATE", [m.productId, m.businessId]);
  if (!rows[0]) throw notFound("Product not found");
  const p = rows[0];
  let upd;
  try {
    upd = await c.query(
      `UPDATE products SET stock_qty = stock_qty + $1::numeric,
         cost_price = CASE WHEN $2::numeric IS NOT NULL AND $1::numeric > 0
                           THEN round((stock_qty * cost_price + $1::numeric * $2::numeric) / (stock_qty + $1::numeric), 2)
                           ELSE cost_price END,
         updated_at = now()
       WHERE id=$3 RETURNING stock_qty`, [m.delta, m.unitCost ?? null, m.productId]);
  } catch (e: any) {
    if (e.code === "23514") {
      throw new AppError(409, "INSUFFICIENT_STOCK", `Insufficient stock for "${p.name}" (available: ${Number(p.stock_qty)})`);
    }
    throw e;
  }
  const after = upd.rows[0].stock_qty;
  await c.query(
    `INSERT INTO inventory_movements (business_id, product_id, type, quantity_delta, balance_after, unit_cost, ref_type, ref_id, note, actor_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [m.businessId, m.productId, m.type, m.delta, after, m.unitCost ?? null, m.refType ?? null, m.refId ?? null, m.note ?? null, m.actorId ?? null]);
  const before = Number(p.stock_qty), afterN = Number(after), min = Number(p.min_stock);
  return { productId: m.productId, name: p.name, before, after: afterN, crossedLow: Number(m.delta) < 0 && before > min && afterN <= min };
}

// Notifies stock managers once per downward crossing of the minimum. Call AFTER the transaction commits.
export async function flushLowStock(businessId: string, results: MoveResult[]) {
  const low = results.filter((r) => r.crossedLow);
  if (!low.length) return;
  const { rows } = await pool.query(
    `SELECT DISTINCT m.user_id FROM business_members m JOIN role_permissions rp ON rp.role_id=m.role_id
      WHERE m.business_id=$1 AND m.status='active' AND rp.permission_key='inventory.manage'`, [businessId]);
  for (const r of low) {
    for (const u of rows) {
      await notify(u.user_id, { type: "inventory.low_stock", title: r.after === 0 ? `Out of stock: ${r.name}` : `Low stock: ${r.name}`,
        body: `${r.after} left`, data: { productId: r.productId, businessId } });
    }
  }
}

interface Ctx { businessId: string; actorId: string; ip?: string }

async function single(ctx: Ctx, m: Omit<Movement, "businessId" | "actorId">, auditAction: string) {
  const res = await tx(async (c) => {
    const r = await applyMovement(c, { ...m, businessId: ctx.businessId, actorId: ctx.actorId });
    await audit({ actorId: ctx.actorId, businessId: ctx.businessId, action: auditAction, entity: "product", entityId: m.productId,
      metadata: { type: m.type, delta: Number(m.delta), after: r.after }, ip: ctx.ip }, c);
    return r;
  });
  await flushLowStock(ctx.businessId, [res]);
  return res;
}

export const stockIn = (ctx: Ctx, i: { productId: string; quantity: number; unitCost?: number; note?: string }) =>
  single(ctx, { productId: i.productId, type: "stock_in", delta: i.quantity, unitCost: i.unitCost ?? null, note: i.note }, "inventory.stock_in");

export const stockOut = (ctx: Ctx, i: { productId: string; quantity: number; note?: string }) =>
  single(ctx, { productId: i.productId, type: "stock_out", delta: -i.quantity, note: i.note }, "inventory.stock_out");

export const writeOffDamaged = (ctx: Ctx, i: { productId: string; quantity: number; note?: string }) =>
  single(ctx, { productId: i.productId, type: "damaged", delta: -i.quantity, note: i.note }, "inventory.damaged");

// Sets stock to a counted quantity; records the difference. No-op (and no movement) if unchanged.
export async function adjust(ctx: Ctx, i: { productId: string; newQuantity: number; reason: string }) {
  const res = await tx(async (c) => {
    const { rows } = await c.query("SELECT ($3::numeric - stock_qty) AS delta FROM products WHERE id=$1 AND business_id=$2 FOR UPDATE",
      [i.productId, ctx.businessId, i.newQuantity]);
    if (!rows[0]) throw notFound("Product not found");
    if (Number(rows[0].delta) === 0) return null;
    const r = await applyMovement(c, { businessId: ctx.businessId, productId: i.productId, type: "adjustment", delta: rows[0].delta, note: i.reason, actorId: ctx.actorId });
    await audit({ actorId: ctx.actorId, businessId: ctx.businessId, action: "inventory.adjust", entity: "product", entityId: i.productId,
      metadata: { from: r.before, to: r.after, reason: i.reason }, ip: ctx.ip }, c);
    return r;
  });
  if (res) await flushLowStock(ctx.businessId, [res]);
  return res ?? { productId: i.productId, unchanged: true };
}

export async function listMovements(businessId: string, f: { productId?: string; type?: string; from?: string; to?: string; limit: number; offset: number }) {
  const where = ["m.business_id=$1"]; const v: any[] = [businessId];
  if (f.productId) { v.push(f.productId); where.push(`m.product_id=$${v.length}`); }
  if (f.type) { v.push(f.type); where.push(`m.type=$${v.length}`); }
  if (f.from) { v.push(f.from); where.push(`m.created_at >= $${v.length}::date`); }
  if (f.to) { v.push(f.to); where.push(`m.created_at < ($${v.length}::date + 1)`); }
  const w = where.join(" AND ");
  const { rows: t } = await pool.query(`SELECT count(*)::int AS n FROM inventory_movements m WHERE ${w}`, v);
  v.push(f.limit, f.offset);
  const { rows } = await pool.query(
    `SELECT m.*, p.name AS product_name, p.sku, u.full_name AS actor_name FROM inventory_movements m
       JOIN products p ON p.id=m.product_id LEFT JOIN users u ON u.id=m.actor_id
      WHERE ${w} ORDER BY m.id DESC LIMIT $${v.length - 1} OFFSET $${v.length}`, v);
  return { movements: rows.map((r) => ({
    id: Number(r.id), productId: r.product_id, productName: r.product_name, sku: r.sku, type: r.type,
    quantityDelta: Number(r.quantity_delta), balanceAfter: Number(r.balance_after), unitCost: r.unit_cost == null ? null : Number(r.unit_cost),
    refType: r.ref_type, refId: r.ref_id, note: r.note, actorName: r.actor_name, createdAt: r.created_at })), total: t[0].n };
}

export async function lowStock(businessId: string) {
  const { rows } = await pool.query(
    `SELECT id, name, sku, unit, stock_qty, min_stock FROM products
      WHERE business_id=$1 AND status='active' AND stock_qty <= min_stock ORDER BY (stock_qty - min_stock), name`, [businessId]);
  return rows.map((r) => ({ id: r.id, name: r.name, sku: r.sku, unit: r.unit, stockQty: Number(r.stock_qty), minStock: Number(r.min_stock) }));
}

export async function valuation(businessId: string) {
  const { rows } = await pool.query(
    `SELECT COALESCE(c.name::text, 'Uncategorised') AS category, count(*)::int AS products,
            COALESCE(sum(p.stock_qty * p.cost_price),0) AS cost_value, COALESCE(sum(p.stock_qty * p.selling_price),0) AS retail_value
       FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE p.business_id=$1 AND p.status='active' GROUP BY c.name ORDER BY 1`, [businessId]);
  const by = rows.map((r) => ({ category: r.category, products: r.products, costValue: Number(r.cost_value), retailValue: Number(r.retail_value) }));
  const sum = (k: "costValue" | "retailValue") => Math.round(by.reduce((n, r) => n + r[k], 0) * 100) / 100;
  return { totalCostValue: sum("costValue"), totalRetailValue: sum("retailValue"), byCategory: by };
}
