import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, PASSWORD, pool, registerUser, resetDb, tokenFromMail } from "./helpers.js";
import * as att from "../server/src/modules/attendance/attendance.service.js";
import { outbox } from "../server/src/lib/email.js";

beforeAll(resetDb);
afterAll(() => pool.end());

let n = 0;
async function setup() {
  const owner = await registerUser();
  const biz = (await api().post("/api/businesses").set(owner.auth).send({ name: `Co ${++n} ${Date.now()}` }).expect(201)).body.business;
  return { owner, biz, base: `/api/businesses/${biz.id}` };
}
async function addEmployee(ctx: { owner: any; base: string }, name = "Emp One", extra: any = {}) {
  const email = `emp${++n}_${Date.now()}@example.com`;
  const r = await api().post(`${ctx.base}/employees`).set(ctx.owner.auth).send({ email, fullName: name, position: "Cashier", ...extra }).expect(201);
  await api().post("/api/auth/reset-password").send({ token: tokenFromMail(email), password: PASSWORD }).expect(200);
  const l = await api().post("/api/auth/login").send({ email, password: PASSWORD }).expect(200);
  return { employeeId: r.body.employee.id as string, userId: l.body.user.id as string, email, auth: { Authorization: `Bearer ${l.body.accessToken}` }, user: l.body.user };
}
const utc = (s: string) => new Date(s);

describe("employee management", () => {
  it("creates an employee who gets an invite, sets a password, and logs in as a verified employee", async () => {
    const ctx = await setup();
    const e = await addEmployee(ctx, "Riya Sharma");
    expect(e.user.accountType).toBe("employee");
    expect(e.user.emailVerified).toBe(true);
    expect(outbox.some((m) => m.to === e.email && /added you as an employee/.test(m.text))).toBe(true);
    const mine = await api().get("/api/businesses/mine").set(e.auth).expect(200);
    expect(mine.body.businesses[0].role).toBe("Employee");
    const n2 = await api().get("/api/notifications").set(e.auth).expect(200);
    expect(n2.body.notifications.some((x: any) => x.type === "employee.invited")).toBe(true);
  });

  it("rejects duplicate emails, bad input, and non-privileged creators", async () => {
    const ctx = await setup();
    const e = await addEmployee(ctx);
    await api().post(`${ctx.base}/employees`).set(ctx.owner.auth).send({ email: e.email, fullName: "Dup" }).expect(409);
    await api().post(`${ctx.base}/employees`).set(ctx.owner.auth).send({ email: "bad", fullName: "" }).expect(400);
    await api().post(`${ctx.base}/employees`).set(e.auth).send({ email: "x@example.com", fullName: "X" }).expect(403);
  });

  it("isolates tenants: another business cannot read, edit, delete or configure my employee", async () => {
    const a = await setup(); const b = await setup();
    const e = await addEmployee(a);
    await api().get(`${b.base}/employees/${e.employeeId}`).set(b.owner.auth).expect(404);
    await api().patch(`${b.base}/employees/${e.employeeId}`).set(b.owner.auth).send({ position: "X" }).expect(404);
    await api().delete(`${b.base}/employees/${e.employeeId}`).set(b.owner.auth).expect(404);
    await api().put(`${b.base}/employees/${e.employeeId}/salary-config`).set(b.owner.auth).send({ method: "hourly", rate: 1 }).expect(404);
    await api().get(`${a.base}/employees`).set(b.owner.auth).expect(404);
  });

  it("keeps owner-only data away from employees", async () => {
    const ctx = await setup();
    const e1 = await addEmployee(ctx, "A"); const e2 = await addEmployee(ctx, "B");
    await api().get(`${ctx.base}/employees`).set(e1.auth).expect(403);
    await api().get(`${ctx.base}/employees/${e2.employeeId}`).set(e1.auth).expect(403);
    await api().get(`${ctx.base}/salary`).set(e1.auth).expect(403);
    await api().put(`${ctx.base}/employees/${e1.employeeId}/salary-config`).set(e1.auth).send({ method: "monthly", rate: 999999 }).expect(403);
    await api().get(`${ctx.base}/attendance`).set(e1.auth).expect(403);
    await api().get(`${ctx.base}/attendance/report?month=2026-09`).set(e1.auth).expect(403);
  });

  it("lists with search + pagination, hides salary without salary.view, updates and deactivates", async () => {
    const ctx = await setup();
    await addEmployee(ctx, "Zed Zebra", { department: "Sales" });
    await addEmployee(ctx, "Amy Apple", { department: "Ops" });
    const all = await api().get(`${ctx.base}/employees?limit=1`).set(ctx.owner.auth).expect(200);
    expect(all.body.total).toBe(2); expect(all.body.employees).toHaveLength(1); expect(all.body.employees[0].fullName).toBe("Amy Apple");
    const s = await api().get(`${ctx.base}/employees?q=sales`).set(ctx.owner.auth).expect(200);
    expect(s.body.employees.map((x: any) => x.fullName)).toEqual(["Zed Zebra"]);
    const id = s.body.employees[0].id;
    const upd = await api().patch(`${ctx.base}/employees/${id}`).set(ctx.owner.auth).send({ position: "Lead" }).expect(200);
    expect(upd.body.employee.position).toBe("Lead");
    expect(upd.body.employee.salaryConfig).toBeUndefined(); // update response never includes salary
  });
});

describe("attendance", () => {
  it("punches in/out via the API with server timestamps; blocks duplicates and invalid punches", async () => {
    const ctx = await setup(); const e = await addEmployee(ctx);
    const me = `${ctx.base}/me`;
    await api().post(`${me}/punch-out`).set(e.auth).expect(409);                 // not punched in
    const pin = await api().post(`${me}/punch-in`).set(e.auth).send({ punchIn: "2000-01-01T00:00:00Z" }).expect(201); // client time ignored
    expect(new Date(pin.body.record.punchIn).getFullYear()).toBeGreaterThan(2000);
    await api().post(`${me}/punch-in`).set(e.auth).expect(409);                  // duplicate
    expect((await api().get(`${me}/today`).set(e.auth)).body.punchedIn).toBe(true);
    const pout = await api().post(`${me}/punch-out`).set(e.auth).expect(200);
    expect(pout.body.record.minutesWorked).toBeGreaterThanOrEqual(1);
    await api().post(`${me}/punch-in`).set(e.auth).expect(429);                  // double-tap cooldown
    expect((await api().get(`${me}/today`).set(e.auth)).body.punchedIn).toBe(false);
  });

  it("allows only one winner when punch-in is fired concurrently", async () => {
    const ctx = await setup(); const e = await addEmployee(ctx);
    const results = await Promise.all(Array.from({ length: 6 }, () => api().post(`${ctx.base}/me/punch-in`).set(e.auth)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM attendance WHERE employee_id=$1", [e.employeeId]);
    expect(rows[0].n).toBe(1);
  });

  it("computes hours, late arrival and early departure in the business timezone (IST default)", async () => {
    const ctx = await setup(); const e = await addEmployee(ctx);
    // 04:20Z = 09:50 IST -> after 09:30 + 10min grace => late. 11:30Z = 17:00 IST < 18:00 => early.
    const a = await att.punchIn(ctx.biz.id, e.employeeId, utc("2026-09-01T04:20:00Z"));
    expect(a.isLate).toBe(true); expect(a.workDate).toBe("2026-09-01");
    const b = await att.punchOut(ctx.biz.id, e.employeeId, utc("2026-09-01T11:30:00Z"));
    expect(b.minutesWorked).toBe(430); expect(b.leftEarly).toBe(true);
    // second session same day is never "late"
    const c = await att.punchIn(ctx.biz.id, e.employeeId, utc("2026-09-01T12:00:00Z"));
    expect(c.isLate).toBe(false);
    // within grace (09:39 IST = 04:09Z) is not late
    const d0 = await att.punchIn(ctx.biz.id, (await addEmployee(ctx)).employeeId, utc("2026-09-02T04:09:00Z"));
    expect(d0.isLate).toBe(false);
    // timezone matters: 23:00Z on Sep 1 is 04:30 IST on Sep 2 -> belongs to Sep 2
    const e2 = await addEmployee(ctx);
    const tz = await att.punchIn(ctx.biz.id, e2.employeeId, utc("2026-09-01T23:00:00Z"));
    expect(tz.workDate).toBe("2026-09-02");
  });

  it("rejects an invalid (non-increasing) punch-out time", async () => {
    const ctx = await setup(); const e = await addEmployee(ctx);
    await att.punchIn(ctx.biz.id, e.employeeId, utc("2026-09-03T05:00:00Z"));
    await expect(att.punchOut(ctx.biz.id, e.employeeId, utc("2026-09-03T04:00:00Z"))).rejects.toThrow(/Invalid punch-out/);
  });

  it("lets managers fix a forgotten punch-out, rejecting overlaps and future times", async () => {
    const ctx = await setup(); const e = await addEmployee(ctx);
    const open = await att.punchIn(ctx.biz.id, e.employeeId, utc("2026-09-04T04:00:00Z"));
    const fixed = await api().patch(`${ctx.base}/attendance/${open.id}`).set(ctx.owner.auth).send({ punchOut: "2026-09-04T12:30:00Z" }).expect(200);
    expect(fixed.body.record.minutesWorked).toBe(510);
    expect(fixed.body.record.isLate).toBe(false);
    await api().patch(`${ctx.base}/attendance/${open.id}`).set(e.auth).send({ punchOut: "2026-09-04T13:00:00Z" }).expect(403);
    await api().patch(`${ctx.base}/attendance/${open.id}`).set(ctx.owner.auth).send({ punchOut: "2026-09-04T03:00:00Z" }).expect(400);
    await api().patch(`${ctx.base}/attendance/${open.id}`).set(ctx.owner.auth).send({ punchOut: "2999-01-01T00:00:00Z" }).expect(400);
    const second = await att.punchIn(ctx.biz.id, e.employeeId, utc("2026-09-04T13:00:00Z"));
    await att.punchOut(ctx.biz.id, e.employeeId, utc("2026-09-04T14:00:00Z"));
    await api().patch(`${ctx.base}/attendance/${second.id}`).set(ctx.owner.auth).send({ punchIn: "2026-09-04T12:00:00Z" }).expect(409); // overlaps first
    const audits = await api().get(`${ctx.base}/audit`).set(ctx.owner.auth).expect(200);
    expect(audits.body.entries.some((x: any) => x.action === "attendance.correct")).toBe(true);
  });

  it("reports monthly attendance per employee and for the employee themself", async () => {
    const ctx = await setup(); const e = await addEmployee(ctx, "Rep Orter"); await addEmployee(ctx, "No Show");
    await att.punchIn(ctx.biz.id, e.employeeId, utc("2026-08-03T04:20:00Z")); await att.punchOut(ctx.biz.id, e.employeeId, utc("2026-08-03T12:50:00Z")); // 18:20 IST, not early
    await att.punchIn(ctx.biz.id, e.employeeId, utc("2026-08-04T04:00:00Z")); await att.punchOut(ctx.biz.id, e.employeeId, utc("2026-08-04T11:00:00Z"));
    const rep = await api().get(`${ctx.base}/attendance/report?month=2026-08`).set(ctx.owner.auth).expect(200);
    const row = rep.body.employees.find((x: any) => x.fullName === "Rep Orter");
    expect(row).toMatchObject({ daysPresent: 2, hoursWorked: 15.5, lateDays: 1, earlyDepartureDays: 1 });
    expect(rep.body.employees.find((x: any) => x.fullName === "No Show").daysPresent).toBe(0);
    const mine = await api().get(`${ctx.base}/me/attendance?month=2026-08`).set(e.auth).expect(200);
    expect(mine.body.summary).toEqual({ daysPresent: 2, hoursWorked: 15.5, lateDays: 1 });
    await api().get(`${ctx.base}/attendance/report`).set(ctx.owner.auth).expect(400);
    const list = await api().get(`${ctx.base}/attendance?from=2026-08-01&to=2026-08-31&employeeId=${e.employeeId}`).set(ctx.owner.auth).expect(200);
    expect(list.body.total).toBe(2);
  });

  it("honours custom business settings and validates them", async () => {
    const ctx = await setup(); const e = await addEmployee(ctx);
    await api().put(`${ctx.base}/attendance-settings`).set(e.auth).send({ timezone: "UTC", workStart: "08:00", workEnd: "16:00", lateGraceMinutes: 0 }).expect(403);
    await api().put(`${ctx.base}/attendance-settings`).set(ctx.owner.auth).send({ timezone: "Mars/Base", workStart: "08:00", workEnd: "16:00", lateGraceMinutes: 0 }).expect(400);
    await api().put(`${ctx.base}/attendance-settings`).set(ctx.owner.auth).send({ timezone: "UTC", workStart: "25:00", workEnd: "16:00", lateGraceMinutes: 0 }).expect(400);
    await api().put(`${ctx.base}/attendance-settings`).set(ctx.owner.auth).send({ timezone: "UTC", workStart: "08:00", workEnd: "16:00", lateGraceMinutes: 0 }).expect(200);
    expect((await api().get(`${ctx.base}/attendance-settings`).set(e.auth).expect(200)).body.settings.timezone).toBe("UTC");
    expect((await att.punchIn(ctx.biz.id, e.employeeId, utc("2026-09-05T08:01:00Z"))).isLate).toBe(true);
  });

  it("removes access on deactivation, closes open punches, and keeps history", async () => {
    const ctx = await setup(); const e = await addEmployee(ctx);
    await att.punchIn(ctx.biz.id, e.employeeId, utc("2026-09-06T04:00:00Z"));
    await api().delete(`${ctx.base}/employees/${e.employeeId}`).set(ctx.owner.auth).expect(200);
    await api().get(`${ctx.base}`).set(e.auth).expect(404);
    await api().post(`${ctx.base}/me/punch-in`).set(e.auth).expect(404);
    const { rows } = await pool.query("SELECT punch_out FROM attendance WHERE employee_id=$1", [e.employeeId]);
    expect(rows[0].punch_out).not.toBeNull();
  });
});

describe("salary", () => {
  it("generates from attendance with the configured model, then follows the draft→finalized→paid lifecycle", async () => {
    const ctx = await setup(); const e = await addEmployee(ctx, "Pay Me");
    await api().post(`${ctx.base}/salary/generate`).set(ctx.owner.auth)
      .send({ employeeId: e.employeeId, periodStart: "2026-09-01", periodEnd: "2026-09-30" }).expect(400); // no config yet
    await api().put(`${ctx.base}/employees/${e.employeeId}/salary-config`).set(ctx.owner.auth)
      .send({ method: "hourly", rate: 100, latePenalty: 50 }).expect(200);
    // day1: 10h, late. day2: 8h, on time  => 16 regular h, 2 OT h, 1 late
    await att.punchIn(ctx.biz.id, e.employeeId, utc("2026-09-01T04:20:00Z")); await att.punchOut(ctx.biz.id, e.employeeId, utc("2026-09-01T14:20:00Z"));
    await att.punchIn(ctx.biz.id, e.employeeId, utc("2026-09-02T04:05:00Z")); await att.punchOut(ctx.biz.id, e.employeeId, utc("2026-09-02T12:05:00Z"));
    const body = { employeeId: e.employeeId, periodStart: "2026-09-01", periodEnd: "2026-09-30", bonus: 100, deductions: 25 };
    const prev = await api().post(`${ctx.base}/salary/preview`).set(ctx.owner.auth).send(body).expect(200);
    expect(prev.body.calculation).toMatchObject({ hoursWorked: 18, overtimeHours: 2, basePay: 1600, overtimePay: 300, lateDeductions: 50, netPay: 1925 });
    expect(prev.body.saved).toBeNull();
    expect((await api().get(`${ctx.base}/salary`).set(ctx.owner.auth)).body.total).toBe(0); // preview saved nothing

    const gen = await api().post(`${ctx.base}/salary/generate`).set(ctx.owner.auth).send(body).expect(201);
    const rec = gen.body.saved;
    expect(rec).toMatchObject({ status: "draft", netPay: 1925, employeeName: "Pay Me", periodStart: "2026-09-01" });
    // regenerating a draft updates it in place (bonus change)
    const again = await api().post(`${ctx.base}/salary/generate`).set(ctx.owner.auth).send({ ...body, bonus: 200 }).expect(201);
    expect(again.body.saved.id).toBe(rec.id); expect(again.body.saved.netPay).toBe(2025);

    // employee cannot see drafts
    expect((await api().get(`${ctx.base}/me/salary`).set(e.auth).expect(200)).body.records).toHaveLength(0);
    await api().patch(`${ctx.base}/salary/${rec.id}/status`).set(ctx.owner.auth).send({ status: "paid" }).expect(400); // skip step
    await api().patch(`${ctx.base}/salary/${rec.id}/status`).set(e.auth).send({ status: "finalized" }).expect(403);
    await api().patch(`${ctx.base}/salary/${rec.id}/status`).set(ctx.owner.auth).send({ status: "finalized" }).expect(200);
    await api().post(`${ctx.base}/salary/generate`).set(ctx.owner.auth).send(body).expect(409);  // locked
    const mine = await api().get(`${ctx.base}/me/salary`).set(e.auth).expect(200);
    expect(mine.body.records).toHaveLength(1); expect(mine.body.records[0].netPay).toBe(2025);
    await api().patch(`${ctx.base}/salary/${rec.id}/status`).set(ctx.owner.auth).send({ status: "paid" }).expect(200);
    await api().patch(`${ctx.base}/salary/${rec.id}/status`).set(ctx.owner.auth).send({ status: "finalized" }).expect(400);
    const notes = (await api().get("/api/notifications").set(e.auth)).body.notifications.map((x: any) => x.type);
    expect(notes).toEqual(expect.arrayContaining(["salary.finalized", "salary.paid"]));
  });

  it("supports daily and monthly models and rejects bad periods; salary stays private across tenants", async () => {
    const a = await setup(); const b = await setup(); const e = await addEmployee(a);
    await api().put(`${a.base}/employees/${e.employeeId}/salary-config`).set(a.owner.auth).send({ method: "monthly", rate: 26000 }).expect(200);
    await api().put(`${a.base}/employees/${e.employeeId}/salary-config`).set(a.owner.auth).send({ method: "weekly", rate: 1 }).expect(400);
    await att.punchIn(a.biz.id, e.employeeId, utc("2026-10-01T04:00:00Z")); await att.punchOut(a.biz.id, e.employeeId, utc("2026-10-01T12:00:00Z"));
    const r = await api().post(`${a.base}/salary/preview`).set(a.owner.auth).send({ employeeId: e.employeeId, periodStart: "2026-10-01", periodEnd: "2026-10-31" }).expect(200);
    expect(r.body.calculation).toMatchObject({ method: "monthly", daysWorked: 1, basePay: 1000 });
    await api().post(`${a.base}/salary/preview`).set(a.owner.auth).send({ employeeId: e.employeeId, periodStart: "2026-10-31", periodEnd: "2026-10-01" }).expect(400);
    await api().post(`${a.base}/salary/preview`).set(a.owner.auth).send({ employeeId: e.employeeId, periodStart: "2024-01-01", periodEnd: "2026-10-01" }).expect(400);
    await api().post(`${b.base}/salary/preview`).set(b.owner.auth).send({ employeeId: e.employeeId, periodStart: "2026-10-01", periodEnd: "2026-10-31" }).expect(404);
    const open = await att.punchIn(a.biz.id, e.employeeId, utc("2026-10-05T04:00:00Z"));
    const r2 = await api().post(`${a.base}/salary/preview`).set(a.owner.auth).send({ employeeId: e.employeeId, periodStart: "2026-10-01", periodEnd: "2026-10-31" }).expect(200);
    expect(r2.body.openSessions).toBe(1); void open;
  });
});

describe("tasks", () => {
  it("scopes visibility: employees see only their own tasks; managers see all", async () => {
    const ctx = await setup(); const e1 = await addEmployee(ctx, "T One"); const e2 = await addEmployee(ctx, "T Two");
    const t1 = (await api().post(`${ctx.base}/tasks`).set(ctx.owner.auth).send({ title: "For one", assignedTo: e1.userId, priority: "high", dueDate: "2026-12-01" }).expect(201)).body.task;
    const t2 = (await api().post(`${ctx.base}/tasks`).set(ctx.owner.auth).send({ title: "For two", assignedTo: e2.userId }).expect(201)).body.task;
    expect(t1.assigneeName).toBe("T One");
    expect((await api().get(`${ctx.base}/tasks`).set(ctx.owner.auth)).body.total).toBe(2);
    const mine = await api().get(`${ctx.base}/tasks`).set(e1.auth).expect(200);
    expect(mine.body.tasks.map((t: any) => t.title)).toEqual(["For one"]);
    await api().get(`${ctx.base}/tasks/${t2.id}`).set(e1.auth).expect(404);
    await api().patch(`${ctx.base}/tasks/${t2.id}`).set(e1.auth).send({ status: "review" }).expect(404);
    await api().post(`${ctx.base}/tasks/${t2.id}/comments`).set(e1.auth).send({ body: "hi" }).expect(404);
    // asking for someone else's tasks via the filter doesn't bypass scoping
    expect((await api().get(`${ctx.base}/tasks?assignedTo=${e2.userId}`).set(e1.auth)).body.total).toBe(1);
    await api().post(`${ctx.base}/tasks`).set(e1.auth).send({ title: "self-assign" }).expect(403);
    const n1 = (await api().get("/api/notifications").set(e1.auth)).body.notifications;
    expect(n1.some((x: any) => x.type === "task.assigned")).toBe(true);
  });

  it("limits assignees to status moves; managers complete and everything is logged", async () => {
    const ctx = await setup(); const e = await addEmployee(ctx);
    const t = (await api().post(`${ctx.base}/tasks`).set(ctx.owner.auth).send({ title: "Stock count", assignedTo: e.userId }).expect(201)).body.task;
    const url = `${ctx.base}/tasks/${t.id}`;
    await api().patch(url).set(e.auth).send({ title: "Renamed" }).expect(403);
    await api().patch(url).set(e.auth).send({ status: "completed" }).expect(403);
    await api().patch(url).set(e.auth).send({ status: "in_progress" }).expect(200);
    await api().patch(url).set(e.auth).send({ status: "review" }).expect(200);
    expect(((await api().get("/api/notifications").set(ctx.owner.auth)).body.notifications).some((x: any) => x.type === "task.review")).toBe(true);
    const done = await api().patch(url).set(ctx.owner.auth).send({ status: "completed", priority: "low" }).expect(200);
    expect(done.body.task.completedAt).not.toBeNull();
    const reopened = await api().patch(url).set(ctx.owner.auth).send({ status: "todo" }).expect(200);
    expect(reopened.body.task.completedAt).toBeNull();
    const withC = await api().post(`${url}/comments`).set(e.auth).send({ body: "Counted 40 boxes" }).expect(201);
    expect(withC.body.task.comments[0]).toMatchObject({ body: "Counted 40 boxes", authorName: "Emp One" });
    const actions = withC.body.task.activity.map((a: any) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["created", "status_changed", "priority_changed", "commented"]));
    await api().patch(url).set(ctx.owner.auth).send({}).expect(400);
    await api().patch(url).set(ctx.owner.auth).send({ status: "bogus" }).expect(400);
  });

  it("validates assignees and attachments", async () => {
    const a = await setup(); const b = await setup(); const outsider = await addEmployee(b);
    const e = await addEmployee(a);
    await api().post(`${a.base}/tasks`).set(a.owner.auth).send({ title: "X", assignedTo: outsider.userId }).expect(400); // not a member
    const t = (await api().post(`${a.base}/tasks`).set(a.owner.auth).send({ title: "Doc", assignedTo: e.userId }).expect(201)).body.task;
    await api().post(`${a.base}/tasks/${t.id}/attachments`).set(e.auth).send({ url: "https://evil.example/x.png", name: "x" }).expect(400);
    await api().post(`${a.base}/tasks/${t.id}/attachments`).set(e.auth).send({ url: "/uploads/../../etc/passwd", name: "x" }).expect(400);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    const up = await api().post("/api/uploads").set(e.auth).attach("file", png, "proof.png").expect(201);
    const att2 = await api().post(`${a.base}/tasks/${t.id}/attachments`).set(e.auth).send({ url: up.body.url, name: "proof.png" }).expect(201);
    expect(att2.body.task.attachments).toHaveLength(1);
    // other business's owner can't touch it
    await api().get(`${b.base}/tasks/${t.id}`).set(b.owner.auth).expect(404);
    await api().patch(`${b.base}/tasks/${t.id}`).set(b.owner.auth).send({ status: "cancelled" }).expect(404);
    // overdue filter + pagination
    await api().post(`${a.base}/tasks`).set(a.owner.auth).send({ title: "Late one", dueDate: "2020-01-01" }).expect(201);
    expect((await api().get(`${a.base}/tasks?overdue=true`).set(a.owner.auth)).body.tasks.map((x: any) => x.title)).toEqual(["Late one"]);
  });
});
