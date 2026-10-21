import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, pool, registerUser, resetDb } from "./helpers.js";
import { addProduct, assertLedgerConsistent, otpFromEmail, otpFromNotifications, setup, stockOf } from "./factory.js";

beforeAll(resetDb);
afterAll(() => pool.end());

async function shop(stock = 10) {
  const c = await setup(); const p = await addProduct(c, { sellingPrice: 200, taxRate: 18, openingStock: stock });
  await pool.query("UPDATE products SET is_listed=true WHERE id=$1", [p.id]);
  return { c, p };
}
const details = { deliveryAddress: "12 Lake Road, Udaipur 313001", phone: "+91 98290 12345" };
const place = (buyer: any, businessId: string, items: any[], extra: any = {}) =>
  api().post("/api/me/orders").set(buyer.auth).send({ businessId, items, ...details, ...extra });

describe("individual buying: placing orders", () => {
  it("lets an individual order listed products and prices them on the server", async () => {
    const { c, p } = await shop(); const buyer = await registerUser("individual");
    const r = await place(buyer, c.id, [{ productId: p.id, quantity: 2 }], { notes: "Ring the bell" }).expect(201);
    expect(r.body.order).toMatchObject({ status: "pending", subtotal: 400, taxTotal: 72, total: 472, canCancel: true, phone: details.phone, seller: { id: c.id } });
    expect(r.body.order.items).toHaveLength(1);
    expect(await stockOf(c, p.id)).toBe(10);                                   // nothing is reserved until the seller accepts

    const seller = (await api().get(`${c.base}/orders?source=marketplace`).set(c.owner.auth).expect(200)).body.orders;
    expect(seller).toHaveLength(1);
    expect(seller[0]).toMatchObject({ buyerType: "individual", buyerPhone: details.phone, deliveryAddress: details.deliveryAddress, buyerBusinessId: null });
    const names = (await api().get("/api/notifications?limit=50").set(c.owner.auth)).body.notifications.map((n: any) => n.type);
    expect(names).toContain("order.new");
  });

  it("rejects bad input, other account types, unlisted/private/out-of-stock cases, and client-chosen prices", async () => {
    const { c, p } = await shop(3); const buyer = await registerUser("individual");
    const item = [{ productId: p.id, quantity: 1 }];
    await api().post("/api/me/orders").send({ businessId: c.id, items: item, ...details }).expect(401);
    await place(c.owner, c.id, item).expect(403);                              // a business owner buys through purchasing
    await place(buyer, c.id, item, { deliveryAddress: "x" }).expect(400);
    await place(buyer, c.id, item, { phone: "abc" }).expect(400);
    await place(buyer, c.id, []).expect(400);
    await place(buyer, c.id, [{ productId: p.id, quantity: 0 }]).expect(400);
    await place(buyer, c.id, [{ productId: p.id, quantity: 1, unitPrice: 1 }]).expect(400);        // unknown field: price cannot be overridden
    await place(buyer, c.id, [{ productId: p.id, quantity: 4 }]).expect(409);                      // only 3 in stock
    await place(buyer, c.id, [{ productId: p.id, quantity: 2 }, { productId: p.id, quantity: 2 }]).expect(409);   // duplicates are merged before checking
    await pool.query("UPDATE products SET is_listed=false WHERE id=$1", [p.id]);
    await place(buyer, c.id, item).expect(400);
    await pool.query("UPDATE products SET is_listed=true WHERE id=$1", [p.id]);
    await api().patch(c.base).set(c.owner.auth).send({ isPublic: false }).expect(200);
    await place(buyer, c.id, item).expect(404);
    expect((await api().get(`${c.base}/orders`).set(c.owner.auth)).body.total).toBe(0);
  });

  it("will not let someone order a product through a different business's id", async () => {
    const a = await shop(); const b = await shop(); const buyer = await registerUser("individual");
    await place(buyer, a.c.id, [{ productId: b.p.id, quantity: 1 }]).expect(400);
  });
});

describe("individual buying: fulfilment, code and cancellation", () => {
  it("runs accept → dispatch → code → delivered, keeping stock consistent, and shows the buyer progress without the code leaking to the seller", async () => {
    const { c, p } = await shop(); const buyer = await registerUser("individual");
    const o = (await place(buyer, c.id, [{ productId: p.id, quantity: 3 }]).expect(201)).body.order;
    const st = (s: string) => api().patch(`${c.base}/orders/${o.id}/status`).set(c.owner.auth).send({ status: s });
    await st("accepted").expect(200); expect(await stockOf(c, p.id)).toBe(7);
    await api().post(`/api/me/orders/${o.id}/cancel`).set(buyer.auth).expect(409);               // too late to cancel here
    for (const s of ["processing", "ready", "dispatched"]) await st(s).expect(200);

    const code = (await otpFromNotifications(buyer.auth))!;
    expect(code).toMatch(/^\d{6}$/); expect(otpFromEmail(buyer.email)).toBe(code);
    const mid = (await api().get(`/api/me/orders/${o.id}`).set(buyer.auth).expect(200)).body.order;
    expect(mid).toMatchObject({ status: "dispatched", codeIssued: true }); expect(JSON.stringify(mid)).not.toContain(code);
    expect(mid.timeline.map((t: any) => t.status)).toEqual(["pending", "accepted", "processing", "ready", "dispatched"]);
    expect(JSON.stringify(await api().get(`${c.base}/orders/${o.id}`).set(c.owner.auth))).not.toContain(code);

    await api().post(`${c.base}/orders/${o.id}/otp/verify`).set(c.owner.auth).send({ otp: code === "000000" ? "111111" : "000000" }).expect(400);
    await api().post(`${c.base}/orders/${o.id}/otp/verify`).set(c.owner.auth).send({ otp: code }).expect(200);
    const done = (await api().get(`/api/me/orders/${o.id}`).set(buyer.auth)).body.order;
    expect(done).toMatchObject({ status: "delivered", codeIssued: false, canCancel: false });
    const mine = (await api().get("/api/me/orders").set(buyer.auth)).body; expect(mine.total).toBe(1);
    await assertLedgerConsistent(c.id);
  });

  it("lets the buyer cancel while pending; nothing changes in stock and the seller is told", async () => {
    const { c, p } = await shop(); const buyer = await registerUser("individual");
    const o = (await place(buyer, c.id, [{ productId: p.id, quantity: 1 }]).expect(201)).body.order;
    const r = await api().post(`/api/me/orders/${o.id}/cancel`).set(buyer.auth).expect(200);
    expect(r.body.order).toMatchObject({ status: "cancelled", canCancel: false });
    await api().post(`/api/me/orders/${o.id}/cancel`).set(buyer.auth).expect(409);
    expect(await stockOf(c, p.id)).toBe(10);
    await api().patch(`${c.base}/orders/${o.id}/status`).set(c.owner.auth).send({ status: "accepted" }).expect(409);   // seller cannot revive it
    const titles = (await api().get("/api/notifications?limit=50").set(c.owner.auth)).body.notifications.map((n: any) => n.title);
    expect(titles.some((t: string) => /cancelled order/.test(t))).toBe(true);
  });

  it("keeps each buyer's orders private", async () => {
    const { c, p } = await shop(); const a = await registerUser("individual"); const b = await registerUser("individual");
    const o = (await place(a, c.id, [{ productId: p.id, quantity: 1 }]).expect(201)).body.order;
    await api().get(`/api/me/orders/${o.id}`).set(b.auth).expect(404);
    await api().post(`/api/me/orders/${o.id}/cancel`).set(b.auth).expect(404);
    expect((await api().get("/api/me/orders").set(b.auth)).body.total).toBe(0);
    await api().get("/api/me/orders/not-a-uuid").set(a.auth).expect(400);
  });

  it("lets a buyer review a business only after a delivered order", async () => {
    const { c, p } = await shop(); const buyer = await registerUser("individual");
    const review = () => api().post("/api/reviews").set(buyer.auth).send({ subjectType: "business", subjectId: c.id, rating: 5, body: "Quick and honest" });
    await review().expect(403);
    const o = (await place(buyer, c.id, [{ productId: p.id, quantity: 1 }]).expect(201)).body.order;
    await review().expect(403);                                                // ordered, not yet received
    for (const s of ["accepted", "processing", "ready", "dispatched"]) await api().patch(`${c.base}/orders/${o.id}/status`).set(c.owner.auth).send({ status: s }).expect(200);
    await api().post(`${c.base}/orders/${o.id}/otp/verify`).set(c.owner.auth).send({ otp: (await otpFromNotifications(buyer.auth))! }).expect(200);
    await review().expect(201);
  });
});
