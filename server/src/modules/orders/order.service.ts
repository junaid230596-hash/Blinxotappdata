import crypto from "node:crypto";
import type { PoolClient } from "pg";
import { config } from "../../config.js";
import { pool, tx } from "../../db.js";
import { AppError, badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { sendMail } from "../../lib/email.js";
import { fromCents, lineTotals, toCents } from "../../lib/money.js";
import { escapeLike, nextNumber } from "../../lib/sql.js";
import { audit } from "../audit/audit.service.js";
import { applyMovement, flushLowStock, type MoveResult } from "../inventory/inventory.service.js";
import { notify, notifyMembersWith } from "../notifications/notification.service.js";
import { invoiceBrief, issueCreditNote, issueInvoice, voidInvoice } from "../invoices/invoice.service.js";
import { assertWithin } from "../plans/plan.service.js";

export type OrderStatus = "pending" | "accepted" | "processing" | "ready" | "dispatched" | "delivered" | "cancelled" | "returned";

// Allowed manual transitions. 'delivered' (when OTP is required) and 'returned' have dedicated flows.
export const TRANSITIONS: Record<string, OrderStatus[]> = {
  pending: ["accepted", "cancelled"],
  accepted: ["processing", "cancelled"],
  processing: ["ready", "cancelled"],
  ready: ["dispatched", "delivered", "cancelled"],
  dispatched: ["delivered"],
  delivered: [],
  cancelled: [],
  returned: [],
};

const OTP_TTL_MIN = 24 * 60;
const OTP_MAX_ATTEMPTS = 5;
const OTP_REGEN_COOLDOWN_SEC = 30;

const hashOtp = (orderId: string, otp: string) =>
  crypto.createHmac("sha256", config.JWT_ACCESS_SECRET).update(`${orderId}:${otp}`).digest("hex");

const pubItem = (r: any) => ({
  id: r.id, productId: r.product_id, name: r.name, sku: r.sku, quantity: Number(r.quantity), unitPrice: Number(r.unit_price),
  taxRate: Number(r.tax_rate), lineSubtotal: Number(r.line_subtotal), lineTax: Number(r.line_tax), lineTotal: Number(r.line_total),
  returnedQty: Number(r.returned_qty),
});
export const pubOrder = (r: any) => ({
  id: r.id, orderNumber: r.order_number, status: r.status, requiresOtp: r.requires_otp, customerId: r.customer_id, customerName: r.customer_name ?? null,
  buyerBusinessId: r.buyer_business_id, buyerBusinessName: r.buyer_name ?? null, purchaseId: r.purchase_id,
  placeOfSupply: r.place_of_supply ?? null, buyerType: r.buyer_business_id ? "business" : r.buyer_user_id ? "individual" : null, buyerName: r.buyer_name ?? r.buyer_person_name ?? null, buyerPhone: r.buyer_phone ?? null,
  subtotal: Number(r.subtotal), taxTotal: Number(r.tax_total), total: Number(r.total), notes: r.notes, deliveryAddress: r.delivery_address,
  createdAt: r.created_at, deliveredAt: r.delivered_at, cancelledAt: r.cancelled_at,
});
const SEL = `SELECT o.*, c.name AS customer_name, b.name AS buyer_name, bu.full_name AS buyer_person_name FROM orders o
               LEFT JOIN customers c ON c.id=o.customer_id LEFT JOIN businesses b ON b.id=o.buyer_business_id LEFT JOIN users bu ON bu.id=o.buyer_user_id`;

interface LineInput { productId: string; quantity: number; unitPrice?: number }

/** Prices lines from the seller's own catalogue and inserts order + items. Runs inside the caller's transaction. */
export async function insertOrder(c: PoolClient, o: {
  businessId: string; createdBy: string | null; customerId?: string | null; buyerBusinessId?: string | null; buyerUserId?: string | null; buyerPhone?: string | null; purchaseId?: string | null; placeOfSupply?: string | null;
  requiresOtp: boolean; notes?: string | null; deliveryAddress?: string | null; lines: LineInput[]; allowPriceOverride: boolean;
}) {
  if (!o.lines.length) throw badRequest("An order needs at least one item");
  const ids = [...new Set(o.lines.map((l) => l.productId))];
  const { rows: prods } = await c.query("SELECT * FROM products WHERE business_id=$1 AND id = ANY($2::uuid[])", [o.businessId, ids]);
  const byId = new Map(prods.map((p) => [p.id, p]));
  let sub = 0, tax = 0;
  const items = o.lines.map((l) => {
    const p = byId.get(l.productId);
    if (!p || p.status !== "active") throw badRequest("One of the products is unavailable");
    if (l.unitPrice != null && !o.allowPriceOverride) throw forbidden("You cannot override prices");
    const price = l.unitPrice ?? Number(p.selling_price);
    const t = lineTotals(l.quantity, price, Number(p.tax_rate));
    sub += t.subtotal; tax += t.tax;
    return { p, qty: l.quantity, price, t };
  });
  // Place of supply decides CGST+SGST (same state as the seller) or IGST. Default: the buyer's state, else the seller's.
  let pos = o.placeOfSupply ?? null;
  if (!pos && o.customerId) pos = (await c.query("SELECT state_code FROM customers WHERE id=$1", [o.customerId])).rows[0]?.state_code ?? null;
  if (!pos && o.buyerBusinessId) pos = (await c.query("SELECT state_code FROM businesses WHERE id=$1", [o.buyerBusinessId])).rows[0]?.state_code ?? null;
  if (!pos) pos = (await c.query("SELECT state_code FROM businesses WHERE id=$1", [o.businessId])).rows[0]?.state_code ?? null;
  const number = await nextNumber(c, o.businessId, "order", "ORD");
  const { rows } = await c.query(
    `INSERT INTO orders (business_id, order_number, customer_id, buyer_business_id, buyer_user_id, buyer_phone, purchase_id, requires_otp, subtotal, tax_total, total, notes, delivery_address, created_by, place_of_supply)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id, total`,
    [o.businessId, number, o.customerId ?? null, o.buyerBusinessId ?? null, o.buyerUserId ?? null, o.buyerPhone ?? null, o.purchaseId ?? null, o.requiresOtp,
     fromCents(sub), fromCents(tax), fromCents(sub + tax), o.notes ?? null, o.deliveryAddress ?? null, o.createdBy, pos]);
  for (const it of items) {
    await c.query(
      `INSERT INTO order_items (order_id, product_id, name, sku, quantity, unit_price, tax_rate, line_subtotal, line_tax, line_total, hsn_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [rows[0].id, it.p.id, it.p.name, it.p.sku, it.qty, it.price, it.p.tax_rate, fromCents(it.t.subtotal), fromCents(it.t.tax), fromCents(it.t.total), it.p.hsn_code ?? null]);
  }
  return { id: rows[0].id as string, number, total: Number(rows[0].total) };
}

// Plan limits apply to orders staff create directly; incoming marketplace orders are never blocked by the seller's limit.
export async function createOrder(businessId: string, actorId: string, canOverridePrice: boolean, i: any, ip?: string) {
  await assertWithin(businessId, "ordersPerMonth");
  let customer: any = null;
  if (i.customerId) {
    const { rows } = await pool.query("SELECT id, email FROM customers WHERE id=$1 AND business_id=$2", [i.customerId, businessId]);
    if (!rows[0]) throw badRequest("Unknown customer");
    customer = rows[0];
  }
  const canOtp = !!customer?.email;
  if (i.requireOtp === true && !canOtp) throw badRequest("An OTP needs a customer with an email address");
  const requiresOtp = i.requireOtp ?? canOtp;
  const out = await tx(async (c) => {
    const r = await insertOrder(c, { businessId, createdBy: actorId, customerId: i.customerId, requiresOtp, notes: i.notes, deliveryAddress: i.deliveryAddress, placeOfSupply: i.placeOfSupply,
      lines: i.items, allowPriceOverride: canOverridePrice });
    if (i.customerId) await c.query("UPDATE customers SET last_interaction_at=now() WHERE id=$1", [i.customerId]);
    await audit({ actorId, businessId, action: "order.create", entity: "order", entityId: r.id, metadata: { number: r.number, total: r.total }, ip }, c);
    return r;
  });
  return getOrder(businessId, out.id);
}

export async function listOrders(businessId: string, f: any) {
  const where = ["o.business_id=$1"]; const v: any[] = [businessId];
  if (f.status) { v.push(f.status); where.push(`o.status=$${v.length}`); }
  if (f.customerId) { v.push(f.customerId); where.push(`o.customer_id=$${v.length}`); }
  if (f.source === "marketplace") where.push("(o.buyer_business_id IS NOT NULL OR o.buyer_user_id IS NOT NULL)");
  if (f.source === "direct") where.push("o.buyer_business_id IS NULL AND o.buyer_user_id IS NULL");
  if (f.q) { v.push(`%${escapeLike(f.q)}%`); where.push(`o.order_number ILIKE $${v.length}`); }
  if (f.from) { v.push(f.from); where.push(`o.created_at >= $${v.length}::date`); }
  if (f.to) { v.push(f.to); where.push(`o.created_at < ($${v.length}::date + 1)`); }
  const w = where.join(" AND ");
  const { rows: t } = await pool.query(`SELECT count(*)::int AS n FROM orders o WHERE ${w}`, v);
  v.push(f.limit, f.offset);
  const { rows } = await pool.query(`${SEL} WHERE ${w} ORDER BY o.created_at DESC, o.id LIMIT $${v.length - 1} OFFSET $${v.length}`, v);
  return { orders: rows.map(pubOrder), total: t[0].n };
}

export async function getOrder(businessId: string, id: string) {
  const { rows } = await pool.query(`${SEL} WHERE o.id=$1 AND o.business_id=$2`, [id, businessId]);
  if (!rows[0]) throw notFound();
  const [items, returns, history] = await Promise.all([
    pool.query("SELECT * FROM order_items WHERE order_id=$1 ORDER BY name", [id]),
    pool.query(`SELECT r.id, r.code, r.reason, r.refund_total, r.created_at,
                  (SELECT json_agg(json_build_object('orderItemId', ri.order_item_id, 'quantity', ri.quantity, 'condition', ri.condition))
                     FROM order_return_items ri WHERE ri.return_id=r.id) AS items
                  FROM order_returns r WHERE r.order_id=$1 ORDER BY r.created_at`, [id]),
    pool.query(`SELECT a.action, a.metadata, a.created_at, u.full_name AS actor FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id
                 WHERE a.business_id=$1 AND a.entity='order' AND a.entity_id=$2 ORDER BY a.id`, [businessId, id]),
  ]);
  return { ...pubOrder(rows[0]), invoice: await invoiceBrief(id), items: items.rows.map(pubItem),
    returns: returns.rows.map((r) => ({ id: r.id, code: r.code, reason: r.reason, refundTotal: Number(r.refund_total), items: r.items, createdAt: r.created_at })),
    history: history.rows.map((h) => ({ action: h.action, metadata: h.metadata, actorName: h.actor, createdAt: h.created_at })) };
}

async function lockOrder(c: PoolClient, businessId: string, id: string) {
  const { rows } = await c.query("SELECT * FROM orders WHERE id=$1 AND business_id=$2 FOR UPDATE", [id, businessId]);
  if (!rows[0]) throw notFound();
  return rows[0];
}

// Tells the buyer side (a business's purchasers, or an emailed customer) about an order event.
async function notifyBuyer(order: any, n: { type: string; title: string; body?: string; data?: object }, email?: { subject: string; text: string }) {
  if (order.buyer_business_id) await notifyMembersWith(order.buyer_business_id, "purchases.manage", n);
  else if (order.buyer_user_id) {
    await notify(order.buyer_user_id, n);
    if (email) { const { rows } = await pool.query("SELECT email FROM users WHERE id=$1", [order.buyer_user_id]); if (rows[0]?.email) await sendMail({ to: rows[0].email, ...email }); }
  } else if (order.customer_id && email) {
    const { rows } = await pool.query("SELECT email FROM customers WHERE id=$1", [order.customer_id]);
    if (rows[0]?.email) await sendMail({ to: rows[0].email, ...email });
  }
}

async function issueOtp(c: PoolClient, order: any, actorId: string) {
  await c.query("UPDATE order_otps SET invalidated_at=now() WHERE order_id=$1 AND used_at IS NULL AND invalidated_at IS NULL", [order.id]);
  const otp = String(crypto.randomInt(100000, 1000000));
  await c.query(`INSERT INTO order_otps (order_id, otp_hash, expires_at, max_attempts) VALUES ($1,$2, now() + ($3 || ' minutes')::interval, $4)`,
    [order.id, hashOtp(order.id, otp), String(OTP_TTL_MIN), OTP_MAX_ATTEMPTS]);
  await audit({ actorId, businessId: order.business_id, action: "order.otp_generated", entity: "order", entityId: order.id }, c);
  return otp;
}

// The OTP is only ever stored hashed; the plaintext lives in the buyer's notification/email until used or replaced.
async function deliverOtp(order: any, otp: string) {
  await scrubOtpNotifications(order.id);
  await notifyBuyer(order, { type: "order.otp", title: `Delivery code for ${order.order_number}`,
    body: `Give this code to the courier or collect with it: ${otp}. Valid for 24 hours.`, data: { orderId: order.id, otp: true } },
    { subject: `Your delivery code for ${order.order_number}`, text: `Your delivery/pickup code is ${otp}. Share it only with the person completing your delivery. It expires in 24 hours.` });
}
async function scrubOtpNotifications(orderId: string) {
  await pool.query(`UPDATE notifications SET body='Code no longer valid' WHERE type='order.otp' AND data->>'orderId'=$1`, [orderId]);
}

export async function transition(businessId: string, id: string, to: OrderStatus, actorId: string, ip?: string) {
  let otp: string | null = null; let order: any; let lows: MoveResult[] = [];
  await tx(async (c) => {
    order = await lockOrder(c, businessId, id);
    const from = order.status as OrderStatus;
    if (to === "returned") throw badRequest("Use the returns endpoint to record returns");
    if (!TRANSITIONS[from]?.includes(to)) throw conflict(`An order that is ${from} cannot become ${to}`);
    if (to === "delivered" && order.requires_otp) throw badRequest("Verify the delivery OTP to complete this order");

    if (to === "accepted") {
      // Commit stock now so accepted orders can never oversell; fails the whole transition if any line is short.
      const { rows: items } = await c.query("SELECT * FROM order_items WHERE order_id=$1 ORDER BY product_id", [id]);
      for (const it of items) {
        lows.push(await applyMovement(c, { businessId, productId: it.product_id, type: "sale", delta: -Number(it.quantity),
          refType: "order", refId: id, note: order.order_number, actorId }));
      }
      await c.query("UPDATE orders SET stock_committed=true WHERE id=$1", [id]);
      await issueInvoice(c, order, actorId);                         // numbered automatically (INV-000001)
    }
    if (to === "cancelled" && order.stock_committed) {
      const { rows: items } = await c.query("SELECT * FROM order_items WHERE order_id=$1 ORDER BY product_id", [id]);
      for (const it of items) {
        await applyMovement(c, { businessId, productId: it.product_id, type: "sale_cancel", delta: Number(it.quantity),
          refType: "order", refId: id, note: `Cancelled ${order.order_number}`, actorId });
      }
      await c.query("UPDATE orders SET stock_committed=false WHERE id=$1", [id]);
    }
    if (to === "cancelled") await voidInvoice(c, id, businessId, actorId);
    await c.query(
      `UPDATE orders SET status=$2, updated_at=now(),
         delivered_at = CASE WHEN $2='delivered' THEN now() ELSE delivered_at END,
         cancelled_at = CASE WHEN $2='cancelled' THEN now() ELSE cancelled_at END WHERE id=$1`, [id, to]);
    // Keep the buyer's purchase order in step with the supplier's order.
    if (order.purchase_id && (to === "accepted" || to === "cancelled")) {
      await c.query("UPDATE purchases SET status=$2, updated_at=now() WHERE id=$1 AND status IN ('sent','accepted')", [order.purchase_id, to]);
    }
    if (to === "dispatched" && order.requires_otp) otp = await issueOtp(c, order, actorId);
    await audit({ actorId, businessId, action: "order.status", entity: "order", entityId: id, metadata: { from, to }, ip }, c);
  });
  await flushLowStock(businessId, lows);
  if (otp) await deliverOtp(order, otp);
  await notifyBuyer(order, { type: "order.status", title: `Order ${order.order_number} is now ${to}`, data: { orderId: id, status: to, purchaseId: order.purchase_id } });
  return getOrder(businessId, id);
}

export async function regenerateOtp(businessId: string, id: string, actorId: string, ip?: string) {
  let otp = ""; let order: any;
  await tx(async (c) => {
    order = await lockOrder(c, businessId, id);
    if (!order.requires_otp || !["ready", "dispatched"].includes(order.status)) throw conflict("This order does not need an OTP right now");
    const { rows: last } = await c.query("SELECT created_at > now() - ($2 || ' seconds')::interval AS recent FROM order_otps WHERE order_id=$1 ORDER BY created_at DESC LIMIT 1",
      [id, String(OTP_REGEN_COOLDOWN_SEC)]);
    if (last[0]?.recent) throw new AppError(429, "TOO_SOON", "Please wait a moment before requesting another code");
    otp = await issueOtp(c, order, actorId);
  });
  await deliverOtp(order, otp);
}

export async function verifyOtp(businessId: string, id: string, code: string, actorId: string, ip?: string) {
  const outcome = await tx(async (c) => {
    const order = await lockOrder(c, businessId, id);
    if (!order.requires_otp) throw conflict("This order does not use an OTP");
    if (!["ready", "dispatched"].includes(order.status)) throw conflict(`An order that is ${order.status} cannot be delivered`);
    const { rows } = await c.query(
      "SELECT * FROM order_otps WHERE order_id=$1 AND used_at IS NULL AND invalidated_at IS NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE", [id]);
    const o = rows[0];
    if (!o) return { ok: false as const, err: new AppError(409, "OTP_MISSING", "No active code. Generate a new one.") };
    if (new Date(o.expires_at) < new Date()) {
      await c.query("UPDATE order_otps SET invalidated_at=now() WHERE id=$1", [o.id]);
      await audit({ actorId, businessId, action: "order.otp_expired", entity: "order", entityId: id, ip }, c);
      return { ok: false as const, err: new AppError(410, "OTP_EXPIRED", "This code has expired. Generate a new one.") };
    }
    if (o.attempts >= o.max_attempts) return { ok: false as const, err: new AppError(429, "OTP_LOCKED", "Too many wrong attempts. Generate a new code.") };
    const given = Buffer.from(hashOtp(id, code)); const real = Buffer.from(o.otp_hash);
    if (given.length !== real.length || !crypto.timingSafeEqual(given, real)) {
      await c.query("UPDATE order_otps SET attempts=attempts+1 WHERE id=$1", [o.id]);
      await audit({ actorId, businessId, action: "order.otp_failed", entity: "order", entityId: id, metadata: { attempt: o.attempts + 1 }, ip }, c);
      return { ok: false as const, err: new AppError(400, "OTP_INVALID", `Incorrect code (${o.max_attempts - o.attempts - 1} attempts left)`) };
    }
    await c.query("UPDATE order_otps SET used_at=now() WHERE id=$1", [o.id]);
    await c.query("UPDATE orders SET status='delivered', delivered_at=now(), updated_at=now() WHERE id=$1", [id]);
    await audit({ actorId, businessId, action: "order.otp_verified", entity: "order", entityId: id, metadata: { from: order.status, to: "delivered" }, ip }, c);
    return { ok: true as const, order };
  });
  // Failed attempts are committed above; only now do we surface the error.
  if (!outcome.ok) throw outcome.err;
  await scrubOtpNotifications(id);
  await notifyBuyer(outcome.order, { type: "order.status", title: `Order ${outcome.order.order_number} delivered`, data: { orderId: id, status: "delivered", purchaseId: outcome.order.purchase_id } });
  return getOrder(businessId, id);
}

export async function createReturn(businessId: string, id: string, actorId: string, i: { items: { orderItemId: string; quantity: number; condition: "resellable" | "damaged" }[]; reason?: string }, ip?: string) {
  await tx(async (c) => {
    const order = await lockOrder(c, businessId, id);
    if (order.status !== "delivered") throw conflict("Only delivered orders can be returned");
    const { rows: items } = await c.query("SELECT * FROM order_items WHERE order_id=$1 FOR UPDATE", [id]);
    const byId = new Map(items.map((r) => [r.id, r]));
    const seen = new Set<string>(); let refund = 0; const cnLines: { item: any; quantity: number; refundCents: number }[] = [];
    for (const l of i.items) {
      const it = byId.get(l.orderItemId);
      if (!it) throw badRequest("Unknown order item");
      if (seen.has(l.orderItemId)) throw badRequest("Each item may appear once per return");
      seen.add(l.orderItemId);
      if (l.quantity > Number(it.quantity) - Number(it.returned_qty) + 1e-9) throw conflict(`Cannot return more than was sold for "${it.name}"`);
      const lineRefund = Math.round((toCents(it.line_total) * l.quantity) / Number(it.quantity));
      refund += lineRefund; cnLines.push({ item: it, quantity: l.quantity, refundCents: lineRefund });
    }
    const { rows: ret } = await c.query("INSERT INTO order_returns (order_id, business_id, reason, refund_total, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id",
      [id, businessId, i.reason ?? null, fromCents(refund), actorId]);
    for (const l of i.items) {
      const it = byId.get(l.orderItemId)!;
      await c.query("INSERT INTO order_return_items (return_id, order_item_id, quantity, condition) VALUES ($1,$2,$3,$4)", [ret[0].id, l.orderItemId, l.quantity, l.condition]);
      await c.query("UPDATE order_items SET returned_qty = returned_qty + $2::numeric WHERE id=$1", [l.orderItemId, l.quantity]);
      if (l.condition === "resellable") {
        await applyMovement(c, { businessId, productId: it.product_id, type: "sale_return", delta: l.quantity, refType: "order", refId: id, note: `Return ${order.order_number}`, actorId });
      }
    }
    await issueCreditNote(c, order, ret[0].id, cnLines, i.reason ?? null, actorId);          // CN/26-27/000001 against the invoice
    const { rows: left } = await c.query("SELECT count(*)::int AS n FROM order_items WHERE order_id=$1 AND returned_qty < quantity", [id]);
    if (left[0].n === 0) await c.query("UPDATE orders SET status='returned', updated_at=now() WHERE id=$1", [id]);
    await audit({ actorId, businessId, action: "order.return", entity: "order", entityId: id, metadata: { refund: fromCents(refund), fully: left[0].n === 0 }, ip }, c);
    if (order.customer_id) await c.query("UPDATE customers SET last_interaction_at=now() WHERE id=$1", [order.customer_id]);
  });
  return getOrder(businessId, id);
}

export async function listReturns(businessId: string, limit: number, offset: number) {
  const { rows: t } = await pool.query("SELECT count(*)::int AS n FROM order_returns WHERE business_id=$1", [businessId]);
  const { rows } = await pool.query(
    `SELECT r.id, r.code, r.order_id, o.order_number, r.reason, r.refund_total, r.created_at FROM order_returns r JOIN orders o ON o.id=r.order_id
      WHERE r.business_id=$1 ORDER BY r.created_at DESC LIMIT $2 OFFSET $3`, [businessId, limit, offset]);
  return { returns: rows.map((r) => ({ id: r.id, code: r.code, orderId: r.order_id, orderNumber: r.order_number, reason: r.reason, refundTotal: Number(r.refund_total), createdAt: r.created_at })), total: t[0].n };
}
