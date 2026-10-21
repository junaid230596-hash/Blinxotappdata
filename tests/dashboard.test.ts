import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api as _api, pool, resetDb } from "./helpers.js";
import { addEmployee, addMember, addProduct, setup } from "./factory.js";
import * as att from "../server/src/modules/attendance/attendance.service.js";

const api = _api;
beforeAll(resetDb);
afterAll(() => pool.end());

const dash = (c: any, u: any) => api().get(`${c.base}/dashboard`).set(u.auth);
const walk = async (c: any, id: string) => { for (const s of ["accepted", "processing", "ready", "delivered"]) await api().patch(`${c.base}/orders/${id}/status`).set(c.owner.auth).send({ status: s }).expect(200); };

async function busy() {
  const c = await setup(`Busy ${Date.now()}`); const e = await addEmployee(c, "Dash Worker");
  const rice = await addProduct(c, { name: "Rice", sellingPrice: 100, taxRate: 10, costPrice: 50, openingStock: 20, minStock: 25 });   // already low: 20 <= 25
  const cust = (await api().post(`${c.base}/customers`).set(c.owner.auth).send({ name: "Dash Customer" }).expect(201)).body.customer;
  await api().post(`${c.base}/customers`).set(c.owner.auth).send({ name: "Second" }).expect(201);
  const o1 = (await api().post(`${c.base}/orders`).set(c.owner.auth).send({ customerId: cust.id, items: [{ productId: rice.id, quantity: 2 }] }).expect(201)).body.order;   // 220
  await walk(c, o1.id);
  await api().post(`${c.base}/orders`).set(c.owner.auth).send({ items: [{ productId: rice.id, quantity: 1 }] }).expect(201);          // stays pending
  const sup = (await api().post(`${c.base}/suppliers`).set(c.owner.auth).send({ name: "Mill" }).expect(201)).body.supplier;
  const po = (await api().post(`${c.base}/purchases`).set(c.owner.auth).send({ supplierId: sup.id, items: [{ productId: rice.id, quantity: 5, unitCost: 40 }] }).expect(201)).body.purchase;
  await api().post(`${c.base}/purchases/${po.id}/send`).set(c.owner.auth).expect(200);
  await api().post(`${c.base}/me/punch-in`).set(e.auth).expect(201);
  const won = (await api().get(`${c.base}/crm/stages`).set(c.owner.auth)).body.stages.find((s: any) => s.kind === "won").id;
  await api().post(`${c.base}/crm/deals`).set(c.owner.auth).send({ title: "Open deal", value: 300 }).expect(201);
  await api().post(`${c.base}/crm/deals`).set(c.owner.auth).send({ title: "Won deal", value: 900, stageId: won }).expect(201);
  await api().post(`${c.base}/crm/leads`).set(c.owner.auth).send({ name: "New lead" }).expect(201);
  await api().post(`${c.base}/tasks`).set(c.owner.auth).send({ title: "Overdue chore", assignedTo: e.userId, dueDate: "2020-01-01" }).expect(201);
  await api().post(`${c.base}/tasks`).set(c.owner.auth).send({ title: "Someone else's", assignedTo: c.owner.id }).expect(201);
  const start = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
  await api().post(`${c.base}/me/leave`).set(e.auth).send({ type: "casual", startDate: start, endDate: start }).expect(201);
  return { c, e, rice };
}

describe("business dashboard", () => {
  it("summarises sales, orders, stock, people, tasks, CRM and activity for an owner", async () => {
    const { c } = await busy();
    const d = (await dash(c, c.owner).expect(200)).body;
    expect(d.sections).toEqual(expect.arrayContaining(["sales", "orders", "inventory", "purchasing", "customers", "people", "tasks", "crm", "leave", "recentActivity"]));
    expect(d.sales).toMatchObject({ revenueLast30Days: 220, revenuePrevious30Days: 0, revenueThisMonth: 220, salesLast30Days: 1 });
    expect(d.sales.trend).toHaveLength(14); expect(d.sales.trend.at(-1).total).toBe(220); expect(d.sales.trend[0].total).toBe(0);
    expect(d.orders).toMatchObject({ byStatus: { delivered: 1, pending: 1 }, open: 1, pending: 1 }); expect(d.orders.recent).toHaveLength(2);
    expect(d.orders.recent[0]).toMatchObject({ status: "pending", party: "Walk-in" });
    expect(d.inventory).toMatchObject({ products: 1, lowStockCount: 1, stockValue: 18 * 50 });
    expect(d.inventory.lowStock[0]).toMatchObject({ name: "Rice", stockQty: 18, minStock: 25 });
    expect(d.purchasing).toEqual({ pendingPurchases: 1, purchasedLast30Days: 200, suppliers: 1 });
    expect(d.customers.total).toBe(2);
    expect(d.people).toMatchObject({ employees: 1, presentToday: 1, clockedInNow: 1, onLeaveToday: 0 });
    expect(d.tasks).toEqual({ open: 2, overdue: 1, scope: "all" });
    expect(d.crm).toEqual({ openDeals: 1, openPipelineValue: 300, wonThisMonth: 900, newLeads: 1 });
    expect(d.leave.pendingRequests).toBe(1);
    expect(d.recentActivity.length).toBeGreaterThan(5); expect(d.recentActivity[0]).toHaveProperty("action");
    expect(typeof d.unreadNotifications).toBe("number");
  });

  it("only returns the sections a role is allowed to open", async () => {
    const { c, e } = await busy(); const mgr = await addMember(c, "Manager");
    const emp = (await dash(c, e).expect(200)).body;
    expect(emp.sections.sort()).toEqual(["inventory", "tasks"]);                                    // Employee role: inventory.view + tasks.view only
    expect(emp.inventory.stockValue).toBeUndefined();                                               // cost data needs reports.view
    expect(emp.tasks).toEqual({ open: 1, overdue: 1, scope: "mine" });                              // only their own task
    expect(emp.sales).toBeUndefined(); expect(emp.crm).toBeUndefined(); expect(emp.recentActivity).toBeUndefined();
    const m = (await dash(c, mgr).expect(200)).body;
    expect(m.sections).toEqual(expect.arrayContaining(["sales", "orders", "inventory", "crm", "leave"]));
    expect(m.inventory.stockValue).toBe(900);                                                       // managers have reports.view
    expect(m.recentActivity).toBeUndefined();                                                       // audit.view is owner/admin only
    expect(m.tasks.scope).toBe("all");
  });

  it("is private to members", async () => {
    const a = await setup(); const b = await setup();
    await api().get(`${a.base}/dashboard`).expect(401);
    await dash(a, b.owner).expect(404);
    const d = (await dash(b, b.owner).expect(200)).body;
    expect(d.sales.revenueLast30Days).toBe(0); expect(d.people.employees).toBe(0);                  // a new business starts empty
  });

  it("counts only revenue from the last 30 days and shows decline against the prior period", async () => {
    const c = await setup(); const p = await addProduct(c, { sellingPrice: 100, openingStock: 9 });
    const mk = async () => { const o = (await api().post(`${c.base}/orders`).set(c.owner.auth).send({ items: [{ productId: p.id, quantity: 1 }] }).expect(201)).body.order; await walk(c, o.id); return o.id; };
    const recent = await mk(); const old = await mk();
    await pool.query("UPDATE orders SET delivered_at = now() - interval '45 days' WHERE id=$1", [old]);
    const d = (await dash(c, c.owner)).body;
    expect(d.sales).toMatchObject({ revenueLast30Days: 100, revenuePrevious30Days: 100, salesLast30Days: 1 });
    void recent;
  });
});

describe("employee dashboard", () => {
  it("shows today's attendance, month hours, own tasks, pay, leave and reviews", async () => {
    const c = await setup(); const e = await addEmployee(c, "Self Service"); const mgr = await addMember(c, "Manager");
    const me = () => api().get(`${c.base}/me/dashboard`).set(e.auth).expect(200);
    let d = (await me()).body;
    expect(d.attendance).toMatchObject({ punchedIn: false, minutesToday: 0 }); expect(d.tasks).toMatchObject({ open: 0, next: [] }); expect(d.latestPay).toBeNull();
    expect(d.leave).toEqual({ pending: 0, nextApprovedStart: null }); expect(d.unacknowledgedReviews).toBe(0);
    await api().post(`${c.base}/me/punch-in`).set(e.auth).expect(201);
    await api().post(`${c.base}/tasks`).set(c.owner.auth).send({ title: "Later task", assignedTo: e.userId, dueDate: "2099-01-01" }).expect(201);
    await api().post(`${c.base}/tasks`).set(c.owner.auth).send({ title: "Sooner task", assignedTo: e.userId, dueDate: "2098-01-01", priority: "high" }).expect(201);
    await api().post(`${c.base}/tasks`).set(c.owner.auth).send({ title: "Not mine", assignedTo: c.owner.id }).expect(201);
    d = (await me()).body;
    expect(d.attendance.punchedIn).toBe(true); expect(d.attendance.since).not.toBeNull();
    expect(d.tasks.open).toBe(2); expect(d.tasks.next.map((t: any) => t.title)).toEqual(["Sooner task", "Later task"]);   // soonest due first, own tasks only
    // pay statement appears only once finalized
    await api().put(`${c.base}/employees/${e.employeeId}/salary-config`).set(c.owner.auth).send({ method: "hourly", rate: 100 }).expect(200);
    await att.punchOut(c.id, e.employeeId, new Date(Date.now() + 3600_000)).catch(() => null);
    await pool.query("INSERT INTO salary_records (business_id, employee_id, period_start, period_end, method, hours_worked, days_worked, overtime_hours, late_count, base_pay, overtime_pay, net_pay, status) VALUES ($1,$2,'2026-09-01','2026-09-30','hourly',10,1,0,0,1000,0,1000,'draft')", [c.id, e.employeeId]);
    expect((await me()).body.latestPay).toBeNull();                                                  // drafts stay private
    await pool.query("UPDATE salary_records SET status='finalized' WHERE employee_id=$1", [e.employeeId]);
    expect((await me()).body.latestPay).toEqual({ periodStart: "2026-09-01", periodEnd: "2026-09-30", netPay: 1000, status: "finalized" });
    // reviews and leave
    const r = (await api().post(`${c.base}/performance`).set(mgr.auth).send({ employeeId: e.employeeId, periodStart: "2026-01-01", periodEnd: "2026-06-30", rating: 4 }).expect(201)).body.review;
    expect((await me()).body.unacknowledgedReviews).toBe(0);                                         // drafts do not count
    await api().post(`${c.base}/performance/${r.id}/share`).set(mgr.auth).expect(200);
    expect((await me()).body.unacknowledgedReviews).toBe(1);
    await api().post(`${c.base}/me/performance/${r.id}/acknowledge`).set(e.auth).expect(200);
    expect((await me()).body.unacknowledgedReviews).toBe(0);
    const start = new Date(Date.now() + 9 * 86_400_000).toISOString().slice(0, 10);
    const l = (await api().post(`${c.base}/me/leave`).set(e.auth).send({ type: "sick", startDate: start, endDate: start }).expect(201)).body.leave;
    expect((await me()).body.leave).toEqual({ pending: 1, nextApprovedStart: null });
    await api().patch(`${c.base}/leave/${l.id}/decision`).set(c.owner.auth).send({ decision: "approved" }).expect(200);
    expect((await me()).body.leave).toEqual({ pending: 0, nextApprovedStart: start });
    await api().get(`${c.base}/me/dashboard`).set(c.owner.auth).expect(403);                        // owners use the business dashboard
    await api().get(`${c.base}/me/dashboard`).expect(401);
  });
});
