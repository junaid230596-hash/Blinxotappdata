import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api as _api, pool, resetDb } from "./helpers.js";
import { addEmployee, addProduct, assertLedgerConsistent, otpFromNotifications, setup, stockOf } from "./factory.js";

const api = _api;
beforeAll(resetDb);
afterAll(() => pool.end());

let n = 0;
const mkSupplier = async (c: any, o: any = {}) =>
  (await api().post(`${c.base}/suppliers`).set(c.owner.auth).send({ name: `Supplier ${++n}`, ...o }).expect(201)).body.supplier;
const mkPO = async (c: any, supplierId: string, items: any[], o: any = {}) =>
  (await api().post(`${c.base}/purchases`).set(c.owner.auth).send({ supplierId, items, ...o }).expect(201)).body.purchase;
const po = (c: any, id: string, action: string, b: any = {}) => api().post(`${c.base}/purchases/${id}/${action}`).set(c.owner.auth).send(b);
const getPO = async (c: any, id: string) => (await api().get(`${c.base}/purchases/${id}`).set(c.owner.auth).expect(200)).body.purchase;

describe("purchasing with an external supplier", () => {
  it("runs draft → sent → accepted → partially received → received and updates inventory + cost", async () => {
    const c = await setup(); const p = await addProduct(c, { costPrice: 10, openingStock: 10 });
    const s = await mkSupplier(c);
    const d = await mkPO(c, s.id, [{ productId: p.id, quantity: 20, unitCost: 20 }], { notes: "Restock" });
    expect(d).toMatchObject({ status: "draft", total: 400, linkedSupplier: false, poNumber: expect.stringMatching(/^PO-\d{6}$/) });
    expect(d.items[0]).toMatchObject({ name: p.name, sku: p.sku, remainingQty: 20 });
    // draft edits
    const edited = (await api().patch(`${c.base}/purchases/${d.id}`).set(c.owner.auth).send({ items: [{ productId: p.id, quantity: 20, unitCost: 25 }] }).expect(200)).body.purchase;
    expect(edited.total).toBe(500);
    await po(c, d.id, "receive", { items: [{ itemId: d.items[0].id, quantity: 1 }] }).expect(409);   // can't receive a draft
    await po(c, d.id, "accept").expect(409);                                                      // must be sent first
    await po(c, d.id, "send").expect(200);
    await api().patch(`${c.base}/purchases/${d.id}`).set(c.owner.auth).send({ notes: "late edit" }).expect(409);  // locked once sent
    await po(c, d.id, "send").expect(409);
    await po(c, d.id, "receive", { items: [{ itemId: d.items[0].id, quantity: 1 }] }).expect(409);   // not accepted yet
    await po(c, d.id, "accept").expect(200);
    const itemId = edited.items[0].id;   // editing a draft replaces its lines, so ids change
    await po(c, d.id, "receive", { items: [{ itemId, quantity: 21 }] }).expect(409);                 // more than ordered
    const part = (await po(c, d.id, "receive", { items: [{ itemId, quantity: 8 }] }).expect(200)).body.purchase;
    expect(part.status).toBe("partially_received"); expect(part.items[0]).toMatchObject({ receivedQty: 8, remainingQty: 12 });
    expect(await stockOf(c, p.id)).toBe(18);
    // weighted average: (10*10 + 8*25) / 18 = 16.67
    expect((await api().get(`${c.base}/products/${p.id}`).set(c.owner.auth)).body.product.costPrice).toBe(16.67);
    await po(c, d.id, "cancel").expect(409);                                                      // stock already received
    await po(c, d.id, "receive", { items: [{ itemId, quantity: 12 }] }).expect(200);
    expect((await getPO(c, d.id)).status).toBe("received");
    expect(await stockOf(c, p.id)).toBe(30);
    await po(c, d.id, "receive", { items: [{ itemId, quantity: 1 }] }).expect(409);
    const mv = (await api().get(`${c.base}/inventory/movements?type=purchase_receipt`).set(c.owner.auth)).body.movements;
    expect(mv).toHaveLength(2); expect(mv[0]).toMatchObject({ refType: "purchase", note: d.poNumber, quantityDelta: 12 });
    await assertLedgerConsistent(c.id);
  });

  it("filters purchases, cancels before receipt, and requires a product mapping for free-text items", async () => {
    const c = await setup(); const p = await addProduct(c); const s = await mkSupplier(c);
    const a = await mkPO(c, s.id, [{ productId: p.id, quantity: 5 }]);
    const b = await mkPO(c, s.id, [{ name: "Loose goods", quantity: 3, unitCost: 7 }]);
    await po(c, b.id, "send").expect(200); await po(c, b.id, "accept").expect(200);
    const need = await po(c, b.id, "receive", { items: [{ itemId: b.items[0].id, quantity: 3 }] }).expect(400);
    expect(need.body.error.message).toMatch(/Choose which product/);
    await po(c, b.id, "receive", { items: [{ itemId: b.items[0].id, quantity: 3, productId: p.id }] }).expect(200);
    expect(await stockOf(c, p.id)).toBe(3);
    await po(c, a.id, "send").expect(200);
    expect((await po(c, a.id, "cancel").expect(200)).body.purchase.status).toBe("cancelled");
    await po(c, a.id, "cancel").expect(409);
    expect((await api().get(`${c.base}/purchases?status=received`).set(c.owner.auth)).body.purchases.map((x: any) => x.id)).toEqual([b.id]);
    expect((await api().get(`${c.base}/purchases?supplierId=${s.id}`).set(c.owner.auth)).body.total).toBe(2);
    expect((await api().get(`${c.base}/purchases?pending=true`).set(c.owner.auth)).body.total).toBe(0);
    expect((await api().get(`${c.base}/purchases?q=${a.poNumber}`).set(c.owner.auth)).body.purchases).toHaveLength(1);
    await api().post(`${c.base}/purchases`).set(c.owner.auth).send({ supplierId: s.id, items: [{ quantity: 1 }] }).expect(400);   // no name/product
    await api().post(`${c.base}/purchases`).set(c.owner.auth).send({ supplierId: s.id, items: [] }).expect(400);
    await api().post(`${c.base}/purchases`).set(c.owner.auth).send({ supplierId: s.id, items: [{ name: "x", quantity: 1, supplierProductId: p.id }] }).expect(400);
    await assertLedgerConsistent(c.id);
  });

  it("enforces permissions and tenant isolation on suppliers and purchases", async () => {
    const a = await setup(); const b = await setup(); const emp = await addEmployee(a);
    const s = await mkSupplier(a); const p = await addProduct(a); const d = await mkPO(a, s.id, [{ productId: p.id, quantity: 1 }]);
    await api().get(`${a.base}/purchases`).set(emp.auth).expect(403);
    await api().post(`${a.base}/suppliers`).set(emp.auth).send({ name: "x" }).expect(403);
    await api().get(`${b.base}/purchases/${d.id}`).set(b.owner.auth).expect(404);
    await api().post(`${b.base}/purchases/${d.id}/send`).set(b.owner.auth).expect(404);
    await api().get(`${b.base}/suppliers/${s.id}`).set(b.owner.auth).expect(404);
    await api().post(`${b.base}/purchases`).set(b.owner.auth).send({ supplierId: s.id, items: [{ name: "x", quantity: 1 }] }).expect(400);   // someone else's supplier
    await api().post(`${b.base}/purchases`).set(b.owner.auth).send({ supplierId: (await mkSupplier(b)).id, items: [{ productId: p.id, quantity: 1 }] }).expect(400); // someone else's product
    const upd = await api().patch(`${a.base}/suppliers/${s.id}`).set(a.owner.auth).send({ status: "inactive" }).expect(200);
    expect(upd.body.supplier.status).toBe("inactive");
    await api().post(`${a.base}/purchases`).set(a.owner.auth).send({ supplierId: s.id, items: [{ name: "x", quantity: 1 }] }).expect(400);   // inactive supplier
  });
});

describe("marketplace: buying from another business end to end", () => {
  async function world() {
    const seller = await setup("Seller Co"); const buyer = await setup("Buyer Co");
    const listed = await addProduct(seller, { name: "Wholesale Rice", sellingPrice: 50, taxRate: 10, costPrice: 30, openingStock: 10, isListed: true });
    const hidden = await addProduct(seller, { name: "Secret Stock", sellingPrice: 5, openingStock: 5 });   // not listed
    const sup = await mkSupplier(buyer, { name: "Seller Co", linkedBusinessId: seller.id });
    return { seller, buyer, listed, hidden, sup };
  }
  const order = async (w: any) => (await api().get(`${w.seller.base}/orders`).set(w.seller.owner.auth).expect(200)).body.orders[0];

  it("exposes only opt-in listings publicly, without cost or exact stock", async () => {
    const w = await world();
    const all = await api().get("/api/public/marketplace/products?q=rice").expect(200);
    expect(all.body.products).toHaveLength(1);
    const p = all.body.products[0];
    expect(p).toMatchObject({ name: "Wholesale Rice", price: 50, inStock: true, business: { name: "Seller Co" } });
    expect(p.costPrice).toBeUndefined(); expect(p.stockQty).toBeUndefined(); expect(p.cost_price).toBeUndefined();
    expect((await api().get("/api/public/marketplace/products?q=secret").expect(200)).body.total).toBe(0);
    expect((await api().get(`/api/public/marketplace/products/${w.hidden.id}`)).status).toBe(404);
    expect((await api().get(`/api/public/marketplace/products/${w.listed.id}`).expect(200)).body.product.id).toBe(w.listed.id);
    expect((await api().get(`/api/public/marketplace/products?minPrice=60`).expect(200)).body.total).toBe(0);
    expect((await api().get(`/api/public/marketplace/products?businessId=${w.seller.id}&sort=price`).expect(200)).body.total).toBe(1);
    const biz = (await api().get("/api/public/marketplace/businesses?q=seller").expect(200)).body.businesses;
    expect(biz[0]).toMatchObject({ name: "Seller Co", listedProducts: 1 });
    await api().patch(`${w.seller.base}`).set(w.seller.owner.auth).send({ isPublic: false }).expect(200);
    expect((await api().get("/api/public/marketplace/products?q=rice").expect(200)).body.total).toBe(0);   // hidden with the business
    await api().patch(`${w.seller.base}`).set(w.seller.owner.auth).send({ isPublic: true }).expect(200);
    await api().delete(`${w.seller.base}/products/${w.listed.id}`).set(w.seller.owner.auth).expect(200);
    expect((await api().get("/api/public/marketplace/products?q=rice").expect(200)).body.total).toBe(0);   // inactive products disappear
  });

  it("validates supplier links and shows only listed products to the buyer", async () => {
    const w = await world();
    const sp = (await api().get(`${w.buyer.base}/suppliers/${w.sup.id}/products`).set(w.buyer.owner.auth).expect(200)).body.products;
    expect(sp.map((x: any) => x.name)).toEqual(["Wholesale Rice"]); expect(sp[0].costPrice).toBeUndefined();
    await api().post(`${w.buyer.base}/suppliers`).set(w.buyer.owner.auth).send({ name: "dup", linkedBusinessId: w.seller.id }).expect(409);
    await api().post(`${w.buyer.base}/suppliers`).set(w.buyer.owner.auth).send({ name: "self", linkedBusinessId: w.buyer.id }).expect(400);
    await api().post(`${w.buyer.base}/suppliers`).set(w.buyer.owner.auth).send({ name: "ghost", linkedBusinessId: "00000000-0000-4000-8000-000000000000" }).expect(400);
    // items must reference the supplier's listed products, and the supplier sets the price
    await api().post(`${w.buyer.base}/purchases`).set(w.buyer.owner.auth).send({ supplierId: w.sup.id, items: [{ name: "x", quantity: 1 }] }).expect(400);
    await api().post(`${w.buyer.base}/purchases`).set(w.buyer.owner.auth).send({ supplierId: w.sup.id, items: [{ supplierProductId: w.hidden.id, quantity: 1 }] }).expect(400);
    const d = (await api().post(`${w.buyer.base}/purchases`).set(w.buyer.owner.auth).send({ supplierId: w.sup.id, items: [{ supplierProductId: w.listed.id, quantity: 2, unitCost: 1 }] }).expect(201)).body.purchase;
    expect(d.items[0]).toMatchObject({ unitCost: 50, name: "Wholesale Rice" });
  });

  it("flows PO → supplier order → accept → OTP delivery → receipt, keeping both inventories exact", async () => {
    const w = await world();
    const d = (await api().post(`${w.buyer.base}/purchases`).set(w.buyer.owner.auth).send({ supplierId: w.sup.id, items: [{ supplierProductId: w.listed.id, quantity: 4 }] }).expect(201)).body.purchase;
    const sent = (await po(w.buyer, d.id, "send").expect(200)).body.purchase;
    expect(sent).toMatchObject({ status: "sent", total: 220, linkedSupplier: true });            // 4 x 50 + 10% tax
    const o = await order(w);
    expect(o).toMatchObject({ status: "pending", buyerBusinessName: "Buyer Co", total: 220, purchaseId: d.id, requiresOtp: true });
    const notes = (await api().get("/api/notifications").set(w.seller.owner.auth)).body.notifications;
    expect(notes.some((x: any) => x.type === "order.new")).toBe(true);
    // each side sees only its own record
    await api().get(`${w.buyer.base}/orders/${o.id}`).set(w.buyer.owner.auth).expect(404);
    await api().get(`${w.seller.base}/purchases/${d.id}`).set(w.seller.owner.auth).expect(404);
    await po(w.buyer, d.id, "accept").expect(409);                                                   // supplier decides
    await po(w.buyer, d.id, "receive", { items: [{ itemId: d.items[0].id, quantity: 1 }] }).expect(409);

    const st = (status: string) => api().patch(`${w.seller.base}/orders/${o.id}/status`).set(w.seller.owner.auth).send({ status });
    await st("accepted").expect(200);
    expect((await getPO(w.buyer, d.id)).status).toBe("accepted");
    expect(await stockOf(w.seller, w.listed.id)).toBe(6);
    await po(w.buyer, d.id, "cancel").expect(409);                                                   // supplier already committed stock
    await st("processing").expect(200); await st("ready").expect(200); await st("dispatched").expect(200);
    expect((await getPO(w.buyer, d.id)).order).toMatchObject({ status: "dispatched" });
    await po(w.buyer, d.id, "receive", { items: [{ itemId: d.items[0].id, quantity: 4, productId: w.listed.id }] }).expect(409);   // not delivered yet

    const code = (await otpFromNotifications(w.buyer.owner.auth))!;
    expect(code).toMatch(/^\d{6}$/);
    expect(await otpFromNotifications(w.seller.owner.auth)).toBeNull();                              // the supplier never sees the code
    await api().post(`${w.seller.base}/orders/${o.id}/otp/verify`).set(w.seller.owner.auth).send({ otp: code === "000000" ? "111111" : "000000" }).expect(400);
    await api().post(`${w.seller.base}/orders/${o.id}/otp/verify`).set(w.seller.owner.auth).send({ otp: code }).expect(200);
    const after = (await api().get("/api/notifications?limit=100").set(w.buyer.owner.auth)).body.notifications.find((x: any) => x.type === "order.otp");
    expect(after.body).toBe("Code no longer valid");                                                 // plaintext code scrubbed once used
    expect((await getPO(w.buyer, d.id)).order.status).toBe("delivered");

    // buyer must map the supplier's product to one of their own products to receive stock
    const mine = await addProduct(w.buyer, { name: "Rice (our SKU)", openingStock: 0, costPrice: 0 });
    const itemId = d.items[0].id;
    await po(w.buyer, d.id, "receive", { items: [{ itemId, quantity: 4 }] }).expect(400);
    await po(w.buyer, d.id, "receive", { items: [{ itemId, quantity: 4, productId: w.listed.id }] }).expect(400);  // not their product
    const done = (await po(w.buyer, d.id, "receive", { items: [{ itemId, quantity: 4, productId: mine.id }] }).expect(200)).body.purchase;
    expect(done.status).toBe("received");
    expect(await stockOf(w.buyer, mine.id)).toBe(4);
    expect((await api().get(`${w.buyer.base}/products/${mine.id}`).set(w.buyer.owner.auth)).body.product.costPrice).toBe(50);
    expect(await stockOf(w.seller, w.listed.id)).toBe(6);
    await assertLedgerConsistent(w.seller.id); await assertLedgerConsistent(w.buyer.id);
  });

  it("lets the buyer withdraw while pending, but only the supplier can cancel afterwards (restoring their stock)", async () => {
    const w = await world();
    const mk = async (q: number) => (await api().post(`${w.buyer.base}/purchases`).set(w.buyer.owner.auth).send({ supplierId: w.sup.id, items: [{ supplierProductId: w.listed.id, quantity: q }] }).expect(201)).body.purchase;
    const a = await mk(2); await po(w.buyer, a.id, "send").expect(200);
    await po(w.buyer, a.id, "cancel").expect(200);
    expect((await order(w)).status).toBe("cancelled");
    expect(await stockOf(w.seller, w.listed.id)).toBe(10);

    const b = await mk(3); await po(w.buyer, b.id, "send").expect(200);
    const ob = (await api().get(`${w.seller.base}/orders?status=pending`).set(w.seller.owner.auth)).body.orders[0];
    await api().patch(`${w.seller.base}/orders/${ob.id}/status`).set(w.seller.owner.auth).send({ status: "accepted" }).expect(200);
    expect(await stockOf(w.seller, w.listed.id)).toBe(7);
    await api().patch(`${w.seller.base}/orders/${ob.id}/status`).set(w.seller.owner.auth).send({ status: "cancelled" }).expect(200);
    expect(await stockOf(w.seller, w.listed.id)).toBe(10);
    expect((await getPO(w.buyer, b.id)).status).toBe("cancelled");
    await assertLedgerConsistent(w.seller.id);
  });

  it("fails acceptance cleanly when the supplier lacks stock, and rejects sending unavailable items", async () => {
    const w = await world();
    const big = (await api().post(`${w.buyer.base}/purchases`).set(w.buyer.owner.auth).send({ supplierId: w.sup.id, items: [{ supplierProductId: w.listed.id, quantity: 11 }] }).expect(201)).body.purchase;
    await po(w.buyer, big.id, "send").expect(200);
    const o = await order(w);
    const r = await api().patch(`${w.seller.base}/orders/${o.id}/status`).set(w.seller.owner.auth).send({ status: "accepted" }).expect(409);
    expect(r.body.error.code).toBe("INSUFFICIENT_STOCK");
    expect((await getPO(w.buyer, big.id)).status).toBe("sent");
    const later = (await api().post(`${w.buyer.base}/purchases`).set(w.buyer.owner.auth).send({ supplierId: w.sup.id, items: [{ supplierProductId: w.listed.id, quantity: 1 }] }).expect(201)).body.purchase;
    await api().patch(`${w.seller.base}/products/${w.listed.id}`).set(w.seller.owner.auth).send({ isListed: false }).expect(200);
    await po(w.buyer, later.id, "send").expect(409);                                                 // delisted since drafting
    await assertLedgerConsistent(w.seller.id);
  });
});
