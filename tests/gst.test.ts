import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { amountInWords, gstinCheckChar, validGstin } from "../server/src/lib/gst.js";
import { api, pool, registerUser, resetDb } from "./helpers.js";
import { addProduct, setup } from "./factory.js";

beforeAll(resetDb);
afterAll(() => pool.end());

/** Builds a structurally valid GSTIN with the correct check character. */
const gstin = (state: string, pan: string) => { const f = `${state}${pan}1Z`; return f + gstinCheckChar(f); };
const RJ = gstin("08", "AABCU9603R"), MH = gstin("27", "AAPFU0939F"), KA = gstin("29", "AAACB1234C");
const fyShort = (d = new Date()) => { const ist = new Date(d.getTime() + 5.5 * 3600e3); const s = ist.getUTCMonth() + 1 >= 4 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1; return `${String(s % 100).padStart(2, "0")}-${String((s + 1) % 100).padStart(2, "0")}`; };
const post = (c: any, path: string, body: any) => api().post(`${c.base}${path}`).set(c.owner.auth).send(body);
const patch = (c: any, path: string, body: any) => api().patch(`${c.base}${path}`).set(c.owner.auth).send(body);
const walk = (c: any, id: string, to: string[]) => (async () => { for (const s of to) await patch(c, `/orders/${id}/status`, { status: s }).expect(200); })();
async function registered(gst = RJ) { const c = await setup(); await patch(c, "", { gstin: gst, legalName: "Registered Traders Pvt Ltd" }).expect(200); return c; }
async function invoiceOf(c: any, orderId: string) { return (await api().get(`${c.base}/invoices/by-order/${orderId}`).set(c.owner.auth).expect(200)).body.invoice; }

describe("GST helpers", () => {
  it("validates GSTINs: format, state code and check character", () => {
    expect(validGstin("27AAPFU0939F1ZV")).toBe(true);                     // widely published valid sample
    expect(validGstin(RJ)).toBe(true);
    expect(validGstin("27AAPFU0939F1ZX")).toBe(false);                    // wrong check character
    expect(validGstin("99AAPFU0939F1Z" + gstinCheckChar("99AAPFU0939F1Z"))).toBe(false);   // no such state
    expect(validGstin("27aapfu0939f1zv")).toBe(false); expect(validGstin("27AAPFU0939F1Z")).toBe(false); expect(validGstin("")).toBe(false);
  });
  it("writes amounts in words using lakh and crore", () => {
    expect(amountInWords(0)).toBe("Rupees Zero Only");
    expect(amountInWords(1)).toBe("Rupees One Only");
    expect(amountInWords(118.5)).toBe("Rupees One Hundred Eighteen and Fifty Paise Only");
    expect(amountInWords(100000)).toBe("Rupees One Lakh Only");
    expect(amountInWords(123456.07)).toBe("Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six and Seven Paise Only");
    expect(amountInWords(10000000)).toBe("Rupees One Crore Only");
    expect(amountInWords(3540)).toBe("Rupees Three Thousand Five Hundred Forty Only");
  });
});

describe("tax profile", () => {
  it("accepts a valid GSTIN (state derived from it), rejects bad ones, and can clear it", async () => {
    const c = await setup(); const emp = await (await import("./factory.js")).addEmployee(c);
    await patch(c, "", { gstin: "27AAPFU0939F1ZX" }).expect(400);
    await patch(c, "", { gstin: "not-a-gstin" }).expect(400);
    await patch(c, "", { stateCode: "99" }).expect(400);
    await api().patch(c.base).set(emp.auth).send({ gstin: RJ }).expect(403);
    const r = await patch(c, "", { gstin: RJ.toLowerCase(), legalName: "  Acme Pvt Ltd " }).expect(200);          // lower case accepted, stored upper case
    expect(r.body.business).toMatchObject({ gstin: RJ, stateCode: "08", legalName: "Acme Pvt Ltd" });
    await patch(c, "", { stateCode: "27" }).expect(400);                                                          // contradicts the GSTIN
    await patch(c, "", { gstin: RJ, stateCode: "27" }).expect(400);
    const cleared = await patch(c, "", { gstin: "" }).expect(200);
    expect(cleared.body.business.gstin).toBeNull();
    expect((await patch(c, "", { stateCode: "27" }).expect(200)).body.business.stateCode).toBe("27");              // allowed once there is no GSTIN to contradict
  });

  it("validates HSN/SAC codes on products and GSTIN on customers", async () => {
    const c = await setup();
    await post(c, "/products", { name: "Bad", hsnCode: "12" }).expect(400);
    await post(c, "/products", { name: "Bad2", hsnCode: "1234AB" }).expect(400);
    const p = (await post(c, "/products", { name: "Pot", hsnCode: "73239990" }).expect(201)).body.product;
    expect(p.hsnCode).toBe("73239990");
    expect((await patch(c, `/products/${p.id}`, { hsnCode: "" }).expect(200)).body.product.hsnCode).toBeNull();
    await post(c, "/customers", { name: "Bad GST", gstin: "27AAPFU0939F1ZX" }).expect(400);
    await post(c, "/customers", { name: "Mismatch", gstin: MH, stateCode: "08" }).expect(400);
    const cu = (await post(c, "/customers", { name: "B2B", gstin: MH }).expect(201)).body.customer;
    expect(cu).toMatchObject({ gstin: MH, stateCode: "27" });
  });
});

describe("GST on invoices", () => {
  async function saleTo(c: any, customerId: string | null, extra: any = {}, product: any = { sellingPrice: 1000, taxRate: 18, hsnCode: "73239990" }, qty = 3) {
    const p = await addProduct(c, { openingStock: 20, ...product });
    const o = (await post(c, "/orders", { customerId, items: [{ productId: p.id, quantity: qty }], ...extra }).expect(201)).body.order;
    return { p, o };
  }

  it("splits tax into CGST + SGST within the seller's state, with HSN summary and amount in words", async () => {
    const c = await registered(); const cu = (await post(c, "/customers", { name: "Local Buyer", gstin: gstin("08", "AAACL5555L") }).expect(201)).body.customer;
    const { o } = await saleTo(c, cu.id); await walk(c, o.id, ["accepted"]);
    const inv = await invoiceOf(c, o.id); const d = inv.details;
    expect(d.title).toBe("Tax Invoice"); expect(d.gst).toEqual({ registered: true, mode: "intra" });
    expect(d.seller).toMatchObject({ gstin: RJ, legalName: "Registered Traders Pvt Ltd", stateCode: "08", stateName: "Rajasthan" });
    expect(d.buyer).toMatchObject({ name: "Local Buyer", stateCode: "08" }); expect(d.placeOfSupply).toEqual({ code: "08", name: "Rajasthan" });
    expect(d).toMatchObject({ subtotal: 3000, cgstTotal: 270, sgstTotal: 270, igstTotal: 0, taxTotal: 540, total: 3540, amountInWords: "Rupees Three Thousand Five Hundred Forty Only" });
    expect(d.items[0]).toMatchObject({ hsn: "73239990", taxable: 3000, cgst: 270, sgst: 270, igst: 0, taxRate: 18 });
    expect(d.hsnSummary).toEqual([{ hsn: "73239990", taxRate: 18, taxable: 3000, cgst: 270, sgst: 270, igst: 0, tax: 540 }]);
    expect(inv.number).toMatch(new RegExp(`^INV/${fyShort()}/000001$`)); expect(inv.number.length).toBeLessThanOrEqual(16);
  });

  it("charges IGST when the buyer is in another state, and honours an explicit place of supply", async () => {
    const c = await registered(); const cu = (await post(c, "/customers", { name: "Mumbai Buyer", gstin: MH }).expect(201)).body.customer;
    const a = await saleTo(c, cu.id); await walk(c, a.o.id, ["accepted"]);
    expect((await invoiceOf(c, a.o.id)).details).toMatchObject({ gst: { mode: "inter" }, igstTotal: 540, cgstTotal: 0, sgstTotal: 0, placeOfSupply: { code: "27", name: "Maharashtra" } });
    const b = await saleTo(c, null, { placeOfSupply: "29" }); await walk(c, b.o.id, ["accepted"]);                 // walk-in sold for delivery to Karnataka
    expect((await invoiceOf(c, b.o.id)).details).toMatchObject({ gst: { mode: "inter" }, igstTotal: 540 });
    const d = await saleTo(c, null); await walk(c, d.o.id, ["accepted"]);
    expect((await invoiceOf(c, d.o.id)).details).toMatchObject({ gst: { mode: "intra" }, cgstTotal: 270 });          // default: the seller's own state
    await post(c, "/orders", { items: [{ productId: a.p.id, quantity: 1 }], placeOfSupply: "99" }).expect(400);
  });

  it("splits an odd paisa without losing any: CGST + SGST always equals the tax", async () => {
    const c = await registered(); const { o } = await saleTo(c, null, {}, { sellingPrice: 33.33, taxRate: 5 }, 1); await walk(c, o.id, ["accepted"]);
    const d = (await invoiceOf(c, o.id)).details;
    expect(d.taxTotal).toBe(1.67); expect(d.cgstTotal).toBe(0.83); expect(d.sgstTotal).toBe(0.84);
    expect(Math.round((d.cgstTotal + d.sgstTotal) * 100)).toBe(Math.round(d.taxTotal * 100)); expect(d.total).toBe(35);
  });

  it("an unregistered seller issues a plain invoice with no CGST/SGST/IGST split", async () => {
    const c = await setup(); const { o } = await saleTo(c, null); await walk(c, o.id, ["accepted"]);
    const d = (await invoiceOf(c, o.id)).details;
    expect(d.title).toBe("Invoice"); expect(d.gst).toEqual({ registered: false, mode: "none" });
    expect(d).toMatchObject({ taxTotal: 540, cgstTotal: 0, sgstTotal: 0, igstTotal: 0, total: 3540 });
    expect(d.seller.gstin).toBeNull();
  });

  it("keeps the issued tax details even if the seller changes their GSTIN later", async () => {
    const c = await registered(); const { o } = await saleTo(c, null); await walk(c, o.id, ["accepted"]);
    await patch(c, "", { gstin: "" }).expect(200);
    expect((await invoiceOf(c, o.id)).details.seller.gstin).toBe(RJ);
  });
});

describe("credit notes", () => {
  it("issues a numbered credit note for a return, matching the refund and splitting tax the same way", async () => {
    const c = await registered(); const p = await addProduct(c, { openingStock: 10, sellingPrice: 1000, taxRate: 18, hsnCode: "7323" });
    const o = (await post(c, "/orders", { items: [{ productId: p.id, quantity: 3 }] }).expect(201)).body.order;
    await walk(c, o.id, ["accepted", "processing", "ready", "delivered"]);
    const item = (await api().get(`${c.base}/orders/${o.id}`).set(c.owner.auth)).body.order.items[0];
    const r1 = (await post(c, `/orders/${o.id}/returns`, { reason: "Dented", items: [{ orderItemId: item.id, quantity: 1, condition: "damaged" }] }).expect(201)).body.order;
    const inv = await invoiceOf(c, o.id);
    expect(inv.creditNotes).toHaveLength(1);
    const cn = inv.creditNotes[0];
    expect(cn.number).toBe(`CN/${fyShort()}/000001`);
    expect(cn).toMatchObject({ subtotal: 1000, taxTotal: 180, total: 1180 });
    expect(cn.total).toBe(r1.returns[0].refundTotal);                                            // exactly what was refunded
    expect(cn.details).toMatchObject({ title: "Credit Note", reason: "Dented", cgstTotal: 90, sgstTotal: 90, igstTotal: 0, against: { number: inv.number } });
    expect(cn.details.items[0]).toMatchObject({ hsn: "7323", quantity: 1, taxable: 1000, cgst: 90, sgst: 90 });
    expect(cn.details.amountInWords).toBe("Rupees One Thousand One Hundred Eighty Only");

    await post(c, `/orders/${o.id}/returns`, { items: [{ orderItemId: item.id, quantity: 2, condition: "resellable" }] }).expect(201);
    const after = await invoiceOf(c, o.id);
    expect(after.creditNotes.map((x: any) => x.number)).toEqual([`CN/${fyShort()}/000001`, `CN/${fyShort()}/000002`]);
    expect(after.creditNotes[1].total).toBe(2360);
    expect(after.status).toBe("issued");                                                           // the original invoice stands; credit notes adjust it
    expect((await api().get(`${c.base}/invoices?q=${encodeURIComponent(inv.number)}`).set(c.owner.auth)).body.invoices[0].creditNoteCount).toBe(2);
  });

  it("credit notes for interstate sales carry IGST, and are private to the right business and buyer", async () => {
    const c = await registered(); const other = await setup(); const p = await addProduct(c, { openingStock: 5, sellingPrice: 500, taxRate: 12 });
    await pool.query("UPDATE products SET is_listed=true WHERE id=$1", [p.id]);
    const buyer = await registerUser("individual"); const stranger = await registerUser("individual");
    const o = (await api().post("/api/me/orders").set(buyer.auth).send({ businessId: c.id, items: [{ productId: p.id, quantity: 2 }], deliveryAddress: "9 MG Road, Bengaluru", phone: "+91 98450 11111", stateCode: "29" }).expect(201)).body.order;
    const sellerOrder = (await api().get(`${c.base}/orders?source=marketplace`).set(c.owner.auth)).body.orders[0];
    await walk(c, sellerOrder.id, ["accepted", "processing", "ready", "dispatched"]);
    const { otpFromNotifications } = await import("./factory.js");
    await api().post(`${c.base}/orders/${sellerOrder.id}/otp/verify`).set(c.owner.auth).send({ otp: (await otpFromNotifications(buyer.auth))! }).expect(200);
    const item = (await api().get(`${c.base}/orders/${sellerOrder.id}`).set(c.owner.auth)).body.order.items[0];
    await post(c, `/orders/${sellerOrder.id}/returns`, { items: [{ orderItemId: item.id, quantity: 1, condition: "resellable" }] }).expect(201);

    const mine = (await api().get(`/api/me/orders/${o.id}/invoice`).set(buyer.auth).expect(200)).body.invoice;
    expect(mine.details.gst.mode).toBe("inter"); expect(mine.details.placeOfSupply).toMatchObject({ code: "29", name: "Karnataka" });
    expect(mine.creditNotes).toHaveLength(1);
    expect(mine.creditNotes[0].details).toMatchObject({ igstTotal: 60, cgstTotal: 0, total: 560 });
    expect(JSON.stringify(mine)).not.toContain(buyer.email);
    await api().get(`/api/me/orders/${o.id}/invoice`).set(stranger.auth).expect(404);
    await api().get(`${c.base}/invoices/${mine.id}`).set(other.owner.auth).expect(404);
  });
});

describe("financial-year numbering", () => {
  it("restarts each April (IST), keeps numbers within 16 characters, and counts per business", async () => {
    const c = await registered(); const other = await registered(gstin("08", "AABCX1111X"));
    const mk = async (biz: any) => { const p = await addProduct(biz, { openingStock: 5 }); return (await post(biz, "/orders", { items: [{ productId: p.id, quantity: 1 }] }).expect(201)).body.order.id as string; };
    const issue = async (biz: any, at: string) => (await pool.query(
      `INSERT INTO invoices (business_id, order_id, subtotal, tax_total, total, snapshot, issued_at) VALUES ($1,$2,0,0,0,'{}',$3) RETURNING invoice_number`, [biz.id, await mk(biz), at])).rows[0].invoice_number as string;
    expect(await issue(c, "2026-03-30T10:00:00Z")).toBe("INV/25-26/000001");
    expect(await issue(c, "2026-03-31T20:00:00Z")).toBe("INV/26-27/000001");        // 01:30 IST on 1 April: new financial year
    expect(await issue(c, "2026-04-02T00:00:00Z")).toBe("INV/26-27/000002");
    expect(await issue(c, "2027-03-31T10:00:00Z")).toBe("INV/26-27/000003");        // last day of the year
    expect(await issue(c, "2027-03-31T19:00:00Z")).toBe("INV/27-28/000001");        // 00:30 IST on 1 April 2027
    expect(await issue(c, "2026-03-31T09:00:00Z")).toBe("INV/25-26/000002");        // an earlier year keeps its own sequence
    expect(await issue(other, "2026-04-05T00:00:00Z")).toBe("INV/26-27/000001");    // another business starts at 1
    expect("INV/26-27/000001".length).toBeLessThanOrEqual(16);
  });
});
