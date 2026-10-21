import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api as _api, PASSWORD, pool, registerUser, resetDb } from "./helpers.js";
import { addEmployee, addProduct, makeAdmin, setup } from "./factory.js";

const api = _api;
beforeAll(resetDb);
afterAll(() => pool.end());

describe("admin access", () => {
  it("is closed to everyone but super admins", async () => {
    const u = await registerUser(); const admin = await makeAdmin();
    for (const p of ["overview", "users", "businesses", "employees", "products", "orders", "audit", "categories", "settings", "reviews", "ads"]) {
      await api().get(`/api/admin/${p}`).expect(401);
      await api().get(`/api/admin/${p}`).set(u.auth).expect(403);
      await api().get(`/api/admin/${p}`).set(admin.auth).expect(200);
    }
    const c = await setup();
    await api().post(`/api/admin/users/${u.id}/suspend`).set(c.owner.auth).send({}).expect(403);
    const ov = (await api().get("/api/admin/overview").set(admin.auth)).body;
    expect(ov).toMatchObject({ users: { active: expect.any(Number) }, businesses: { active: expect.any(Number) }, orders: { total: expect.any(Number) }, subscriptionsByPlan: { free: expect.any(Number) } });
  });
});

describe("user management", () => {
  it("lists, filters and inspects users", async () => {
    const admin = await makeAdmin(); const c = await setup(); const tag = `findme${Date.now()}`;
    await pool.query("UPDATE users SET full_name=$2 WHERE id=$1", [c.owner.id, `Zed ${tag}`]);
    const found = (await api().get(`/api/admin/users?q=${tag}`).set(admin.auth).expect(200)).body;
    expect(found.total).toBe(1); expect(found.users[0]).toMatchObject({ id: c.owner.id, accountType: "business_owner", status: "active", emailVerified: true });
    expect(JSON.stringify(found)).not.toMatch(/password|hash/i);
    expect((await api().get("/api/admin/users?accountType=super_admin").set(admin.auth)).body.users.every((u: any) => u.accountType === "super_admin")).toBe(true);
    expect((await api().get("/api/admin/users?limit=1&offset=1").set(admin.auth)).body.users).toHaveLength(1);
    const d = (await api().get(`/api/admin/users/${c.owner.id}`).set(admin.auth).expect(200)).body.user;
    expect(d.businesses[0]).toMatchObject({ id: c.id, role: "Business Owner" }); expect(d.activeSessions).toBeGreaterThan(0);
    await api().get("/api/admin/users/00000000-0000-4000-8000-000000000000").set(admin.auth).expect(404);
    await api().get("/api/admin/users/not-a-uuid").set(admin.auth).expect(400);
  });

  it("suspends instantly (tokens, refresh, login) and restores on reactivation, with an audit trail", async () => {
    const admin = await makeAdmin(); const other = await makeAdmin(); const u = await registerUser("individual");
    await api().get("/api/auth/me").set(u.auth).expect(200);
    await api().post(`/api/admin/users/${admin.id}/suspend`).set(admin.auth).send({}).expect(403);           // not yourself
    await api().post(`/api/admin/users/${other.id}/suspend`).set(admin.auth).send({}).expect(403);           // nor another super admin
    await api().post("/api/admin/users/00000000-0000-4000-8000-000000000000/suspend").set(admin.auth).send({}).expect(404);
    const s = (await api().post(`/api/admin/users/${u.id}/suspend`).set(admin.auth).send({ reason: "Fraud report #12" }).expect(200)).body.user;
    expect(s.status).toBe("suspended"); expect(s.activeSessions).toBe(0);
    await api().get("/api/auth/me").set(u.auth).expect(401);                                                  // existing access token dies at once
    await api().post("/api/auth/refresh").send({ refreshToken: u.refresh }).expect(401);
    expect((await api().post("/api/auth/login").send({ email: u.email, password: PASSWORD }).expect(403)).body.error.code).toBe("ACCOUNT_SUSPENDED");
    await api().post(`/api/admin/users/${u.id}/suspend`).set(admin.auth).send({}).expect(409);
    expect((await api().get("/api/admin/users?status=suspended").set(admin.auth)).body.users.map((x: any) => x.id)).toContain(u.id);
    await api().post(`/api/admin/users/${u.id}/reactivate`).set(admin.auth).send({}).expect(200);
    await api().post("/api/auth/login").send({ email: u.email, password: PASSWORD }).expect(200);
    const log = (await api().get(`/api/admin/audit?action=admin.user&actorId=${admin.id}`).set(admin.auth)).body.entries;
    expect(log.map((e: any) => e.action).sort()).toEqual(["admin.user_reactivate", "admin.user_suspend"]);
    expect(log.find((e: any) => e.action === "admin.user_suspend")).toMatchObject({ entityId: u.id, metadata: { reason: "Fraud report #12" }, actorName: "Test User" });
  });
});

describe("business management", () => {
  it("suspends a business everywhere (members, public pages, marketplace) and reactivates it", async () => {
    const admin = await makeAdmin(); const c = await setup(`Shady ${Date.now()}`); const emp = await addEmployee(c);
    await addProduct(c, { name: `Shady Goods ${Date.now()}`, isListed: true });
    await api().get(`/api/public/businesses/${c.biz.slug}`).expect(200);
    const list = (await api().get(`/api/admin/businesses?q=${c.biz.slug.slice(0, 8)}`).set(admin.auth).expect(200)).body.businesses.find((b: any) => b.id === c.id);
    expect(list).toMatchObject({ plan: "free", status: "active", members: 2, ownerEmail: c.owner.email });
    await api().post(`/api/admin/businesses/${c.id}/suspend`).set(admin.auth).send({ reason: "Counterfeit goods" }).expect(200);
    await api().get(`${c.base}`).set(c.owner.auth).expect(404);
    await api().get(`${c.base}/products`).set(emp.auth).expect(404);
    await api().get(`/api/public/businesses/${c.biz.slug}`).expect(404);
    expect((await api().get(`/api/public/marketplace/businesses?q=Shady`).expect(200)).body.businesses.some((b: any) => b.id === c.id)).toBe(false);
    expect((await api().get("/api/businesses/mine").set(c.owner.auth)).body.businesses.some((b: any) => b.id === c.id)).toBe(false);
    expect((await api().get("/api/notifications").set(c.owner.auth)).body.notifications.some((n: any) => n.type === "business.status" && n.body === "Counterfeit goods")).toBe(true);
    await api().post(`/api/admin/businesses/${c.id}/suspend`).set(admin.auth).send({}).expect(409);
    expect((await api().get("/api/admin/businesses?status=suspended").set(admin.auth)).body.businesses.map((b: any) => b.id)).toContain(c.id);
    await api().post(`/api/admin/businesses/${c.id}/reactivate`).set(admin.auth).send({}).expect(200);
    await api().get(`${c.base}`).set(c.owner.auth).expect(200);
    await api().get(`/api/public/businesses/${c.biz.slug}`).expect(200);
    await api().post(`/api/admin/businesses/00000000-0000-4000-8000-000000000000/suspend`).set(admin.auth).send({}).expect(404);
  });
});

describe("platform-wide views", () => {
  it("lists employees (without pay data), products and orders across businesses, and lets admins delist products", async () => {
    const admin = await makeAdmin(); const c = await setup(); const e = await addEmployee(c, `Plat Form ${Date.now()}`);
    await api().put(`${c.base}/employees/${e.employeeId}/salary-config`).set(c.owner.auth).send({ method: "monthly", rate: 123456 }).expect(200);
    const emps = (await api().get(`/api/admin/employees?businessId=${c.id}`).set(admin.auth).expect(200)).body;
    expect(emps.total).toBe(1); expect(emps.employees[0]).toMatchObject({ businessName: c.biz.name, status: "active" });
    expect(JSON.stringify(emps)).not.toMatch(/123456|salary|rate/i);
    const p = await addProduct(c, { name: `Admin Seen ${Date.now()}`, isListed: true, openingStock: 5 });
    expect((await api().get(`/api/admin/products?businessId=${c.id}&q=Admin Seen`).set(admin.auth)).body.products[0]).toMatchObject({ id: p.id, isListed: true, businessName: c.biz.name });
    expect((await api().get(`/api/public/marketplace/products?businessId=${c.id}`)).body.total).toBe(1);
    await api().patch(`/api/admin/products/${p.id}`).set(admin.auth).send({ isListed: false }).expect(200);
    expect((await api().get(`/api/public/marketplace/products?businessId=${c.id}`)).body.total).toBe(0);
    await api().patch(`/api/admin/products/${p.id}`).set(admin.auth).send({}).expect(400);
    await api().patch(`/api/admin/products/${p.id}`).set(c.owner.auth).send({ isListed: true }).expect(403);
    const o = (await api().post(`${c.base}/orders`).set(c.owner.auth).send({ items: [{ productId: p.id, quantity: 1 }] }).expect(201)).body.order;
    const orders = (await api().get(`/api/admin/orders?businessId=${c.id}&status=pending`).set(admin.auth).expect(200)).body;
    expect(orders.orders[0]).toMatchObject({ id: o.id, orderNumber: o.orderNumber, seller: c.biz.name, status: "pending" });
    expect((await api().get(`/api/admin/orders?businessId=${c.id}&status=delivered`).set(admin.auth)).body.total).toBe(0);
  });

  it("filters the audit log by actor, business, action and date", async () => {
    const admin = await makeAdmin(); const c = await setup(); await addProduct(c);
    const byBiz = (await api().get(`/api/admin/audit?businessId=${c.id}`).set(admin.auth).expect(200)).body;
    expect(byBiz.entries.map((e: any) => e.action)).toEqual(expect.arrayContaining(["business.create", "product.create"]));
    expect(byBiz.entries.every((e: any) => e.businessId === c.id)).toBe(true);
    expect((await api().get(`/api/admin/audit?businessId=${c.id}&action=product`).set(admin.auth)).body.entries.every((e: any) => e.action.startsWith("product"))).toBe(true);
    expect((await api().get(`/api/admin/audit?actorId=${c.owner.id}&action=user.login`).set(admin.auth)).body.total).toBeGreaterThan(0);
    expect((await api().get("/api/admin/audit?from=2000-01-01&to=2000-01-02").set(admin.auth)).body.total).toBe(0);
    await api().get("/api/admin/audit?from=bad").set(admin.auth).expect(400);
    const ids = (await api().get("/api/admin/audit?limit=5").set(admin.auth)).body.entries.map((e: any) => e.id);
    expect(ids).toEqual([...ids].sort((a: number, b: number) => b - a));                                      // newest first
  });
});

describe("categories and settings", () => {
  it("manages platform categories and publishes them for discovery filters", async () => {
    const admin = await makeAdmin(); const u = await registerUser();
    const cat = (await api().post("/api/admin/categories").set(admin.auth).send({ kind: "business", name: "Grocery" }).expect(201)).body.category;
    await api().post("/api/admin/categories").set(admin.auth).send({ kind: "business", name: "grocery" }).expect(409);
    await api().post("/api/admin/categories").set(admin.auth).send({ kind: "product", name: "Grocery" }).expect(201);   // same name, different kind
    await api().post("/api/admin/categories").set(admin.auth).send({ kind: "weird", name: "x" }).expect(400);
    await api().post("/api/admin/categories").set(u.auth).send({ kind: "business", name: "Hack" }).expect(403);
    expect((await api().patch(`/api/admin/categories/${cat.id}`).set(admin.auth).send({ name: "Groceries" }).expect(200)).body.category.name).toBe("Groceries");
    const pub = (await api().get("/api/public/categories?kind=business").expect(200)).body.categories;      // no sign-in needed
    expect(pub.map((c: any) => c.name)).toEqual(["Groceries"]);
    expect((await api().get("/api/public/categories").expect(200)).body.categories).toHaveLength(2);
    await api().delete(`/api/admin/categories/${cat.id}`).set(admin.auth).expect(200);
    await api().delete(`/api/admin/categories/${cat.id}`).set(admin.auth).expect(404);
    expect((await api().get("/api/public/categories?kind=business").expect(200)).body.categories).toEqual([]);
  });

  it("validates settings and closes registration on demand", async () => {
    const admin = await makeAdmin();
    expect((await api().get("/api/admin/settings").set(admin.auth)).body.settings).toEqual({ registration_open: true, maintenance_mode: false, support_email: null });
    await api().put("/api/admin/settings/nonsense").set(admin.auth).send({ value: true }).expect(400);
    await api().put("/api/admin/settings/registration_open").set(admin.auth).send({ value: "yes" }).expect(400);
    await api().put("/api/admin/settings/support_email").set(admin.auth).send({ value: "not-an-email" }).expect(400);
    expect((await api().put("/api/admin/settings/support_email").set(admin.auth).send({ value: "help@blinxot.com" }).expect(200)).body.settings.support_email).toBe("help@blinxot.com");
    const existing = await registerUser("individual");
    try {
      await api().put("/api/admin/settings/registration_open").set(admin.auth).send({ value: false }).expect(200);
      const r = await api().post("/api/auth/register").send({ email: `late${Date.now()}@example.com`, password: PASSWORD, fullName: "Late", accountType: "individual" }).expect(403);
      expect(r.body.error.code).toBe("REGISTRATION_CLOSED");
      await api().post("/api/auth/login").send({ email: existing.email, password: PASSWORD }).expect(200);   // existing users are unaffected
    } finally { await api().put("/api/admin/settings/registration_open").set(admin.auth).send({ value: true }).expect(200); }
    await api().post("/api/auth/register").send({ email: `open${Date.now()}@example.com`, password: PASSWORD, fullName: "Open", accountType: "individual" }).expect(201);
    const log = (await api().get("/api/admin/audit?action=admin.setting").set(admin.auth)).body.entries;
    expect(log.length).toBeGreaterThanOrEqual(3);
  });

  it("puts the platform into read-only maintenance mode for everyone except super admins", async () => {
    const admin = await makeAdmin(); const c = await setup(); const emp = await addEmployee(c);
    try {
      await api().put("/api/admin/settings/maintenance_mode").set(admin.auth).send({ value: true }).expect(200);
      const blocked = await api().post(`${c.base}/products`).set(c.owner.auth).send({ name: "x", sku: "x" }).expect(503);
      expect(blocked.body.error.code).toBe("MAINTENANCE");
      await api().post(`${c.base}/me/punch-in`).set(emp.auth).expect(503);
      await api().get(`${c.base}/products`).set(c.owner.auth).expect(200);                                   // reading still works
      await api().get("/api/public/jobs").expect(200);
      await api().post("/api/auth/login").send({ email: c.owner.email, password: PASSWORD }).expect(200);    // signing in still works
      await api().post("/api/admin/categories").set(admin.auth).send({ kind: "product", name: `Maint ${Date.now()}` }).expect(201);   // admins keep working
    } finally { await api().put("/api/admin/settings/maintenance_mode").set(admin.auth).send({ value: false }).expect(200); }
    await api().post(`${c.base}/products`).set(c.owner.auth).send({ name: "after", sku: "after" }).expect(201);
  });
});
