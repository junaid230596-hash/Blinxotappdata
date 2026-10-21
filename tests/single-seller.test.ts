import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, pool, registerUser, resetDb } from "./helpers.js";
import { addProduct, setup } from "./factory.js";

beforeAll(resetDb);
afterAll(() => pool.end());

// Rule: one order can hold many items, but every item must come from ONE business.
const listed = (c: any, o: any = {}) => addProduct(c, { openingStock: 20, sellingPrice: 100, taxRate: 10, isListed: true, ...o });

describe("business buyers: one purchase order, one supplier", () => {
  async function world() {
    const a = await setup("Supplier A"); const b = await setup("Supplier B"); const buyer = await setup("Buyer Co");
    const link = async (s: any) => (await api().post(`${buyer.base}/suppliers`).set(buyer.owner.auth).send({ name: s.name ?? "S", linkedBusinessId: s.id }).expect(201)).body.supplier;
    return { a, b, buyer, supA: await link(a), supB: await link(b), a1: await listed(a, { name: "A1" }), a2: await listed(a, { name: "A2" }), a3: await listed(a, { name: "A3", sellingPrice: 50 }), b1: await listed(b, { name: "B1" }) };
  }
  const po = (w: any, supplierId: string, items: any[]) => api().post(`${w.buyer.base}/purchases`).set(w.buyer.owner.auth).send({ supplierId, items });

  it("accepts many different items from the same supplier in one order", async () => {
    const w = await world();
    const r = await po(w, w.supA.id, [{ supplierProductId: w.a1.id, quantity: 2 }, { supplierProductId: w.a2.id, quantity: 1 }, { supplierProductId: w.a3.id, quantity: 4 }]).expect(201);
    expect(r.body.purchase.items).toHaveLength(3);
    expect(r.body.purchase.supplierName).toBeTruthy();
    const sent = (await api().post(`${w.buyer.base}/purchases/${r.body.purchase.id}/send`).set(w.buyer.owner.auth).expect(200)).body.purchase;
    const orders = (await api().get(`${w.a.base}/orders`).set(w.a.owner.auth)).body.orders;
    expect(orders).toHaveLength(1);                                                                         // ONE order at Supplier A with all three lines
    expect(sent.total).toBe(2 * 110 + 110 + 4 * 55);
    expect((await api().get(`${w.b.base}/orders`).set(w.b.owner.auth)).body.orders).toHaveLength(0);       // nothing reached Supplier B
  });

  it("refuses a product from a different supplier, when creating and when editing", async () => {
    const w = await world();
    await po(w, w.supA.id, [{ supplierProductId: w.a1.id, quantity: 1 }, { supplierProductId: w.b1.id, quantity: 1 }]).expect(400);       // B's product on an order to A
    const ok = (await po(w, w.supA.id, [{ supplierProductId: w.a1.id, quantity: 1 }]).expect(201)).body.purchase;
    await api().patch(`${w.buyer.base}/purchases/${ok.id}`).set(w.buyer.owner.auth).send({ items: [{ supplierProductId: w.a1.id, quantity: 1 }, { supplierProductId: w.b1.id, quantity: 1 }] }).expect(400);
    expect((await api().get(`${w.buyer.base}/purchases/${ok.id}`).set(w.buyer.owner.auth)).body.purchase.items).toHaveLength(1);              // unchanged
    await po(w, w.supA.id, [{ quantity: 1, name: "Free text", unitCost: 1 }]).expect(400);                                                  // a marketplace supplier needs its own products
    expect((await api().post(`${w.buyer.base}/purchases`).set(w.buyer.owner.auth).send({ supplierId: w.supA.id, items: [{ supplierProductId: w.a1.id, quantity: 1 }], extra: 1 })).status).toBeLessThan(500);
  });

  it("has no way to name two suppliers on one order", async () => {
    const w = await world();
    await api().post(`${w.buyer.base}/purchases`).set(w.buyer.owner.auth).send({ supplierId: [w.supA.id, w.supB.id], items: [{ supplierProductId: w.a1.id, quantity: 1 }] }).expect(400);
  });
});

describe("individual shoppers: one order, one business", () => {
  const place = (buyer: any, businessId: string, items: any[]) => api().post("/api/me/orders").set(buyer.auth).send({ businessId, items, deliveryAddress: "12 Lake Road, Udaipur", phone: "+91 98290 12345" });

  it("accepts many items from one business as a single order with one total", async () => {
    const s = await setup("One Shop"); const buyer = await registerUser("individual");
    const [p1, p2, p3] = [await listed(s, { sellingPrice: 100 }), await listed(s, { sellingPrice: 250 }), await listed(s, { sellingPrice: 40 })];
    const r = await place(buyer, s.id, [{ productId: p1.id, quantity: 2 }, { productId: p2.id, quantity: 1 }, { productId: p3.id, quantity: 5 }]).expect(201);
    expect(r.body.order.items).toHaveLength(3);
    expect(r.body.order.subtotal).toBe(200 + 250 + 200); expect(r.body.order.total).toBe(715);                                                                   // 650 + 10% tax
    expect((await api().get("/api/me/orders").set(buyer.auth)).body.total).toBe(1);
  });

  it("refuses items from two businesses in one order and creates nothing", async () => {
    const a = await setup("Shop A"); const b = await setup("Shop B"); const buyer = await registerUser("individual");
    const pa = await listed(a); const pb = await listed(b);
    await place(buyer, a.id, [{ productId: pa.id, quantity: 1 }, { productId: pb.id, quantity: 1 }]).expect(400);
    await place(buyer, b.id, [{ productId: pa.id, quantity: 1 }]).expect(400);
    expect((await api().get("/api/me/orders").set(buyer.auth)).body.total).toBe(0);
    expect((await api().get(`${a.base}/orders`).set(a.owner.auth)).body.total).toBe(0);
    expect((await api().get(`${b.base}/orders`).set(b.owner.auth)).body.total).toBe(0);
    await api().post("/api/me/orders").set(buyer.auth).send({ businessId: [a.id, b.id], items: [{ productId: pa.id, quantity: 1 }], deliveryAddress: "12 Lake Road, Udaipur", phone: "+91 98290 12345" }).expect(400);
  });

  it("buying from two shops means two separate orders, one per shop", async () => {
    const a = await setup("Split A"); const b = await setup("Split B"); const buyer = await registerUser("individual");
    const pa = await listed(a); const pb = await listed(b);
    await place(buyer, a.id, [{ productId: pa.id, quantity: 1 }]).expect(201); await place(buyer, b.id, [{ productId: pb.id, quantity: 1 }]).expect(201);
    const mine = (await api().get("/api/me/orders").set(buyer.auth)).body.orders;
    expect(mine).toHaveLength(2); expect(new Set(mine.map((o: any) => o.seller.id))).toEqual(new Set([a.id, b.id]));
    expect(new Set(mine.map((o: any) => o.id)).size).toBe(2);                                              // order numbers count per shop, so the pair (shop, number) identifies an order
  });
});
