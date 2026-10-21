import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api as _api, pool, resetDb } from "./helpers.js";
import { addEmployee, addMember, addProduct, setup } from "./factory.js";
import * as att from "../server/src/modules/attendance/attendance.service.js";

const api = _api;
beforeAll(resetDb);
afterAll(() => pool.end());

const walk = async (c: any, id: string) => { for (const s of ["accepted", "processing", "ready", "delivered"]) await api().patch(`${c.base}/orders/${id}/status`).set(c.owner.auth).send({ status: s }).expect(200); };
const rep = (c: any, type: string, q = "") => api().get(`${c.base}/reports/${type}${q}`).set(c.owner.auth);
const binary = (res: any, cb: any) => { const chunks: Buffer[] = []; res.on("data", (d: Buffer) => chunks.push(d)); res.on("end", () => cb(null, Buffer.concat(chunks))); };

async function world() {
  const c = await setup(`Report Co ${Date.now()}`);
  const rice = await addProduct(c, { name: "Rice", sku: "R1", sellingPrice: 100, taxRate: 10, costPrice: 50, openingStock: 20, minStock: 5 });
  const cust = (await api().post(`${c.base}/customers`).set(c.owner.auth).send({ name: "Acme, Inc", email: undefined }).expect(201)).body.customer;
  const o1 = (await api().post(`${c.base}/orders`).set(c.owner.auth).send({ customerId: cust.id, items: [{ productId: rice.id, quantity: 2 }] }).expect(201)).body.order;   // 220
  const o2 = (await api().post(`${c.base}/orders`).set(c.owner.auth).send({ customerId: cust.id, items: [{ productId: rice.id, quantity: 1 }] }).expect(201)).body.order;   // 110
  await walk(c, o1.id); await walk(c, o2.id);
  await api().post(`${c.base}/orders/${o2.id}/returns`).set(c.owner.auth).send({ items: [{ orderItemId: o2.items[0].id, quantity: 1, condition: "resellable" }] }).expect(201);
  return { c, rice, cust };
}

describe("business reports", () => {
  it("lists only the reports the caller may run, and blocks others", async () => {
    const c = await setup(); const mgr = await addMember(c, "Manager"); const emp = await addEmployee(c);
    const all = (await api().get(`${c.base}/reports`).set(c.owner.auth).expect(200)).body.reports.map((r: any) => r.key);
    expect(all).toEqual(expect.arrayContaining(["sales", "purchases", "inventory", "stock-movements", "attendance", "working-hours", "salary", "customers", "suppliers", "orders", "crm"]));
    expect(all).toHaveLength(11);
    const m = (await api().get(`${c.base}/reports`).set(mgr.auth).expect(200)).body.reports.map((r: any) => r.key);
    expect(m).toHaveLength(10); expect(m).not.toContain("salary");                                  // managers lack salary.view
    await api().get(`${c.base}/reports/salary`).set(mgr.auth).expect(403);
    await api().get(`${c.base}/reports/sales`).set(mgr.auth).expect(200);
    await api().get(`${c.base}/reports`).set(emp.auth).expect(403);                                 // employees have no reports.view
    await api().get(`${c.base}/reports/sales`).set(emp.auth).expect(403);
    await api().get(`${c.base}/reports/sales`).set((await setup()).owner.auth).expect(404);
    await api().get(`${c.base}/reports/sales`).expect(401);
  });

  it("validates dates, formats and report names", async () => {
    const c = await setup();
    await rep(c, "nope").expect(404);
    await rep(c, "sales", "?from=2026-09-10&to=2026-09-01").expect(400);
    await rep(c, "sales", "?from=2024-01-01&to=2026-01-01").expect(400);
    await rep(c, "sales", "?from=09/01/2026").expect(400);
    await rep(c, "sales", "?format=xml").expect(400);
    expect((await rep(c, "sales").expect(200)).body).toMatchObject({ type: "sales", rows: [], summary: { orders: 0, netSales: 0 } });   // empty is fine
  });

  it("computes sales, orders, customers, inventory and stock-movement figures from real activity", async () => {
    const { c } = await world();
    const sales = (await rep(c, "sales").expect(200)).body;
    expect(sales.rows.map((r: any) => [r.total, r.refunds, r.net, r.status])).toEqual([[220, 0, 220, "delivered"], [110, 110, 0, "returned"]]);
    expect(sales.summary).toEqual({ orders: 2, grossSales: 330, refunds: 110, netSales: 220 });
    expect(sales.rows[0].party).toBe("Acme, Inc");
    const orders = (await rep(c, "orders").expect(200)).body;
    expect(orders.summary).toMatchObject({ orders: 2, valueExcludingCancelled: 330, status_delivered: 1, status_returned: 1 });
    const cust = (await rep(c, "customers").expect(200)).body;
    expect(cust.rows[0]).toMatchObject({ customer: "Acme, Inc", orders: 2, spent: 220 }); expect(cust.summary.totalSpent).toBe(220);
    const inv = (await rep(c, "inventory").expect(200)).body;
    expect(inv.rows[0]).toMatchObject({ name: "Rice", stock: 18, costPrice: 50, stockValue: 900, retailValue: 1800, low: "No" });   // 20 - 2 - 1 + 1 returned
    expect(inv.summary).toEqual({ products: 1, totalCostValue: 900, totalRetailValue: 1800, lowStockProducts: 0 });
    const mv = (await rep(c, "stock-movements").expect(200)).body;
    expect(mv.rows.map((r: any) => [r.type, r.change])).toEqual([["opening", 20], ["sale", -2], ["sale", -1], ["sale_return", 1]]);
    expect(mv.summary).toEqual({ movements: 4, unitsIn: 21, unitsOut: 3 });
    const past = (await rep(c, "sales", "?from=2020-01-01&to=2020-01-31").expect(200)).body;     // date filter excludes today's activity
    expect(past.summary.orders).toBe(0);
  });

  it("reports purchases, suppliers and CRM", async () => {
    const { c, rice } = await world();
    const sup = (await api().post(`${c.base}/suppliers`).set(c.owner.auth).send({ name: "Mill Co" }).expect(201)).body.supplier;
    const po = (await api().post(`${c.base}/purchases`).set(c.owner.auth).send({ supplierId: sup.id, items: [{ productId: rice.id, quantity: 10, unitCost: 50 }] }).expect(201)).body.purchase;
    await api().post(`${c.base}/purchases/${po.id}/send`).set(c.owner.auth).expect(200); await api().post(`${c.base}/purchases/${po.id}/accept`).set(c.owner.auth).expect(200);
    await api().post(`${c.base}/purchases/${po.id}/receive`).set(c.owner.auth).send({ items: [{ itemId: po.items[0].id, quantity: 4 }] }).expect(200);
    const p = (await rep(c, "purchases").expect(200)).body;
    expect(p.rows[0]).toMatchObject({ poNumber: po.poNumber, supplier: "Mill Co", status: "partially_received", total: 500, receivedPct: 40 });
    expect(p.summary).toEqual({ purchases: 1, committedValue: 500 });
    const s = (await rep(c, "suppliers").expect(200)).body;
    expect(s.rows[0]).toMatchObject({ supplier: "Mill Co", purchases: 1, spent: 500, pending: 1 });

    const won = (await api().get(`${c.base}/crm/stages`).set(c.owner.auth)).body.stages.find((x: any) => x.kind === "won").id;
    await api().post(`${c.base}/crm/leads`).set(c.owner.auth).send({ name: "Lead A", ownerId: c.owner.id }).expect(201);
    await api().post(`${c.base}/crm/deals`).set(c.owner.auth).send({ title: "Big", value: 700, stageId: won, ownerId: c.owner.id }).expect(201);
    await api().post(`${c.base}/crm/deals`).set(c.owner.auth).send({ title: "Open", value: 300 }).expect(201);
    const crm = (await rep(c, "crm").expect(200)).body;
    expect(crm.rows.find((r: any) => r.owner === "Test User")).toMatchObject({ leads: 1, won: 1, wonValue: 700 });
    expect(crm.rows.find((r: any) => r.owner === "Unassigned")).toMatchObject({ openValue: 300 });
    expect(crm.summary).toEqual({ wonValue: 700, openPipeline: 300 });
  });

  it("reports attendance, working hours and salary consistently", async () => {
    const c = await setup(); const e = await addEmployee(c, "Pat Worker");
    await api().put(`${c.base}/employees/${e.employeeId}/salary-config`).set(c.owner.auth).send({ method: "hourly", rate: 100 }).expect(200);
    await att.punchIn(c.id, e.employeeId, new Date("2026-09-01T04:20:00Z")); await att.punchOut(c.id, e.employeeId, new Date("2026-09-01T14:20:00Z"));   // 10h, late
    await att.punchIn(c.id, e.employeeId, new Date("2026-09-02T04:05:00Z")); await att.punchOut(c.id, e.employeeId, new Date("2026-09-02T12:05:00Z"));   // 8h
    await api().post(`${c.base}/salary/generate`).set(c.owner.auth).send({ employeeId: e.employeeId, periodStart: "2026-09-01", periodEnd: "2026-09-30" }).expect(201);
    const q = "?from=2026-09-01&to=2026-09-30";
    expect((await rep(c, "attendance", q).expect(200)).body.rows[0]).toMatchObject({ employee: "Pat Worker", daysPresent: 2, hoursWorked: 18, lateDays: 1 });
    const wh = (await rep(c, "working-hours", q).expect(200)).body;
    expect(wh.rows[0]).toMatchObject({ days: 2, hours: 18, avgPerDay: 9, overtimeHours: 2 }); expect(wh.summary).toEqual({ totalHours: 18, totalOvertimeHours: 2 });
    const sal = (await rep(c, "salary", q).expect(200)).body;
    expect(sal.rows[0]).toMatchObject({ employee: "Pat Worker", periodStart: "2026-09-01", basePay: 1600, overtimePay: 300, netPay: 1900, status: "draft" });
    expect(sal.summary).toEqual({ records: 1, totalNetPay: 1900, paid: 0 });
    expect((await rep(c, "salary", "?from=2026-10-01&to=2026-10-31").expect(200)).body.rows).toEqual([]);
  });
});

describe("report exports", () => {
  it("exports CSV with proper quoting, a BOM, and defence against spreadsheet formulas", async () => {
    const c = await setup(); const p = await addProduct(c, { sellingPrice: 10, openingStock: 9 });
    for (const name of ['=HYPERLINK("http://evil.example","click")', "Smith, John", "+cmd|' /C calc'!A0"]) {
      const cu = (await api().post(`${c.base}/customers`).set(c.owner.auth).send({ name }).expect(201)).body.customer;
      const o = (await api().post(`${c.base}/orders`).set(c.owner.auth).send({ customerId: cu.id, items: [{ productId: p.id, quantity: 1 }] }).expect(201)).body.order;
      await walk(c, o.id);
    }
    const r = await rep(c, "sales", "?format=csv").expect(200);
    expect(r.headers["content-type"]).toContain("text/csv"); expect(r.headers["content-disposition"]).toMatch(/attachment; filename="sales_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv"/);
    const text = r.text;
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toContain("Order,Delivered,Customer,Status,Total,Refunds,Net");
    expect(text).toContain('"\'=HYPERLINK(""http://evil.example"",""click"")"');                    // neutralised and correctly escaped
    expect(text).toContain(",'+cmd|' /C calc'!A0,delivered");                                      // leading apostrophe defuses the formula
    expect(text).toContain('"Smith, John"');                                                        // commas are quoted, not mangled
    expect(text).not.toMatch(/,=HYPERLINK/);
    expect(text).toContain("netSales,30");
    const audit = (await api().get(`${c.base}/audit`).set(c.owner.auth)).body.entries;
    expect(audit.some((e: any) => e.action === "report.export" && e.metadata.format === "csv")).toBe(true);
  });

  it("exports a PDF", async () => {
    const { c } = await world();
    const r = await rep(c, "sales", "?format=pdf").buffer(true).parse(binary).expect(200);
    expect(r.headers["content-type"]).toBe("application/pdf");
    expect(r.headers["content-disposition"]).toMatch(/attachment; filename="sales_.*\.pdf"/);
    const buf = r.body as Buffer;
    expect(buf.subarray(0, 5).toString()).toBe("%PDF-"); expect(buf.length).toBeGreaterThan(1000);
    const empty = await rep(await setup(), "inventory", "?format=pdf").buffer(true).parse(binary).expect(200);   // no data still renders
    expect((empty.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
  });
});
