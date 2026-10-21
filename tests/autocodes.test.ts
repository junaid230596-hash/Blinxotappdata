import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, pool, registerUser, resetDb } from "./helpers.js";
import { addEmployee, addProduct, setup } from "./factory.js";

beforeAll(resetDb);
afterAll(() => pool.end());

// Invoice numbers restart each Indian financial year (April-March): INV/26-27/000001
const fyShort = (d = new Date()) => { const ist = new Date(d.getTime() + 5.5 * 3600e3); const s = ist.getUTCMonth() + 1 >= 4 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1; return `${String(s % 100).padStart(2, "0")}-${String((s + 1) % 100).padStart(2, "0")}`; };
const INV = (n: number) => `INV/${fyShort()}/${String(n).padStart(6, "0")}`;
const post = (c: any, path: string, body: any) => api().post(`${c.base}${path}`).set(c.owner.auth).send(body);

describe("automatic product SKUs", () => {
  it("numbers products SKU-000001, SKU-000002 ... per business when the SKU is left blank", async () => {
    const a = await setup(); const b = await setup();
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await post(a, "/products", { name: `P${i}` }).expect(201)).body.product.sku);
    expect(codes).toEqual(["SKU-000001", "SKU-000002", "SKU-000003"]);
    expect((await post(b, "/products", { name: "Other tenant" }).expect(201)).body.product.sku).toBe("SKU-000001");      // each business has its own sequence
    expect((await post(a, "/products", { name: "Blank", sku: "   " }).expect(201)).body.product.sku).toBe("SKU-000004");   // whitespace counts as blank
  });

  it("keeps hand-typed SKUs, rejects duplicates, and never generates a SKU that is already taken", async () => {
    const c = await setup();
    expect((await post(c, "/products", { name: "Custom", sku: "ABC-1" }).expect(201)).body.product.sku).toBe("ABC-1");
    await post(c, "/products", { name: "Dup", sku: "ABC-1" }).expect(409);
    await post(c, "/products", { name: "Typed", sku: "SKU-000002" }).expect(201);                                         // squats on the next generated value
    expect((await post(c, "/products", { name: "Auto1" }).expect(201)).body.product.sku).toBe("SKU-000001");
    expect((await post(c, "/products", { name: "Auto2" }).expect(201)).body.product.sku).toBe("SKU-000003");              // 000002 skipped, not an error
  });

  it("stays unique when many products are created at the same moment", async () => {
    const c = await setup();
    const res = await Promise.all(Array.from({ length: 20 }, (_, i) => post(c, "/products", { name: `Burst ${i}` })));
    expect(res.every((r) => r.status === 201)).toBe(true);
    const skus = res.map((r) => r.body.product.sku);
    expect(new Set(skus).size).toBe(20);
    expect([...skus].sort()).toEqual(Array.from({ length: 20 }, (_, i) => `SKU-${String(i + 1).padStart(6, "0")}`));      // no gaps either
  });
});

describe("automatic record numbers", () => {
  it("every business record gets a unique, prefixed, per-business number and is searchable by it", async () => {
    const c = await setup(); const other = await setup();
    const cus = [(await post(c, "/customers", { name: "Asha" }).expect(201)).body.customer, (await post(c, "/customers", { name: "Bela" }).expect(201)).body.customer];
    expect(cus.map((x) => x.code)).toEqual(["CUS-000001", "CUS-000002"]);
    expect((await post(other, "/customers", { name: "Elsewhere" }).expect(201)).body.customer.code).toBe("CUS-000001");
    const found = (await api().get(`${c.base}/customers?q=CUS-000002`).set(c.owner.auth).expect(200)).body.customers;
    expect(found.map((x: any) => x.name)).toEqual(["Bela"]);

    const emp = await addEmployee(c);
    const emps = (await api().get(`${c.base}/employees`).set(c.owner.auth).expect(200)).body.employees;
    expect(emps.find((e: any) => e.id === emp.employeeId).code).toBe("EMP-000001");
    expect((await post(c, "/suppliers", { name: "Mill" }).expect(201)).body.supplier.code).toBe("SUP-000001");
    expect((await post(c, "/tasks", { title: "Count stock" }).expect(201)).body.task.code).toBe("TSK-000001");
    expect((await post(c, "/crm/leads", { name: "Prospect" }).expect(201)).body.lead.code).toBe("LEAD-000001");
    const stage = (await api().get(`${c.base}/crm/stages`).set(c.owner.auth).expect(200)).body.stages[0];
    expect((await post(c, "/crm/deals", { title: "Big deal", stageId: stage.id }).expect(201)).body.deal.code).toBe("DEAL-000001");
    expect((await post(c, "/jobs", { title: "Cashier", description: "Run the till and help customers.", workType: "full_time" }).expect(201)).body.job.code).toBe("JOB-000001");
  });

  it("existing and new tables all carry the numbering trigger and a unique index", async () => {
    const { rows } = await pool.query(`SELECT c.relname AS tbl FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE t.tgname IN (SELECT tgname FROM pg_trigger WHERE tgfoid='assign_code'::regproc) ORDER BY 1`);
    expect(rows.map((r) => r.tbl)).toEqual(["crm_deals", "crm_leads", "customers", "employees", "jobs", "order_returns", "products", "salary_records", "suppliers", "tasks"]);
    const idx = await pool.query(`SELECT count(*)::int AS n FROM pg_indexes WHERE indexname LIKE 'uq\\_%\\_code' ESCAPE '\\'`);
    expect(idx.rows[0].n).toBe(9);
  });

  it("numbers returns RET-000001", async () => {
    const c = await setup(); const p = await addProduct(c, { openingStock: 5, sellingPrice: 100 });
    const o = (await post(c, "/orders", { items: [{ productId: p.id, quantity: 2 }] }).expect(201)).body.order;
    for (const s of ["accepted", "processing", "ready", "delivered"]) await api().patch(`${c.base}/orders/${o.id}/status`).set(c.owner.auth).send({ status: s }).expect(200);
    const detail = (await api().get(`${c.base}/orders/${o.id}`).set(c.owner.auth)).body.order;
    const r = await post(c, `/orders/${o.id}/returns`, { items: [{ orderItemId: detail.items[0].id, quantity: 1, condition: "resellable" }] }).expect(201);
    expect(r.body.order.returns[0].code).toBe("RET-000001");
  });
});

describe("automatic invoice numbers", () => {
  async function sale(c: any, p: any, qty = 1) { return (await post(c, "/orders", { items: [{ productId: p.id, quantity: qty }] }).expect(201)).body.order; }
  const status = (c: any, id: string, s: string) => api().patch(`${c.base}/orders/${id}/status`).set(c.owner.auth).send({ status: s });

  it("issues INV-000001, INV-000002 when orders are accepted, never reuses a number, and voids on cancellation", async () => {
    const c = await setup(); const p = await addProduct(c, { openingStock: 20, sellingPrice: 100, taxRate: 18 });
    const o1 = await sale(c, p, 2); const o2 = await sale(c, p); const o3 = await sale(c, p);
    await api().get(`${c.base}/invoices/by-order/${o1.id}`).set(c.owner.auth).expect(404);                       // nothing until accepted
    expect((await api().get(`${c.base}/orders/${o1.id}`).set(c.owner.auth)).body.order.invoice).toBeNull();
    await status(c, o1.id, "accepted").expect(200); await status(c, o2.id, "accepted").expect(200);
    const i1 = (await api().get(`${c.base}/invoices/by-order/${o1.id}`).set(c.owner.auth).expect(200)).body.invoice;
    expect(i1).toMatchObject({ number: INV(1), status: "issued", total: 236, taxTotal: 36, orderNumber: o1.orderNumber });
    expect((await api().get(`${c.base}/orders/${o2.id}`).set(c.owner.auth)).body.order.invoice).toMatchObject({ number: INV(2), status: "issued" });

    await status(c, o2.id, "cancelled").expect(200);                                                              // void keeps the number on record
    expect((await api().get(`${c.base}/orders/${o2.id}`).set(c.owner.auth)).body.order.invoice).toMatchObject({ number: INV(2), status: "void" });
    await status(c, o3.id, "accepted").expect(200);
    expect((await api().get(`${c.base}/orders/${o3.id}`).set(c.owner.auth)).body.order.invoice.number).toBe(INV(3));   // gapless and never reused
    const list = (await api().get(`${c.base}/invoices`).set(c.owner.auth).expect(200)).body;
    expect(list.invoices.map((i: any) => i.number).sort()).toEqual([INV(1), INV(2), INV(3)]);
    expect((await api().get(`${c.base}/invoices?q=${encodeURIComponent(INV(2))}&status=void`).set(c.owner.auth)).body.invoices).toHaveLength(1);
    expect((await api().get(`${c.base}/invoices?status=issued`).set(c.owner.auth)).body.total).toBe(2);
    const n = await pool.query("SELECT count(*)::int AS n FROM invoices WHERE business_id=$1", [c.id]); expect(n.rows[0].n).toBe(3);
  });

  it("freezes what was issued: later price or name changes do not alter an invoice", async () => {
    const c = await setup(); const p = await addProduct(c, { name: "Original Name", openingStock: 5, sellingPrice: 100 });
    const o = await sale(c, p); await status(c, o.id, "accepted").expect(200);
    await api().patch(`${c.base}/products/${p.id}`).set(c.owner.auth).send({ name: "Renamed", sellingPrice: 999 }).expect(200);
    await api().patch(c.base).set(c.owner.auth).send({ name: "Renamed Business" }).expect(200);
    const inv = (await api().get(`${c.base}/invoices/by-order/${o.id}`).set(c.owner.auth)).body.invoice;
    expect(inv.details.items[0]).toMatchObject({ name: "Original Name", unitPrice: 100, quantity: 1 });
    expect(inv.details.seller.name).not.toBe("Renamed Business");
    expect(inv.total).toBe(100);
  });

  it("is isolated per business and gated by permission", async () => {
    const c = await setup(); const other = await setup(); const emp = await addEmployee(c);
    const p = await addProduct(c, { openingStock: 5 }); const o = await sale(c, p); await status(c, o.id, "accepted").expect(200);
    const inv = (await api().get(`${c.base}/invoices/by-order/${o.id}`).set(c.owner.auth)).body.invoice;
    await api().get(`${c.base}/invoices/${inv.id}`).set(other.owner.auth).expect(404);
    await api().get(`/api/businesses/${other.id}/invoices/${inv.id}`).set(other.owner.auth).expect(404);              // right tenant, wrong id
    await api().get(`${c.base}/invoices`).send().expect(401);
    const canSee = (await api().get(`${c.base}/orders`).set(emp.auth)).status === 200;
    expect((await api().get(`${c.base}/invoices`).set(emp.auth)).status).toBe(canSee ? 200 : 403);
    await api().get(`${c.base}/invoices/not-a-uuid`).set(c.owner.auth).expect(400);
  });

  it("gives an individual buyer their own invoice, and nobody else", async () => {
    const c = await setup(); const p = await addProduct(c, { openingStock: 5, sellingPrice: 250 });
    await pool.query("UPDATE products SET is_listed=true WHERE id=$1", [p.id]);
    const buyer = await registerUser("individual"); const stranger = await registerUser("individual");
    const o = (await api().post("/api/me/orders").set(buyer.auth).send({ businessId: c.id, items: [{ productId: p.id, quantity: 1 }], deliveryAddress: "12 Lake Road, Udaipur", phone: "+91 98290 12345" }).expect(201)).body.order;
    await api().get(`/api/me/orders/${o.id}/invoice`).set(buyer.auth).expect(404);                                   // not accepted yet
    await status(c, o.id, "accepted").expect(200);
    const inv = (await api().get(`/api/me/orders/${o.id}/invoice`).set(buyer.auth).expect(200)).body.invoice;
    expect(inv).toMatchObject({ number: INV(1), total: 250 }); expect(inv.details.buyer.type).toBe("individual");
    expect((await api().get(`/api/me/orders/${o.id}`).set(buyer.auth)).body.order.invoice.number).toBe(INV(1));
    await api().get(`/api/me/orders/${o.id}/invoice`).set(stranger.auth).expect(404);
    expect(JSON.stringify(inv)).not.toContain(buyer.email);                                                          // the buyer's email is never printed on an invoice
  });
});
