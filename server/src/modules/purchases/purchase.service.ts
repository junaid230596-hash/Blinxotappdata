import type { PoolClient } from "pg";
import { pool, tx } from "../../db.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { fromCents, toCents } from "../../lib/money.js";
import { escapeLike, nextNumber } from "../../lib/sql.js";
import { audit } from "../audit/audit.service.js";
import { applyMovement } from "../inventory/inventory.service.js";
import { notifyMembersWith } from "../notifications/notification.service.js";
import { insertOrder } from "../orders/order.service.js";

const pubItem = (r: any) => ({
  id: r.id, productId: r.product_id, supplierProductId: r.supplier_product_id, name: r.name, sku: r.sku,
  quantity: Number(r.quantity), unitCost: Number(r.unit_cost), receivedQty: Number(r.received_qty), remainingQty: Number(r.quantity) - Number(r.received_qty),
});
const pub = (r: any) => ({
  id: r.id, poNumber: r.po_number, status: r.status, supplierId: r.supplier_id, supplierName: r.supplier_name, linkedSupplier: !!r.linked_business_id, supplierBusinessId: r.linked_business_id ?? null,
  total: Number(r.total), notes: r.notes, expectedDate: r.expected_date_text ?? null, sentAt: r.sent_at, createdAt: r.created_at,
  order: r.order_id ? { id: r.order_id, orderNumber: r.order_number, status: r.order_status, requiresOtp: r.order_requires_otp } : null,
});
const SEL = `SELECT p.*, p.expected_date::text AS expected_date_text, s.name AS supplier_name, s.linked_business_id,
                    o.id AS order_id, o.order_number, o.status AS order_status, o.requires_otp AS order_requires_otp
               FROM purchases p JOIN suppliers s ON s.id=p.supplier_id LEFT JOIN orders o ON o.purchase_id=p.id`;

async function resolveItems(c: PoolClient, businessId: string, supplier: any, items: any[]) {
  if (!items.length) throw badRequest("A purchase needs at least one item");
  const linked = !!supplier.linked_business_id;
  const out: any[] = [];
  for (const it of items) {
    let name = it.name, sku = it.sku ?? null, unitCost = it.unitCost, productId: string | null = it.productId ?? null, supplierProductId: string | null = it.supplierProductId ?? null;
    if (productId) {
      const { rows } = await c.query("SELECT name, sku, cost_price FROM products WHERE id=$1 AND business_id=$2", [productId, businessId]);
      if (!rows[0]) throw badRequest("Unknown product on your purchase");
      name = name ?? rows[0].name; sku = sku ?? rows[0].sku; unitCost = unitCost ?? Number(rows[0].cost_price);
    }
    if (linked) {
      if (!supplierProductId) throw badRequest("Items for a marketplace supplier must reference one of their products");
      const { rows } = await c.query("SELECT name, sku, selling_price FROM products WHERE id=$1 AND business_id=$2 AND is_listed AND status='active'", [supplierProductId, supplier.linked_business_id]);
      if (!rows[0]) throw badRequest("A selected supplier product is not available");
      // The supplier sets the price; buyers cannot name their own.
      name = rows[0].name; sku = rows[0].sku; unitCost = Number(rows[0].selling_price);
    } else if (supplierProductId) throw badRequest("Supplier products can only be used with a linked supplier");
    if (!name) throw badRequest("Each item needs a name or a product");
    out.push({ productId, supplierProductId, name, sku, quantity: it.quantity, unitCost: unitCost ?? 0 });
  }
  return out;
}

async function writeItems(c: PoolClient, purchaseId: string, items: any[]) {
  await c.query("DELETE FROM purchase_items WHERE purchase_id=$1", [purchaseId]);
  let totalC = 0;
  for (const it of items) {
    await c.query("INSERT INTO purchase_items (purchase_id, product_id, supplier_product_id, name, sku, quantity, unit_cost) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [purchaseId, it.productId, it.supplierProductId, it.name, it.sku, it.quantity, it.unitCost]);
    totalC += Math.round(it.quantity * toCents(it.unitCost));
  }
  await c.query("UPDATE purchases SET total=$2, updated_at=now() WHERE id=$1", [purchaseId, fromCents(totalC)]);
}

async function getSupplierRow(c: PoolClient, businessId: string, supplierId: string) {
  const { rows } = await c.query("SELECT * FROM suppliers WHERE id=$1 AND business_id=$2", [supplierId, businessId]);
  if (!rows[0]) throw badRequest("Unknown supplier");
  if (rows[0].status !== "active") throw badRequest("This supplier is inactive");
  return rows[0];
}

export async function createPurchase(businessId: string, actorId: string, i: any, ip?: string) {
  const id = await tx(async (c) => {
    const supplier = await getSupplierRow(c, businessId, i.supplierId);
    const items = await resolveItems(c, businessId, supplier, i.items);
    const po = await nextNumber(c, businessId, "purchase", "PO");
    const { rows } = await c.query("INSERT INTO purchases (business_id, supplier_id, po_number, notes, expected_date, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
      [businessId, i.supplierId, po, i.notes ?? null, i.expectedDate ?? null, actorId]);
    await writeItems(c, rows[0].id, items);
    await audit({ actorId, businessId, action: "purchase.create", entity: "purchase", entityId: rows[0].id, metadata: { po }, ip }, c);
    return rows[0].id as string;
  });
  return getPurchase(businessId, id);
}

export async function updatePurchase(businessId: string, id: string, actorId: string, patch: any, ip?: string) {
  await tx(async (c) => {
    const { rows } = await c.query("SELECT * FROM purchases WHERE id=$1 AND business_id=$2 FOR UPDATE", [id, businessId]);
    if (!rows[0]) throw notFound();
    if (rows[0].status !== "draft") throw conflict("Only draft purchases can be edited");
    if ("notes" in patch) await c.query("UPDATE purchases SET notes=$2 WHERE id=$1", [id, patch.notes ?? null]);
    if ("expectedDate" in patch) await c.query("UPDATE purchases SET expected_date=$2 WHERE id=$1", [id, patch.expectedDate ?? null]);
    if (patch.items) {
      const supplier = await getSupplierRow(c, businessId, rows[0].supplier_id);
      await writeItems(c, id, await resolveItems(c, businessId, supplier, patch.items));
    }
    await c.query("UPDATE purchases SET updated_at=now() WHERE id=$1", [id]);
    await audit({ actorId, businessId, action: "purchase.update", entity: "purchase", entityId: id, ip }, c);
  });
  return getPurchase(businessId, id);
}

export async function listPurchases(businessId: string, f: any) {
  const where = ["p.business_id=$1"]; const v: any[] = [businessId];
  if (f.status) { v.push(f.status); where.push(`p.status=$${v.length}`); }
  if (f.supplierId) { v.push(f.supplierId); where.push(`p.supplier_id=$${v.length}`); }
  if (f.q) { v.push(`%${escapeLike(f.q)}%`); where.push(`p.po_number ILIKE $${v.length}`); }
  if (f.from) { v.push(f.from); where.push(`p.created_at >= $${v.length}::date`); }
  if (f.to) { v.push(f.to); where.push(`p.created_at < ($${v.length}::date + 1)`); }
  if (f.pending) where.push("p.status IN ('sent','accepted','partially_received')");
  const w = where.join(" AND ");
  const { rows: t } = await pool.query(`SELECT count(*)::int AS n FROM purchases p WHERE ${w}`, v);
  v.push(f.limit, f.offset);
  const { rows } = await pool.query(`${SEL} WHERE ${w} ORDER BY p.created_at DESC, p.id LIMIT $${v.length - 1} OFFSET $${v.length}`, v);
  return { purchases: rows.map(pub), total: t[0].n };
}

export async function getPurchase(businessId: string, id: string) {
  const { rows } = await pool.query(`${SEL} WHERE p.id=$1 AND p.business_id=$2`, [id, businessId]);
  if (!rows[0]) throw notFound();
  const { rows: items } = await pool.query("SELECT * FROM purchase_items WHERE purchase_id=$1 ORDER BY name", [id]);
  return { ...pub(rows[0]), items: items.map(pubItem) };
}

export async function sendPurchase(businessId: string, id: string, actorId: string, ip?: string) {
  let notifyTarget: { businessId: string; po: string; buyer: string; orderId: string } | null = null;
  await tx(async (c) => {
    const { rows } = await c.query("SELECT * FROM purchases WHERE id=$1 AND business_id=$2 FOR UPDATE", [id, businessId]);
    const p = rows[0];
    if (!p) throw notFound();
    if (p.status !== "draft") throw conflict(`A ${p.status} purchase cannot be sent`);
    const { rows: items } = await c.query("SELECT * FROM purchase_items WHERE purchase_id=$1", [id]);
    if (!items.length) throw badRequest("Add items before sending");
    const supplier = (await c.query("SELECT * FROM suppliers WHERE id=$1", [p.supplier_id])).rows[0];
    if (supplier.linked_business_id) {
      // Re-check availability, then hand the PO to the supplier as an incoming order at *their* current prices.
      const ids = items.map((i) => i.supplier_product_id);
      const { rows: ok } = await c.query("SELECT id FROM products WHERE business_id=$1 AND id = ANY($2::uuid[]) AND is_listed AND status='active'", [supplier.linked_business_id, ids]);
      if (ok.length !== new Set(ids).size) throw conflict("Some items are no longer available from this supplier");
      const buyer = (await c.query("SELECT name, address FROM businesses WHERE id=$1", [businessId])).rows[0];
      const order = await insertOrder(c, { businessId: supplier.linked_business_id, createdBy: actorId, buyerBusinessId: businessId, purchaseId: id, requiresOtp: true,
        deliveryAddress: buyer.address, notes: `PO ${p.po_number}`, lines: items.map((i) => ({ productId: i.supplier_product_id, quantity: Number(i.quantity) })), allowPriceOverride: false });
      const { rows: oi } = await c.query("SELECT product_id, unit_price FROM order_items WHERE order_id=$1", [order.id]);
      for (const row of oi) await c.query("UPDATE purchase_items SET unit_cost=$2 WHERE purchase_id=$1 AND supplier_product_id=$3", [id, row.unit_price, row.product_id]);
      await c.query("UPDATE purchases SET total=$2 WHERE id=$1", [id, order.total]);
      await audit({ actorId, businessId: supplier.linked_business_id, action: "order.received_from_purchase", entity: "order", entityId: order.id, metadata: { from: buyer.name, po: p.po_number } }, c);
      notifyTarget = { businessId: supplier.linked_business_id, po: p.po_number, buyer: buyer.name, orderId: order.id };
    }
    await c.query("UPDATE purchases SET status='sent', sent_at=now(), updated_at=now() WHERE id=$1", [id]);
    await audit({ actorId, businessId, action: "purchase.send", entity: "purchase", entityId: id, metadata: { po: p.po_number, linked: !!supplier.linked_business_id }, ip }, c);
  });
  if (notifyTarget) {
    const t = notifyTarget as { businessId: string; po: string; buyer: string; orderId: string };
    await notifyMembersWith(t.businessId, "orders.manage", { type: "order.new", title: `New order from ${t.buyer}`, body: `Purchase order ${t.po}`, data: { orderId: t.orderId, businessId: t.businessId } });
  }
  return getPurchase(businessId, id);
}

export async function acceptPurchase(businessId: string, id: string, actorId: string, ip?: string) {
  await tx(async (c) => {
    const { rows } = await c.query(`SELECT p.*, s.linked_business_id FROM purchases p JOIN suppliers s ON s.id=p.supplier_id WHERE p.id=$1 AND p.business_id=$2 FOR UPDATE OF p`, [id, businessId]);
    if (!rows[0]) throw notFound();
    if (rows[0].linked_business_id) throw conflict("This purchase is accepted by the supplier through their order");
    if (rows[0].status !== "sent") throw conflict("Only sent purchases can be marked accepted");
    await c.query("UPDATE purchases SET status='accepted', updated_at=now() WHERE id=$1", [id]);
    await audit({ actorId, businessId, action: "purchase.accept", entity: "purchase", entityId: id, ip }, c);
  });
  return getPurchase(businessId, id);
}

export async function cancelPurchase(businessId: string, id: string, actorId: string, ip?: string) {
  await tx(async (c) => {
    const { rows } = await c.query("SELECT * FROM purchases WHERE id=$1 AND business_id=$2 FOR UPDATE", [id, businessId]);
    const p = rows[0];
    if (!p) throw notFound();
    if (!["draft", "sent", "accepted"].includes(p.status)) throw conflict(`A ${p.status.replace("_", " ")} purchase cannot be cancelled`);
    const { rows: rec } = await c.query("SELECT 1 FROM purchase_items WHERE purchase_id=$1 AND received_qty > 0 LIMIT 1", [id]);
    if (rec[0]) throw conflict("Stock has already been received against this purchase");
    const { rows: ord } = await c.query("SELECT id, status FROM orders WHERE purchase_id=$1 FOR UPDATE", [id]);
    if (ord[0]) {
      // The buyer may only withdraw while the supplier has not yet accepted.
      if (ord[0].status !== "pending") throw conflict("The supplier has already accepted this order. Ask them to cancel it.");
      await c.query("UPDATE orders SET status='cancelled', cancelled_at=now(), updated_at=now() WHERE id=$1", [ord[0].id]);
    }
    await c.query("UPDATE purchases SET status='cancelled', updated_at=now() WHERE id=$1", [id]);
    await audit({ actorId, businessId, action: "purchase.cancel", entity: "purchase", entityId: id, ip }, c);
  });
  return getPurchase(businessId, id);
}

export async function receivePurchase(businessId: string, id: string, actorId: string, lines: { itemId: string; quantity: number; unitCost?: number; productId?: string }[], ip?: string) {
  await tx(async (c) => {
    const { rows } = await c.query("SELECT * FROM purchases WHERE id=$1 AND business_id=$2 FOR UPDATE", [id, businessId]);
    const p = rows[0];
    if (!p) throw notFound();
    if (!["accepted", "partially_received"].includes(p.status)) throw conflict(`A ${p.status.replace("_", " ")} purchase cannot receive stock`);
    const { rows: ord } = await c.query("SELECT status FROM orders WHERE purchase_id=$1", [id]);
    if (ord[0] && ord[0].status !== "delivered") throw conflict("Stock can be received once the supplier has completed delivery");
    const seen = new Set<string>();
    for (const l of lines) {
      if (seen.has(l.itemId)) throw badRequest("Each item may appear once per receipt");
      seen.add(l.itemId);
      const { rows: it } = await c.query("SELECT * FROM purchase_items WHERE id=$1 AND purchase_id=$2 FOR UPDATE", [l.itemId, id]);
      if (!it[0]) throw badRequest("Unknown purchase item");
      if (l.quantity > Number(it[0].quantity) - Number(it[0].received_qty) + 1e-9) throw conflict(`Cannot receive more than ordered for "${it[0].name}"`);
      let productId = it[0].product_id ?? l.productId;
      if (!productId) throw badRequest(`Choose which product "${it[0].name}" should be received into`);
      if (!it[0].product_id) {
        const { rows: own } = await c.query("SELECT 1 FROM products WHERE id=$1 AND business_id=$2", [productId, businessId]);
        if (!own[0]) throw badRequest("Unknown product");
        await c.query("UPDATE purchase_items SET product_id=$2 WHERE id=$1", [l.itemId, productId]);
      }
      const cost = l.unitCost ?? Number(it[0].unit_cost);
      await applyMovement(c, { businessId, productId, type: "purchase_receipt", delta: l.quantity, unitCost: cost, refType: "purchase", refId: id, note: p.po_number, actorId });
      await c.query("UPDATE purchase_items SET received_qty = received_qty + $2::numeric WHERE id=$1", [l.itemId, l.quantity]);
    }
    const { rows: left } = await c.query("SELECT count(*)::int AS n FROM purchase_items WHERE purchase_id=$1 AND received_qty < quantity", [id]);
    await c.query("UPDATE purchases SET status=$2, updated_at=now() WHERE id=$1", [id, left[0].n === 0 ? "received" : "partially_received"]);
    await audit({ actorId, businessId, action: "purchase.receive", entity: "purchase", entityId: id, metadata: { lines: lines.length, complete: left[0].n === 0 }, ip }, c);
  });
  return getPurchase(businessId, id);
}
