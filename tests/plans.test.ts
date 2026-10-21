import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api as _api, pool, registerUser, resetDb } from "./helpers.js";
import { addEmployee, addProduct, ensureTinyPlan, makeAdmin, putOnPlan, setup } from "./factory.js";

const api = _api;
beforeAll(async () => { await resetDb(); await ensureTinyPlan(); });
afterAll(() => pool.end());

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

describe("plans and subscriptions", () => {
  it("lists public plans and starts every business on Free with visible usage", async () => {
    const plans = (await api().get("/api/plans").expect(200)).body.plans;
    expect(plans.map((p: any) => p.key)).toEqual(["free", "starter", "pro", "enterprise"]);       // 'tiny' is not public
    expect(plans[0]).toMatchObject({ name: "Free", priceMonthly: 0, limits: { members: 5, products: 50 } });
    expect(plans[3].limits).toEqual({});                                                          // enterprise is unlimited
    const c = await setup(); await addProduct(c);
    const sub = (await api().get(`${c.base}/subscription`).set(c.owner.auth).expect(200)).body.subscription;
    expect(sub.plan.key).toBe("free"); expect(sub.status).toBe("active");
    expect(sub.usage).toMatchObject({ members: 1, products: 1, ordersPerMonth: 0, businesses: 1 });
    const emp = await addEmployee(c);
    expect((await api().get(`${c.base}/subscription`).set(emp.auth).expect(200)).body.subscription.plan.key).toBe("free");   // any member may see it
    await api().get(`${c.base}/subscription`).set((await setup()).owner.auth).expect(404);
  });

  it("enforces member, product and order limits with a clear PLAN_LIMIT error", async () => {
    const c = await setup(); await putOnPlan(c, "tiny");
    await addEmployee(c);                                                                         // owner + 1 = 2 members (the limit)
    const blocked = await api().post(`${c.base}/employees`).set(c.owner.auth).send({ email: `x${Date.now()}@example.com`, fullName: "One too many" }).expect(403);
    expect(blocked.body.error).toMatchObject({ code: "PLAN_LIMIT", details: { resource: "members", limit: 2, current: 2, plan: "tiny" } });
    expect(blocked.body.error.message).toMatch(/Tiny plan allows 2 team members/);

    const p1 = await addProduct(c, { openingStock: 10 }); await addProduct(c);
    await api().post(`${c.base}/products`).set(c.owner.auth).send({ name: "Third", sku: "T3" }).expect(403);
    await api().delete(`${c.base}/products/${p1.id}`).set(c.owner.auth).expect(200);
    await api().post(`${c.base}/products`).set(c.owner.auth).send({ name: "Third", sku: "T3" }).expect(403);   // deactivated products still count

    const mk = () => api().post(`${c.base}/orders`).set(c.owner.auth).send({ items: [{ productId: (p1 as any).id, quantity: 1 }] });
    await api().patch(`${c.base}/products/${p1.id}`).set(c.owner.auth).send({ status: "active" }).expect(200);
    await mk().expect(201); await mk().expect(201);
    expect((await mk().expect(403)).body.error.details).toMatchObject({ resource: "ordersPerMonth", limit: 2 });
    await putOnPlan(c, "starter");
    await mk().expect(201);                                                                       // upgrading lifts the limit immediately
  });

  it("never blocks incoming marketplace orders because of the seller's own limit", async () => {
    const seller = await setup(); const buyer = await setup(); await putOnPlan(seller, "tiny");
    const prod = await addProduct(seller, { sellingPrice: 10, openingStock: 50, isListed: true });
    await api().post(`${seller.base}/orders`).set(seller.owner.auth).send({ items: [{ productId: prod.id, quantity: 1 }] }).expect(201);
    await api().post(`${seller.base}/orders`).set(seller.owner.auth).send({ items: [{ productId: prod.id, quantity: 1 }] }).expect(201);
    await api().post(`${seller.base}/orders`).set(seller.owner.auth).send({ items: [{ productId: prod.id, quantity: 1 }] }).expect(403);   // direct sales are capped
    const sup = (await api().post(`${buyer.base}/suppliers`).set(buyer.owner.auth).send({ name: "S", linkedBusinessId: seller.id }).expect(201)).body.supplier;
    const po = (await api().post(`${buyer.base}/purchases`).set(buyer.owner.auth).send({ supplierId: sup.id, items: [{ supplierProductId: prod.id, quantity: 1 }] }).expect(201)).body.purchase;
    await api().post(`${buyer.base}/purchases/${po.id}/send`).set(buyer.owner.auth).expect(200);       // buyer's PO still reaches the seller
    expect((await api().get(`${seller.base}/orders?source=marketplace`).set(seller.owner.auth)).body.total).toBe(1);
  });

  it("meters storage per business and leaves personal uploads unlimited", async () => {
    const c = await setup(); const outsider = await registerUser("individual"); await putOnPlan(c, "tiny");
    const personal = await api().post("/api/uploads").set(c.owner.auth).attach("file", png, "a.png").expect(201);
    expect(personal.body.url).toMatch(/^\/uploads\//);
    const over = await api().post(`/api/uploads?businessId=${c.id}`).set(c.owner.auth).attach("file", png, "a.png").expect(403);
    expect(over.body.error).toMatchObject({ code: "PLAN_LIMIT", details: { resource: "storageMb" } });
    await api().post(`/api/uploads?businessId=${c.id}`).set(outsider.auth).attach("file", png, "a.png").expect(404);   // cannot charge someone else's business
    await api().post("/api/uploads?businessId=not-a-uuid").set(c.owner.auth).attach("file", png, "a.png").expect(400);
    await putOnPlan(c, "starter");
    await api().post(`/api/uploads?businessId=${c.id}`).set(c.owner.auth).attach("file", png, "a.png").expect(201);
    expect((await api().get(`${c.base}/subscription`).set(c.owner.auth)).body.subscription.usage.storageMb).toBeGreaterThan(0);
  });

  it("caps businesses per owner using the best plan they hold", async () => {
    const owner = await registerUser();
    const mk = (n: string) => api().post("/api/businesses").set(owner.auth).send({ name: `${n} ${Date.now()}` });
    const first = (await mk("First").expect(201)).body.business;
    expect((await mk("Second").expect(403)).body.error).toMatchObject({ code: "PLAN_LIMIT", details: { resource: "businesses", limit: 1 } });
    await putOnPlan(first, "starter");
    await mk("Second").expect(201);
    expect((await mk("Third").expect(403)).body.error.details).toMatchObject({ limit: 2, current: 2 });
  });

  it("only lets owners downgrade (when usage fits); upgrades are admin/payment-only", async () => {
    const c = await setup(); const emp = await addEmployee(c); const admin = await makeAdmin();
    const put = (u: any, planKey: string) => api().put(`${c.base}/subscription`).set(u.auth).send({ planKey });
    await put(c.owner, "pro").expect(403).then((r) => expect(r.body.error.code).toBe("PAYMENT_REQUIRED"));
    await put(emp, "free").expect(403);                                                           // needs business.manage
    await api().put(`/api/admin/businesses/${c.id}/subscription`).set(c.owner.auth).send({ planKey: "pro" }).expect(403);
    await api().put(`/api/admin/businesses/${c.id}/subscription`).set(admin.auth).send({ planKey: "nope" }).expect(400);
    const up = (await api().put(`/api/admin/businesses/${c.id}/subscription`).set(admin.auth)
      .send({ planKey: "pro", provider: "razorpay", providerRef: "sub_123", periodEnd: "2030-01-31T00:00:00Z" }).expect(200)).body.subscription;
    expect(up.plan.key).toBe("pro"); expect(up.currentPeriodEnd).toContain("2030-01-31");
    for (let i = 0; i < 4; i++) await addEmployee(c);                                              // 6 members now (Free allows 5)
    const no = await put(c.owner, "free").expect(409);
    expect(no.body.error.message).toMatch(/6 team members \(limit 5\)/);
    await put(c.owner, "starter").expect(200);                                                    // starter allows 25
    expect((await api().get(`${c.base}/subscription`).set(c.owner.auth)).body.subscription.plan.key).toBe("starter");
    const log = (await api().get(`/api/admin/audit?businessId=${c.id}&action=subscription`).set(admin.auth)).body.entries.map((e: any) => e.action);
    expect(log).toEqual(expect.arrayContaining(["subscription.plan_change", "subscription.downgrade"]));
  });

  it("blocks additions on a cancelled subscription", async () => {
    const c = await setup();
    await pool.query("UPDATE subscriptions SET status='cancelled' WHERE business_id=$1", [c.id]);
    const r = await api().post(`${c.base}/products`).set(c.owner.auth).send({ name: "x", sku: "x" }).expect(403);
    expect(r.body.error.code).toBe("PLAN_INACTIVE");
  });
});
