import { pool, tx } from "../../db.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { audit } from "../audit/audit.service.js";
import { notifyMembersWith } from "../notifications/notification.service.js";
import { getInvoiceForBuyer, invoiceBrief } from "../invoices/invoice.service.js";
import { insertOrder } from "./order.service.js";

// An individual's own view of their marketplace orders. Everything is scoped by buyer_user_id; the seller's
// internal data (audit actors, stock, costs) is never returned.

const pubMine = (r: any) => ({
  id: r.id, orderNumber: r.order_number, status: r.status, subtotal: Number(r.subtotal), taxTotal: Number(r.tax_total), total: Number(r.total),
  notes: r.notes, deliveryAddress: r.delivery_address, phone: r.buyer_phone, createdAt: r.created_at, deliveredAt: r.delivered_at, cancelledAt: r.cancelled_at,
  seller: { id: r.business_id, name: r.seller_name, slug: r.seller_slug }, canCancel: r.status === "pending",
});
const SEL = `SELECT o.*, b.name AS seller_name, b.slug AS seller_slug FROM orders o JOIN businesses b ON b.id=o.business_id`;

const nameOf = async (id: string) => (await pool.query("SELECT full_name FROM users WHERE id=$1", [id])).rows[0]?.full_name ?? "A customer";

export async function placeOrder(userId: string, i: { businessId: string; items: { productId: string; quantity: number }[]; deliveryAddress: string; phone: string; notes?: string; stateCode?: string }, ip?: string) {
  const user = { id: userId, fullName: await nameOf(userId) };
  const { rows: biz } = await pool.query("SELECT id, name FROM businesses WHERE id=$1 AND is_public AND status='active'", [i.businessId]);
  if (!biz[0]) throw notFound("Business not found");
  const { rows: mem } = await pool.query("SELECT 1 FROM business_members WHERE business_id=$1 AND user_id=$2 AND status='active'", [i.businessId, user.id]);
  if (mem[0]) throw forbidden("You cannot order from your own business");

  const qty = new Map<string, number>();                                  // merge duplicate lines
  for (const l of i.items) qty.set(l.productId, (qty.get(l.productId) ?? 0) + l.quantity);
  const out = await tx(async (c) => {
    const { rows: prods } = await c.query("SELECT id, name, stock_qty FROM products WHERE business_id=$1 AND id = ANY($2::uuid[]) AND is_listed AND status='active'", [i.businessId, [...qty.keys()]]);
    if (prods.length !== qty.size) throw badRequest("One of the products is no longer available");
    for (const p of prods) if (Number(p.stock_qty) < (qty.get(p.id) ?? 0)) throw conflict(`Not enough stock for ${p.name}`);
    // Always OTP-confirmed: the code goes to the buyer's notifications and email when the seller dispatches.
    const r = await insertOrder(c, { businessId: i.businessId, createdBy: user.id, buyerUserId: user.id, buyerPhone: i.phone, placeOfSupply: i.stateCode, requiresOtp: true, notes: i.notes,
      deliveryAddress: i.deliveryAddress, lines: [...qty].map(([productId, quantity]) => ({ productId, quantity })), allowPriceOverride: false });
    await audit({ actorId: user.id, businessId: i.businessId, action: "order.create", entity: "order", entityId: r.id, metadata: { number: r.number, total: r.total, source: "individual" }, ip }, c);
    return r;
  });
  await notifyMembersWith(i.businessId, "orders.manage", { type: "order.new", title: `New order from ${user.fullName}`, body: `${out.number} · ${out.total}`, data: { orderId: out.id, businessId: i.businessId } });
  return getMine(user.id, out.id);
}

export async function listMine(userId: string, limit: number, offset: number) {
  const { rows: t } = await pool.query("SELECT count(*)::int AS n FROM orders WHERE buyer_user_id=$1", [userId]);
  const { rows } = await pool.query(`${SEL} WHERE o.buyer_user_id=$1 ORDER BY o.created_at DESC, o.id LIMIT $2 OFFSET $3`, [userId, limit, offset]);
  return { orders: rows.map(pubMine), total: t[0].n };
}

export async function getMine(userId: string, id: string) {
  const { rows } = await pool.query(`${SEL} WHERE o.id=$1 AND o.buyer_user_id=$2`, [id, userId]);       // someone else's order is simply "not found"
  if (!rows[0]) throw notFound();
  const [items, hist, otp] = await Promise.all([
    pool.query("SELECT product_id, name, sku, quantity, unit_price, tax_rate, line_total FROM order_items WHERE order_id=$1 ORDER BY name", [id]),
    pool.query("SELECT metadata->>'to' AS status, created_at FROM audit_logs WHERE entity='order' AND entity_id=$1 AND action='order.status' ORDER BY id", [id]),
    pool.query("SELECT 1 FROM order_otps WHERE order_id=$1 AND used_at IS NULL AND invalidated_at IS NULL AND expires_at > now()", [id]),
  ]);
  return { ...pubMine(rows[0]), invoice: await invoiceBrief(id), codeIssued: !!otp.rows[0],
    items: items.rows.map((r) => ({ productId: r.product_id, name: r.name, sku: r.sku, quantity: Number(r.quantity), unitPrice: Number(r.unit_price), taxRate: Number(r.tax_rate), lineTotal: Number(r.line_total) })),
    timeline: [{ status: "pending", at: rows[0].created_at }, ...hist.rows.map((h) => ({ status: h.status, at: h.created_at }))] };
}

/** Buyers may cancel only while the seller has not accepted (nothing is reserved yet). After that, contact the seller. */
export async function cancelMine(userId: string, id: string, ip?: string) {
  const user = { id: userId, fullName: await nameOf(userId) };
  const order = await tx(async (c) => {
    const { rows } = await c.query("SELECT * FROM orders WHERE id=$1 AND buyer_user_id=$2 FOR UPDATE", [id, user.id]);
    if (!rows[0]) throw notFound();
    if (rows[0].status !== "pending") throw conflict("The seller has already started on this order, so it can't be cancelled here. Please contact the seller.");
    await c.query("UPDATE orders SET status='cancelled', cancelled_at=now(), updated_at=now() WHERE id=$1", [id]);
    await audit({ actorId: user.id, businessId: rows[0].business_id, action: "order.status", entity: "order", entityId: id, metadata: { from: "pending", to: "cancelled", by: "buyer" }, ip }, c);
    return rows[0];
  });
  await notifyMembersWith(order.business_id, "orders.manage", { type: "order.status", title: `${user.fullName} cancelled order ${order.order_number}`, data: { orderId: id, businessId: order.business_id, status: "cancelled" } });
  return getMine(user.id, id);
}

export const invoiceFor = getInvoiceForBuyer;
