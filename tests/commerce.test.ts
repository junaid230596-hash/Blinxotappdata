import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api as _api, pool, resetDb } from "./helpers.js";
import { addEmployee, addProduct, assertLedgerConsistent, otpFromEmail, otpFromNotifications, setup, stockOf } from "./factory.js";

const api = _api;
beforeAll(resetDb);
afterAll(() => pool.end());

let n = 0;
const mkCustomer = async (c: any, o: any = {}) =>
  (await api().post(`${c.base}/customers`).set(c.owner.auth).send({ name: `Cust ${++n}`, ...o }).expect(201)).body.customer;
const mkOrder = async (c: any, items: any[], o: any = {}) =>
  (await api().post(`${c.base}/orders`).set(c.owner.auth).send({ items, ...o }).expect(201)).body.order;
const setStatus = (c: any, id: string, status: string) => api().patch(`${c.base}/orders/${id}/status`).set(c.owner.auth).send({ status });
const walk = async (c: any, id: string, steps: string[]) => { for (const s of steps) await setStatus(c, id, s).expect(200); };

describe("orders: pricing, stock commitment and cancellation", () => {
  it("prices lines server-side with tax, rejects bad lines, and commits no stock until accepted", async () => {
    const c = await setup();
    const p = await addProduct(c, { sellingPrice: 100, taxRate: 18, openingStock: 10 });
    const cust = await mkCustomer(c);
    const o = await mkOrder(c, [{ productId: p.id, quantity: 2 }], { customerId: cust.id });
    expect(o).toMatchObject({ status: "pending", subtotal: 200, taxTotal: 36, total: 236, requiresOtp: false, orderNumber: expect.stringMatching(/^ORD-\d{6}$/) });
    expect(o.items[0]).toMatchObject({ unitPrice: 100, taxRate: 18, lineTotal: 236 });
    expect(await stockOf(c, p.id)).toBe(10);
    const o2 = await mkOrder(c, [{ productId: p.id, quantity: 1, unitPrice: 80 }]);   // owner may override price
    expect(o2.total).toBe(94.4); expect(o2.orderNumber).not.toBe(o.orderNumber);
    const foreign = await setup(); const fp = await addProduct(foreign);
    await api().post(`${c.base}/orders`).set(c.owner.auth).send({ items: [{ productId: fp.id, quantity: 1 }] }).expect(400);
    await api().post(`${c.base}/orders`).set(c.owner.auth).send({ items: [] }).expect(400);
    await api().post(`${c.base}/orders`).set(c.owner.auth).send({ items: [{ productId: p.id, quantity: 0 }] }).expect(400);
    await api().post(`${c.base}/orders`).set(c.owner.auth).send({ items: [{ productId: p.id, quantity: 1 }], customerId: (await mkCustomer(foreign)).id }).expect(400);
    await api().post(`${c.base}/orders`).set(c.owner.auth).send({ items: [{ productId: p.id, quantity: 1 }], customerId: cust.id, requireOtp: true }).expect(400); // no email
    await api().delete(`${c.base}/products/${p.id}`).set(c.owner.auth).expect(200);
    await api().post(`${c.base}/orders`).set(c.owner.auth).send({ items: [{ productId: p.id, quantity: 1 }] }).expect(400); // inactive
  });

  it("deducts stock on accept, restores it on cancel, and enforces valid transitions", async () => {
    const c = await setup(); const p = await addProduct(c, { openingStock: 10 });
    const o = await mkOrder(c, [{ productId: p.id, quantity: 4 }]);
    await setStatus(c, o.id, "dispatched").expect(409);                  // cannot skip steps
    await setStatus(c, o.id, "returned").expect(400);                    // returns have their own flow
    await setStatus(c, o.id, "accepted").expect(200);
    expect(await stockOf(c, p.id)).toBe(6);
    await setStatus(c, o.id, "accepted").expect(409);
    await walk(c, o.id, ["processing"]);
    await setStatus(c, o.id, "cancelled").expect(200);
    expect(await stockOf(c, p.id)).toBe(10);
    await setStatus(c, o.id, "accepted").expect(409);                    // cancelled is final
    const o2 = await mkOrder(c, [{ productId: p.id, quantity: 3 }]);
    await setStatus(c, o2.id, "cancelled").expect(200);                  // cancel while pending touches no stock
    expect(await stockOf(c, p.id)).toBe(10);
    const mv = (await api().get(`${c.base}/inventory/movements?productId=${p.id}`).set(c.owner.auth)).body.movements.map((m: any) => m.type);
    expect(mv).toEqual(["sale_cancel", "sale", "opening"]);
    const detail = (await api().get(`${c.base}/orders/${o.id}`).set(c.owner.auth)).body.order;
    expect(detail.history.map((h: any) => h.action)).toEqual(["order.create", "order.status", "order.status", "order.status"]);
    await assertLedgerConsistent(c.id);
  });

  it("accepts atomically: one short line fails the whole order and leaves all stock untouched", async () => {
    const c = await setup();
    const a = await addProduct(c, { openingStock: 10 }); const b = await addProduct(c, { openingStock: 1 });
    const o = await mkOrder(c, [{ productId: a.id, quantity: 5 }, { productId: b.id, quantity: 2 }]);
    const r = await setStatus(c, o.id, "accepted").expect(409);
    expect(r.body.error.code).toBe("INSUFFICIENT_STOCK");
    expect(await stockOf(c, a.id)).toBe(10); expect(await stockOf(c, b.id)).toBe(1);
    expect((await api().get(`${c.base}/orders/${o.id}`).set(c.owner.auth)).body.order.status).toBe("pending");
    await assertLedgerConsistent(c.id);
  });

  it("never oversells when orders are accepted concurrently", async () => {
    const c = await setup(); const p = await addProduct(c, { openingStock: 5 });
    const orders = await Promise.all(Array.from({ length: 4 }, () => mkOrder(c, [{ productId: p.id, quantity: 2 }])));
    const rs = await Promise.all(orders.map((o) => setStatus(c, o.id, "accepted")));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(2);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(2);
    expect(await stockOf(c, p.id)).toBe(1);
    await assertLedgerConsistent(c.id);
  });

  it("enforces permissions and tenant isolation", async () => {
    const a = await setup(); const b = await setup(); const emp = await addEmployee(a);
    const p = await addProduct(a, { openingStock: 3 }); const o = await mkOrder(a, [{ productId: p.id, quantity: 1 }]);
    await api().get(`${a.base}/orders`).set(emp.auth).expect(403);
    await api().post(`${a.base}/orders`).set(emp.auth).send({ items: [{ productId: p.id, quantity: 1 }] }).expect(403);
    await api().patch(`${a.base}/orders/${o.id}/status`).set(emp.auth).send({ status: "accepted" }).expect(403);
    await api().get(`${b.base}/orders/${o.id}`).set(b.owner.auth).expect(404);
    await api().patch(`${b.base}/orders/${o.id}/status`).set(b.owner.auth).send({ status: "accepted" }).expect(404);
    await api().post(`${b.base}/orders/${o.id}/returns`).set(b.owner.auth).send({ items: [{ orderItemId: o.items[0].id, quantity: 1, condition: "resellable" }] }).expect(404);
    expect((await api().get(`${a.base}/orders?status=pending`).set(a.owner.auth)).body.total).toBe(1);
    expect((await api().get(`${a.base}/orders?q=${o.orderNumber}`).set(a.owner.auth)).body.orders).toHaveLength(1);
  });
});

describe("delivery OTP", () => {
  async function dispatched() {
    const c = await setup(); const p = await addProduct(c, { openingStock: 10 });
    const email = `buyer${++n}_${Date.now()}@example.com`;
    const cust = await mkCustomer(c, { email });
    const o = await mkOrder(c, [{ productId: p.id, quantity: 2 }], { customerId: cust.id });
    expect(o.requiresOtp).toBe(true);
    await walk(c, o.id, ["accepted", "processing", "ready", "dispatched"]);
    return { c, o, email, p, verify: (otp: string) => api().post(`${c.base}/orders/${o.id}/otp/verify`).set(c.owner.auth).send({ otp }) };
  }

  it("emails the code, blocks manual delivery, stores only a hash, and completes delivery with the right code", async () => {
    const { c, o, email, verify } = await dispatched();
    const code = otpFromEmail(email)!;
    expect(code).toMatch(/^\d{6}$/);
    await setStatus(c, o.id, "delivered").expect(400);
    const { rows } = await pool.query("SELECT * FROM order_otps WHERE order_id=$1", [o.id]);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain(code);
    expect(rows[0].otp_hash).toMatch(/^[0-9a-f]{64}$/);
    await verify("12345").expect(400);                                   // malformed
    const bad = await verify(code === "111111" ? "222222" : "111111").expect(400);
    expect(bad.body.error.code).toBe("OTP_INVALID"); expect(bad.body.error.message).toMatch(/4 attempts left/);
    const ok = await verify(code).expect(200);
    expect(ok.body.order.status).toBe("delivered"); expect(ok.body.order.deliveredAt).not.toBeNull();
    await verify(code).expect(409);                                      // single use
    const h = (await api().get(`${c.base}/orders/${o.id}`).set(c.owner.auth)).body.order.history.map((x: any) => x.action);
    expect(h).toEqual(expect.arrayContaining(["order.otp_generated", "order.otp_failed", "order.otp_verified"]));
  });

  it("locks after 5 wrong attempts (even for the right code) until a new code is generated", async () => {
    const { c, o, email, verify } = await dispatched();
    const code = otpFromEmail(email)!; const wrong = code === "123456" ? "654321" : "123456";
    for (let i = 0; i < 5; i++) await verify(wrong).expect(400);
    expect((await verify(code).expect(429)).body.error.code).toBe("OTP_LOCKED");
    await api().post(`${c.base}/orders/${o.id}/otp/regenerate`).set(c.owner.auth).expect(429);   // cooldown
    await pool.query("UPDATE order_otps SET created_at = now() - interval '5 minutes' WHERE order_id=$1", [o.id]);
    await api().post(`${c.base}/orders/${o.id}/otp/regenerate`).set(c.owner.auth).expect(200);
    const fresh = otpFromEmail(email)!;
    await verify(code).expect(fresh === code ? 200 : 400);               // the old code is dead (unless the new one collided)
    const done = await api().get(`${c.base}/orders/${o.id}`).set(c.owner.auth);
    if (done.body.order.status !== "delivered") await verify(fresh).expect(200);
    expect((await api().get(`${c.base}/orders/${o.id}`).set(c.owner.auth)).body.order.status).toBe("delivered");
  });

  it("rejects expired codes", async () => {
    const { o, email, verify, c } = await dispatched();
    const code = otpFromEmail(email)!;
    await pool.query("UPDATE order_otps SET expires_at = now() - interval '1 minute' WHERE order_id=$1", [o.id]);
    expect((await verify(code).expect(410)).body.error.code).toBe("OTP_EXPIRED");
    await verify(code).expect(409);                                       // no active code remains
    await pool.query("UPDATE order_otps SET created_at = now() - interval '5 minutes' WHERE order_id=$1", [o.id]);
    await api().post(`${c.base}/orders/${o.id}/otp/regenerate`).set(c.owner.auth).expect(200);
    await verify(otpFromEmail(email)!).expect(200);
  });

  it("lets walk-in orders (no OTP) be delivered directly, and guards the OTP endpoints", async () => {
    const c = await setup(); const emp = await addEmployee(c); const p = await addProduct(c, { openingStock: 5 });
    const o = await mkOrder(c, [{ productId: p.id, quantity: 1 }]);
    expect(o.requiresOtp).toBe(false);
    await walk(c, o.id, ["accepted", "processing", "ready", "delivered"]);
    await api().post(`${c.base}/orders/${o.id}/otp/verify`).set(c.owner.auth).send({ otp: "123456" }).expect(409);
    await api().post(`${c.base}/orders/${o.id}/otp/verify`).set(emp.auth).send({ otp: "123456" }).expect(403);
    await api().post(`${c.base}/orders/${o.id}/otp/regenerate`).set(emp.auth).expect(403);
  });
});

describe("returns and customer spending", () => {
  it("restocks resellable items only, refunds proportionally, caps quantities, and closes the order when fully returned", async () => {
    const c = await setup(); const p = await addProduct(c, { sellingPrice: 100, taxRate: 10, openingStock: 10 });
    const cust = await mkCustomer(c);
    const o = await mkOrder(c, [{ productId: p.id, quantity: 4 }], { customerId: cust.id });   // total 440
    await api().post(`${c.base}/orders/${o.id}/returns`).set(c.owner.auth).send({ items: [{ orderItemId: o.items[0].id, quantity: 1, condition: "resellable" }] }).expect(409); // not delivered
    await walk(c, o.id, ["accepted", "processing", "ready", "delivered"]);
    expect(await stockOf(c, p.id)).toBe(6);
    expect((await api().get(`${c.base}/customers/${cust.id}`).set(c.owner.auth)).body.customer).toMatchObject({ totalSpent: 440, orderCount: 1 });
    const item = o.items[0].id;
    const r1 = await api().post(`${c.base}/orders/${o.id}/returns`).set(c.owner.auth).send({ items: [{ orderItemId: item, quantity: 1, condition: "resellable" }], reason: "Wrong size" }).expect(201);
    expect(r1.body.order).toMatchObject({ status: "delivered" }); expect(r1.body.order.returns[0].refundTotal).toBe(110);
    expect(await stockOf(c, p.id)).toBe(7);
    await api().post(`${c.base}/orders/${o.id}/returns`).set(c.owner.auth).send({ items: [{ orderItemId: item, quantity: 1, condition: "damaged" }] }).expect(201);
    expect(await stockOf(c, p.id)).toBe(7);                                // damaged: no restock
    await api().post(`${c.base}/orders/${o.id}/returns`).set(c.owner.auth).send({ items: [{ orderItemId: item, quantity: 3, condition: "resellable" }] }).expect(409); // only 2 left
    await api().post(`${c.base}/orders/${o.id}/returns`).set(c.owner.auth).send({ items: [{ orderItemId: "00000000-0000-4000-8000-000000000000", quantity: 1, condition: "resellable" }] }).expect(400);
    expect((await api().get(`${c.base}/customers/${cust.id}`).set(c.owner.auth)).body.customer.totalSpent).toBe(220);
    const last = await api().post(`${c.base}/orders/${o.id}/returns`).set(c.owner.auth).send({ items: [{ orderItemId: item, quantity: 2, condition: "resellable" }] }).expect(201);
    expect(last.body.order.status).toBe("returned");
    expect(await stockOf(c, p.id)).toBe(9);
    expect((await api().get(`${c.base}/customers/${cust.id}`).set(c.owner.auth)).body.customer.totalSpent).toBe(0);
    expect((await api().get(`${c.base}/returns`).set(c.owner.auth)).body.total).toBe(3);
    await assertLedgerConsistent(c.id);
  });
});

describe("customers", () => {
  it("manages customers with search, sorting, history, and tenant isolation", async () => {
    const c = await setup(); const other = await setup(); const emp = await addEmployee(c);
    const a = await mkCustomer(c, { name: "Alpha Traders", email: "a@x.com", phone: "999" });
    const b = await mkCustomer(c, { name: "Beta Stores" });
    const p = await addProduct(c, { sellingPrice: 50, openingStock: 20 });
    const o = await mkOrder(c, [{ productId: p.id, quantity: 2 }], { customerId: b.id });
    await walk(c, o.id, ["accepted", "processing", "ready", "delivered"]);
    const byName = (await api().get(`${c.base}/customers`).set(c.owner.auth)).body.customers.map((x: any) => x.name);
    expect(byName).toEqual(["Alpha Traders", "Beta Stores"]);
    expect((await api().get(`${c.base}/customers?sort=spent&dir=desc`).set(c.owner.auth)).body.customers[0].name).toBe("Beta Stores");
    expect((await api().get(`${c.base}/customers?q=999`).set(c.owner.auth)).body.customers.map((x: any) => x.name)).toEqual(["Alpha Traders"]);
    expect((await api().get(`${c.base}/customers/${a.id}`).set(c.owner.auth)).body.customer.lastInteraction).toBeNull();
    const logged = await api().post(`${c.base}/customers/${a.id}/communications`).set(c.owner.auth).send({ type: "call", summary: "Discussed bulk pricing" }).expect(201);
    expect(logged.body.customer.communications[0]).toMatchObject({ type: "call", summary: "Discussed bulk pricing", authorName: "Test User" });
    expect(logged.body.customer.lastInteraction).not.toBeNull();
    const detail = (await api().get(`${c.base}/customers/${b.id}`).set(c.owner.auth)).body.customer;
    expect(detail.orders[0]).toMatchObject({ orderNumber: o.orderNumber, status: "delivered", total: 100 });
    await api().patch(`${c.base}/customers/${a.id}`).set(c.owner.auth).send({ status: "inactive", notes: "Paused" }).expect(200);
    expect((await api().get(`${c.base}/customers?status=inactive`).set(c.owner.auth)).body.total).toBe(1);
    await api().get(`${other.base}/customers/${a.id}`).set(other.owner.auth).expect(404);
    await api().patch(`${other.base}/customers/${a.id}`).set(other.owner.auth).send({ name: "x" }).expect(404);
    await api().post(`${other.base}/customers/${a.id}/communications`).set(other.owner.auth).send({ type: "note", summary: "x" }).expect(404);
    await api().get(`${c.base}/customers`).set(emp.auth).expect(403);
    await api().post(`${c.base}/customers`).set(c.owner.auth).send({ name: "" }).expect(400);
    await api().post(`${c.base}/customers`).set(c.owner.auth).send({ name: "Bad", email: "nope" }).expect(400);
  });
});
