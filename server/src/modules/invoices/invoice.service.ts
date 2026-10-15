import type { PoolClient } from "pg";
import { pool } from "../../db.js";
import { amountInWords, splitTax, stateName } from "../../lib/gst.js";
import { notFound } from "../../lib/errors.js";
import { fromCents, toCents } from "../../lib/money.js";
import { escapeLike } from "../../lib/sql.js";
import { audit } from "../audit/audit.service.js";

// An invoice is issued automatically when a seller accepts an order and is voided (never deleted or renumbered) if the
// order is cancelled. Numbers are INV/26-27/000001 (per business, restarting each April). Goods returned after delivery
// produce a credit note (CN/26-27/000001) referencing the invoice. The snapshot freezes what was issued.

interface Line { name: string; sku: string | null; hsn: string | null; quantity: number; unitPrice: number; taxRate: number; taxableCents: number; taxCents: number }
type Mode = "intra" | "inter" | "none";

/** Splits each line's tax and totals it. Registered seller: CGST+SGST within the seller's state, IGST across states. Unregistered: plain tax. */
function gstBreakdown(mode: Mode, lines: Line[]) {
  const items = lines.map((l) => {
    const s = splitTax(l.taxCents, mode);
    return { name: l.name, sku: l.sku, hsn: l.hsn, quantity: l.quantity, unitPrice: l.unitPrice, taxRate: l.taxRate,
      taxable: fromCents(l.taxableCents), cgst: fromCents(s.cgst), sgst: fromCents(s.sgst), igst: fromCents(s.igst), lineTax: fromCents(l.taxCents),
      lineTotal: fromCents(l.taxableCents + l.taxCents), lineSubtotal: fromCents(l.taxableCents) };
  });
  const sum = (f: (i: (typeof items)[number]) => number) => items.reduce((a, i) => a + toCents(f(i)), 0);
  const groups = new Map<string, { hsn: string; taxRate: number; taxable: number; cgst: number; sgst: number; igst: number; tax: number }>();
  for (const i of items) {
    const k = `${i.hsn ?? ""}|${i.taxRate}`; const g = groups.get(k) ?? { hsn: i.hsn ?? "—", taxRate: i.taxRate, taxable: 0, cgst: 0, sgst: 0, igst: 0, tax: 0 };
    g.taxable += toCents(i.taxable); g.cgst += toCents(i.cgst); g.sgst += toCents(i.sgst); g.igst += toCents(i.igst); g.tax += toCents(i.lineTax); groups.set(k, g);
  }
  const taxable = sum((i) => i.taxable), tax = sum((i) => i.lineTax);
  return {
    items, subtotal: fromCents(taxable), cgstTotal: fromCents(sum((i) => i.cgst)), sgstTotal: fromCents(sum((i) => i.sgst)), igstTotal: fromCents(sum((i) => i.igst)),
    taxTotal: fromCents(tax), total: fromCents(taxable + tax), amountInWords: amountInWords(fromCents(taxable + tax)),
    hsnSummary: [...groups.values()].map((g) => ({ ...g, taxable: fromCents(g.taxable), cgst: fromCents(g.cgst), sgst: fromCents(g.sgst), igst: fromCents(g.igst), tax: fromCents(g.tax) })),
  };
}

async function parties(c: PoolClient, order: any) {
  const { rows: sr } = await c.query("SELECT name, legal_name, address, phone, email, website, gstin, state_code FROM businesses WHERE id=$1", [order.business_id]);
  const s = sr[0];
  const seller = { name: s.name, legalName: s.legal_name, address: s.address, phone: s.phone, email: s.email, website: s.website, gstin: s.gstin, stateCode: s.state_code, stateName: stateName(s.state_code) };
  let buyer: Record<string, string | null> = { type: "walk-in", name: "Walk-in customer", address: null, phone: null, gstin: null, stateCode: null };
  if (order.customer_id) {
    const r = (await c.query("SELECT name, address, phone, gstin, state_code FROM customers WHERE id=$1", [order.customer_id])).rows[0];
    if (r) buyer = { type: "customer", name: r.name, address: r.address, phone: r.phone, gstin: r.gstin, stateCode: r.state_code };
  } else if (order.buyer_business_id) {
    const r = (await c.query("SELECT COALESCE(legal_name, name) AS name, address, phone, gstin, state_code FROM businesses WHERE id=$1", [order.buyer_business_id])).rows[0];
    if (r) buyer = { type: "business", name: r.name, address: r.address, phone: r.phone, gstin: r.gstin, stateCode: r.state_code };
  } else if (order.buyer_user_id) {
    const r = (await c.query("SELECT full_name FROM users WHERE id=$1", [order.buyer_user_id])).rows[0];
    buyer = { type: "individual", name: r?.full_name ?? "Customer", address: null, phone: order.buyer_phone, gstin: null, stateCode: order.place_of_supply };
  }
  const pos = order.place_of_supply ?? s.state_code ?? null;
  const mode: Mode = s.gstin ? (s.state_code && pos && s.state_code !== pos ? "inter" : "intra") : "none";
  return { seller, buyer: { ...buyer, stateName: stateName(buyer.stateCode) }, placeOfSupply: pos ? { code: pos, name: stateName(pos) } : null, mode, registered: !!s.gstin };
}

async function buildSnapshot(c: PoolClient, order: any) {
  const [p, { rows: items }] = await Promise.all([
    parties(c, order),
    c.query("SELECT name, sku, hsn_code, quantity, unit_price, tax_rate, line_subtotal, line_tax FROM order_items WHERE order_id=$1 ORDER BY name", [order.id]),
  ]);
  const g = gstBreakdown(p.mode, items.map((i) => ({ name: i.name, sku: i.sku, hsn: i.hsn_code, quantity: Number(i.quantity), unitPrice: Number(i.unit_price), taxRate: Number(i.tax_rate),
    taxableCents: toCents(i.line_subtotal), taxCents: toCents(i.line_tax) })));
  return { title: p.registered ? "Tax Invoice" : "Invoice", orderNumber: order.order_number, currency: "INR", seller: p.seller, buyer: p.buyer, deliveryAddress: order.delivery_address,
    placeOfSupply: p.placeOfSupply, gst: { registered: p.registered, mode: p.mode }, ...g };
}

/** Called inside the order-accept transaction. Idempotent per order. */
export async function issueInvoice(c: PoolClient, order: any, actorId: string | null) {
  const { rows: ex } = await c.query("SELECT id FROM invoices WHERE order_id=$1", [order.id]);
  if (ex[0]) return ex[0].id as string;
  const snap = await buildSnapshot(c, order);
  const { rows } = await c.query(
    `INSERT INTO invoices (business_id, order_id, subtotal, tax_total, total, snapshot) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, invoice_number`,
    [order.business_id, order.id, order.subtotal, order.tax_total, order.total, JSON.stringify(snap)]);
  await audit({ actorId, businessId: order.business_id, action: "invoice.issue", entity: "invoice", entityId: rows[0].id, metadata: { number: rows[0].invoice_number, order: order.order_number } }, c);
  return rows[0].id as string;
}

export async function voidInvoice(c: PoolClient, orderId: string, businessId: string, actorId: string | null) {
  const { rows } = await c.query("UPDATE invoices SET status='void', voided_at=now() WHERE order_id=$1 AND status='issued' RETURNING id, invoice_number", [orderId]);
  if (rows[0]) await audit({ actorId, businessId, action: "invoice.void", entity: "invoice", entityId: rows[0].id, metadata: { number: rows[0].invoice_number } }, c);
}

/** Credit note for goods returned against an invoiced order. `lines` carry the order_items row, quantity returned and the refunded amount in paise. */
export async function issueCreditNote(c: PoolClient, order: any, returnId: string, lines: { item: any; quantity: number; refundCents: number }[], reason: string | null, actorId: string | null) {
  const { rows: inv } = await c.query("SELECT id, invoice_number, issued_at, status FROM invoices WHERE order_id=$1", [order.id]);
  if (!inv[0] || inv[0].status !== "issued") return null;                  // orders accepted before invoicing existed have no invoice to credit
  const p = await parties(c, order);
  const g = gstBreakdown(p.mode, lines.map(({ item, quantity, refundCents }) => {
    const tax = Math.round((toCents(item.line_tax) * quantity) / Number(item.quantity));
    return { name: item.name, sku: item.sku, hsn: item.hsn_code, quantity, unitPrice: Number(item.unit_price), taxRate: Number(item.tax_rate), taxCents: tax, taxableCents: refundCents - tax };
  }));
  const snap = { title: "Credit Note", currency: "INR", orderNumber: order.order_number, reason, against: { number: inv[0].invoice_number, issuedAt: inv[0].issued_at },
    seller: p.seller, buyer: p.buyer, placeOfSupply: p.placeOfSupply, gst: { registered: p.registered, mode: p.mode }, ...g };
  const { rows } = await c.query(
    "INSERT INTO credit_notes (business_id, invoice_id, return_id, subtotal, tax_total, total, snapshot) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, note_number",
    [order.business_id, inv[0].id, returnId, g.subtotal, g.taxTotal, g.total, JSON.stringify(snap)]);
  await audit({ actorId, businessId: order.business_id, action: "credit_note.issue", entity: "credit_note", entityId: rows[0].id, metadata: { number: rows[0].note_number, invoice: inv[0].invoice_number, total: g.total } }, c);
  return rows[0].id as string;
}

const pubCredit = (r: any) => ({ id: r.id, number: r.note_number, issuedAt: r.issued_at, subtotal: Number(r.subtotal), taxTotal: Number(r.tax_total), total: Number(r.total), details: r.snapshot });
async function creditNotesFor(invoiceId: string) {
  const { rows } = await pool.query("SELECT * FROM credit_notes WHERE invoice_id=$1 ORDER BY issued_at, id", [invoiceId]);
  return rows.map(pubCredit);
}

export const pubInvoice = (r: any, full = true, creditNotes: any[] = []) => ({
  id: r.id, number: r.invoice_number, status: r.status, orderId: r.order_id, orderNumber: r.order_number ?? r.snapshot?.orderNumber,
  issuedAt: r.issued_at, voidedAt: r.voided_at, subtotal: Number(r.subtotal), taxTotal: Number(r.tax_total), total: Number(r.total),
  buyerName: r.snapshot?.buyer?.name ?? null, creditNoteCount: Number(r.credit_note_count ?? creditNotes.length),
  ...(full ? { details: r.snapshot, creditNotes } : {}),
});

export async function listInvoices(businessId: string, f: { q?: string; status?: string; limit: number; offset: number }) {
  const where = ["i.business_id=$1"]; const v: any[] = [businessId];
  if (f.status) { v.push(f.status); where.push(`i.status=$${v.length}`); }
  if (f.q) { v.push(`%${escapeLike(f.q)}%`); where.push(`(i.invoice_number ILIKE $${v.length} OR o.order_number ILIKE $${v.length} OR i.snapshot->'buyer'->>'name' ILIKE $${v.length})`); }
  const w = where.join(" AND ");
  const base = `FROM invoices i JOIN orders o ON o.id=i.order_id WHERE ${w}`;
  const { rows: t } = await pool.query(`SELECT count(*)::int AS n ${base}`, v);
  v.push(f.limit, f.offset);
  const { rows } = await pool.query(`SELECT i.*, o.order_number, (SELECT count(*) FROM credit_notes cn WHERE cn.invoice_id=i.id) AS credit_note_count ${base} ORDER BY i.issued_at DESC, i.id LIMIT $${v.length - 1} OFFSET $${v.length}`, v);
  return { invoices: rows.map((r) => pubInvoice(r, false)), total: t[0].n };
}

async function one(where: string, params: any[], missing: string) {
  const { rows } = await pool.query(`SELECT i.*, o.order_number FROM invoices i JOIN orders o ON o.id=i.order_id WHERE ${where}`, params);
  if (!rows[0]) throw notFound(missing);
  return pubInvoice(rows[0], true, await creditNotesFor(rows[0].id));
}
export const getInvoice = (businessId: string, id: string) => one("i.id=$1 AND i.business_id=$2", [id, businessId], "Invoice not found");
export const getInvoiceByOrder = (businessId: string, orderId: string) => one("i.order_id=$1 AND i.business_id=$2", [orderId, businessId], "This order has no invoice yet. One is issued when the order is accepted.");
/** The individual buyer's own copy (only for orders they placed). */
export const getInvoiceForBuyer = (userId: string, orderId: string) => one("i.order_id=$1 AND o.buyer_user_id=$2", [orderId, userId], "No invoice yet. One is issued when the seller accepts your order.");
export async function invoiceBrief(orderId: string) {
  const { rows } = await pool.query("SELECT id, invoice_number, status FROM invoices WHERE order_id=$1", [orderId]);
  return rows[0] ? { id: rows[0].id as string, number: rows[0].invoice_number as string, status: rows[0].status as string } : null;
}
