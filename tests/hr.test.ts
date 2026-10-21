import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api as _api, pool, resetDb } from "./helpers.js";
import { addEmployee, addMember, ensureTinyPlan, putOnPlan, setup } from "./factory.js";
import { privateDir } from "../server/src/lib/upload.js";

const api = _api;
beforeAll(async () => { await resetDb(); await ensureTinyPlan(); });
afterAll(() => pool.end());

const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const ask = (e: any, c: any, b: any) => api().post(`${c.base}/me/leave`).set(e.auth).send({ type: "casual", ...b });

describe("leave", () => {
  it("lets employees request leave, and managers approve or reject it with notifications", async () => {
    const c = await setup(); const e = await addEmployee(c, "Lea Ve"); const mgr = await addMember(c, "Manager");
    await ask(e, c, { startDate: day(10), endDate: day(9) }).expect(400);
    await ask(e, c, { startDate: day(10), endDate: day(110) }).expect(400);                          // > 90 days
    await ask(e, c, { startDate: day(-40), endDate: day(-39) }).expect(400);                         // too far in the past
    await ask(e, c, { startDate: "10-09-2026", endDate: "12-09-2026" }).expect(400);
    await api().post(`${c.base}/me/leave`).set(e.auth).send({ type: "holiday", startDate: day(10), endDate: day(11) }).expect(400);
    const l = (await ask(e, c, { startDate: day(10), endDate: day(12), reason: "Family event" }).expect(201)).body.leave;
    expect(l).toMatchObject({ days: 3, status: "pending", employeeName: "Lea Ve", reason: "Family event" });
    expect((await api().get("/api/notifications").set(c.owner.auth)).body.notifications.some((n: any) => n.type === "leave.requested")).toBe(true);
    await api().get(`${c.base}/leave`).set(e.auth).expect(403);
    expect((await api().get(`${c.base}/leave?status=pending`).set(mgr.auth).expect(200)).body.total).toBe(1);
    await api().patch(`${c.base}/leave/${l.id}/decision`).set(e.auth).send({ decision: "approved" }).expect(403);
    const ok = (await api().patch(`${c.base}/leave/${l.id}/decision`).set(mgr.auth).send({ decision: "approved", note: "Enjoy" }).expect(200)).body.leave;
    expect(ok).toMatchObject({ status: "approved", decisionNote: "Enjoy" });
    await api().patch(`${c.base}/leave/${l.id}/decision`).set(mgr.auth).send({ decision: "rejected" }).expect(409);       // decided once
    expect((await api().get("/api/notifications").set(e.auth)).body.notifications.some((n: any) => n.type === "leave.decision" && n.title.includes("approved"))).toBe(true);
    const mine = (await api().get(`${c.base}/me/leave`).set(e.auth).expect(200)).body;
    expect(mine.leave).toHaveLength(1); expect(Object.values(mine.approvedDaysThisYear).reduce((a: any, b: any) => a + b, 0)).toBe(3);
    expect((await api().get(`${c.base}/leave?from=${day(11)}&to=${day(11)}`).set(c.owner.auth)).body.total).toBe(1);        // range overlap filter
    expect((await api().get(`${c.base}/leave?from=${day(20)}&to=${day(30)}`).set(c.owner.auth)).body.total).toBe(0);
  });

  it("never allows overlapping leave, even for simultaneous requests, and frees dates when rejected or cancelled", async () => {
    const c = await setup(); const e = await addEmployee(c);
    const race = await Promise.all([1, 2, 3, 4].map(() => ask(e, c, { startDate: day(20), endDate: day(22) })));
    expect(race.filter((r) => r.status === 201)).toHaveLength(1);
    expect(race.filter((r) => r.status === 409)).toHaveLength(3);
    await ask(e, c, { startDate: day(22), endDate: day(24) }).expect(409);                           // shares day 22
    await ask(e, c, { startDate: day(23), endDate: day(24) }).expect(201);                           // adjacent is fine
    const first = (await api().get(`${c.base}/leave?status=pending&employeeId=${e.employeeId}`).set(c.owner.auth)).body.leave.find((x: any) => x.startDate === day(20));
    await api().patch(`${c.base}/leave/${first.id}/decision`).set(c.owner.auth).send({ decision: "rejected", note: "Busy week" }).expect(200);
    await ask(e, c, { startDate: day(21), endDate: day(21) }).expect(201);                           // rejected leave frees its days
    const mine = (await api().get(`${c.base}/me/leave`).set(e.auth)).body.leave;
    const mid = mine.find((x: any) => x.startDate === day(21));
    await api().post(`${c.base}/me/leave/${mid.id}/cancel`).set(e.auth).expect(200);
    await api().post(`${c.base}/me/leave/${mid.id}/cancel`).set(e.auth).expect(409);                 // already cancelled
    await ask(e, c, { startDate: day(21), endDate: day(21) }).expect(201);                           // cancelled leave frees its days too
    const other = await addEmployee(c);
    await ask(other, c, { startDate: day(20), endDate: day(22) }).expect(201);                       // another employee is unaffected
    await api().post(`${c.base}/me/leave/${first.id}/cancel`).set(other.auth).expect(404);          // cannot cancel someone else's
  });

  it("restricts cancelling approved leave to leave that has not started, and isolates tenants", async () => {
    const a = await setup(); const b = await setup(); const e = await addEmployee(a);
    const l = (await ask(e, a, { startDate: day(5), endDate: day(6) }).expect(201)).body.leave;
    await api().patch(`${b.base}/leave/${l.id}/decision`).set(b.owner.auth).send({ decision: "approved" }).expect(404);
    await api().get(`${b.base}/leave`).set(b.owner.auth).expect(200).then((r) => expect(r.body.total).toBe(0));
    await api().patch(`${a.base}/leave/${l.id}/decision`).set(a.owner.auth).send({ decision: "approved" }).expect(200);
    await api().post(`${a.base}/me/leave/${l.id}/cancel`).set(e.auth).expect(200);                   // approved but future: allowed
    expect((await api().get("/api/notifications").set(a.owner.auth)).body.notifications.some((n: any) => n.type === "leave.cancelled")).toBe(true);
    const started = (await ask(e, a, { startDate: day(-1), endDate: day(1) }).expect(201)).body.leave;
    await api().patch(`${a.base}/leave/${started.id}/decision`).set(a.owner.auth).send({ decision: "approved" }).expect(200);
    await api().post(`${a.base}/me/leave/${started.id}/cancel`).set(e.auth).expect(409);             // already under way
    await api().post(`${a.base}/me/leave`).set(a.owner.auth).send({ type: "casual", startDate: day(5), endDate: day(6) }).expect(403);   // owners have no employee profile
  });
});

describe("performance reviews", () => {
  it("runs draft → shared → acknowledged, keeping drafts private and shared reviews immutable", async () => {
    const c = await setup(); const e = await addEmployee(c, "Per Former"); const e2 = await addEmployee(c); const mgr = await addMember(c, "Manager");
    const body = { employeeId: e.employeeId, periodStart: "2026-01-01", periodEnd: "2026-06-30", rating: 4, strengths: "Reliable", improvements: "Speed", goals: "Lead a shift" };
    await api().post(`${c.base}/performance`).set(e.auth).send(body).expect(403);
    await api().post(`${c.base}/performance`).set(mgr.auth).send({ ...body, rating: 6 }).expect(400);
    await api().post(`${c.base}/performance`).set(mgr.auth).send({ ...body, periodEnd: "2025-01-01" }).expect(400);
    await api().post(`${c.base}/performance`).set(mgr.auth).send({ ...body, employeeId: "00000000-0000-4000-8000-000000000000" }).expect(404);
    const r = (await api().post(`${c.base}/performance`).set(mgr.auth).send(body).expect(201)).body.review;
    expect(r).toMatchObject({ status: "draft", rating: 4, employeeName: "Per Former", reviewerName: "Test User" });
    expect((await api().get(`${c.base}/me/performance`).set(e.auth)).body.reviews).toEqual([]);      // drafts are invisible to the employee
    expect((await api().patch(`${c.base}/performance/${r.id}`).set(mgr.auth).send({ rating: 5 }).expect(200)).body.review.rating).toBe(5);
    await api().post(`${c.base}/me/performance/${r.id}/acknowledge`).set(e.auth).expect(404);       // cannot acknowledge a draft
    const shared = (await api().post(`${c.base}/performance/${r.id}/share`).set(mgr.auth).expect(200)).body.review;
    expect(shared.status).toBe("shared"); expect(shared.sharedAt).not.toBeNull();
    await api().post(`${c.base}/performance/${r.id}/share`).set(mgr.auth).expect(409);
    await api().patch(`${c.base}/performance/${r.id}`).set(mgr.auth).send({ rating: 1 }).expect(409);
    await api().delete(`${c.base}/performance/${r.id}`).set(mgr.auth).expect(409);
    expect((await api().get("/api/notifications").set(e.auth)).body.notifications.some((n: any) => n.type === "performance.shared")).toBe(true);
    const mine = (await api().get(`${c.base}/me/performance`).set(e.auth)).body.reviews;
    expect(mine).toHaveLength(1); expect(mine[0].acknowledgedAt).toBeNull();
    expect((await api().post(`${c.base}/me/performance/${r.id}/acknowledge`).set(e.auth).expect(200)).body.review.acknowledgedAt).not.toBeNull();
    await api().post(`${c.base}/me/performance/${r.id}/acknowledge`).set(e2.auth).expect(404);       // another employee's review
    expect((await api().get(`${c.base}/me/performance`).set(e2.auth)).body.reviews).toEqual([]);
    await api().get(`${c.base}/performance`).set(e.auth).expect(403);
    expect((await api().get(`${c.base}/performance?status=shared&employeeId=${e.employeeId}`).set(mgr.auth)).body.total).toBe(1);
    const draft = (await api().post(`${c.base}/performance`).set(c.owner.auth).send(body).expect(201)).body.review;
    await api().delete(`${c.base}/performance/${draft.id}`).set(c.owner.auth).expect(200);
    await api().get(`${(await setup()).base}/performance/${draft.id}`).set((await setup()).owner.auth).expect(404);
  });

  it("stops anyone writing a review about themself", async () => {
    const c = await setup(); const mgr = await addMember(c, "Manager");
    // make the manager an employee of the business too
    await api().post(`${c.base}/employees`).set(c.owner.auth).send({ email: `x${Date.now()}@example.com`, fullName: "Someone" }).expect(201);
    const { rows } = await pool.query("INSERT INTO employees (business_id, user_id) VALUES ($1,$2) RETURNING id", [c.id, mgr.id]);
    await api().post(`${c.base}/performance`).set(mgr.auth).send({ employeeId: rows[0].id, periodStart: "2026-01-01", periodEnd: "2026-02-01", rating: 5 }).expect(403);
  });
});

describe("employee documents (private files)", () => {
  const upload = (c: any, e: any, who: any, over: any = {}) => {
    const r = api().post(`${c.base}/employees/${e.employeeId}/documents`).set(who.auth).field("name", over.name ?? "Employment contract").field("category", over.category ?? "contract");
    if (over.expiry) r.field("expiryDate", over.expiry);
    if (over.visible !== undefined) r.field("visibleToEmployee", String(over.visible));
    return over.noFile ? r : r.attach("file", over.buf ?? pdf, over.filename ?? "contract.pdf");
  };

  it("stores files privately, shares them only when asked, and serves them only to authorised people", async () => {
    const c = await setup(); const e = await addEmployee(c, "Doc Holder"); const e2 = await addEmployee(c); const mgr = await addMember(c, "Manager");
    await upload(c, e, e, {}).expect(403);                                                           // employees cannot upload
    await upload(c, e, mgr, {}).expect(403);                                                         // managers can view, not manage, documents
    const doc = (await upload(c, e, c.owner, { expiry: day(10) }).expect(201)).body.document;
    expect(doc).toMatchObject({ name: "Employment contract", category: "contract", mime: "application/pdf", visibleToEmployee: false, expiringSoon: true, originalName: "contract.pdf" });
    const { rows } = await pool.query("SELECT d.file_key, s.is_private FROM employee_documents d JOIN stored_files s ON s.id=d.stored_file_id WHERE d.id=$1", [doc.id]);
    expect(rows[0].is_private).toBe(true);
    expect(fs.existsSync(path.join(privateDir, rows[0].file_key))).toBe(true);
    await api().get(`/uploads/${rows[0].file_key}`).expect(404);                                     // never reachable through the public static route

    expect((await api().get(`${c.base}/me/documents`).set(e.auth)).body.documents).toEqual([]);      // hidden from the employee by default
    await api().get(`${c.base}/me/documents/${doc.id}/file`).set(e.auth).expect(404);
    const dl = await api().get(`${c.base}/employees/${e.employeeId}/documents/${doc.id}/file`).set(mgr.auth).buffer(true).parse((res, cb) => { const ch: Buffer[] = []; res.on("data", (d: Buffer) => ch.push(d)); res.on("end", () => cb(null, Buffer.concat(ch))); }).expect(200);
    expect(dl.headers["content-type"]).toBe("application/pdf"); expect(dl.headers["content-disposition"]).toMatch(/attachment; filename="Employment contract\.pdf"/);
    expect(dl.headers["x-content-type-options"]).toBe("nosniff"); expect(dl.headers["cache-control"]).toContain("no-store");
    expect((dl.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
    await api().get(`${c.base}/employees/${e.employeeId}/documents/${doc.id}/file`).set(e.auth).expect(403);   // the employee-facing route is /me/...

    await api().patch(`${c.base}/employees/${e.employeeId}/documents/${doc.id}`).set(c.owner.auth).send({ visibleToEmployee: true }).expect(200);
    expect((await api().get(`${c.base}/me/documents`).set(e.auth)).body.documents).toHaveLength(1);
    await api().get(`${c.base}/me/documents/${doc.id}/file`).set(e.auth).expect(200);
    await api().get(`${c.base}/me/documents/${doc.id}/file`).set(e2.auth).expect(404);               // another employee cannot read it
    expect((await api().get(`${c.base}/me/documents`).set(e2.auth)).body.documents).toEqual([]);
    await api().get(`${c.base}/employees/${e2.employeeId}/documents/${doc.id}/file`).set(c.owner.auth).expect(404);   // wrong employee in the URL
    const other = await setup();
    await api().get(`${other.base}/employees/${e.employeeId}/documents/${doc.id}/file`).set(other.owner.auth).expect(404);

    const soon = (await api().get(`${c.base}/documents/expiring?days=30`).set(mgr.auth).expect(200)).body.documents;
    expect(soon[0]).toMatchObject({ id: doc.id, employeeName: "Doc Holder" });
    expect((await api().get(`${c.base}/documents/expiring?days=5`).set(mgr.auth)).body.documents).toEqual([]);

    await api().delete(`${c.base}/employees/${e.employeeId}/documents/${doc.id}`).set(mgr.auth).expect(403);
    await api().delete(`${c.base}/employees/${e.employeeId}/documents/${doc.id}`).set(c.owner.auth).expect(200);
    expect(fs.existsSync(path.join(privateDir, rows[0].file_key))).toBe(false);                      // file and storage record are removed
    expect((await pool.query("SELECT count(*)::int AS n FROM stored_files WHERE file_key=$1", [rows[0].file_key])).rows[0].n).toBe(0);
  });

  it("validates uploads by content, not by name", async () => {
    const c = await setup(); const e = await addEmployee(c);
    await upload(c, e, c.owner, { buf: Buffer.from("MZ\x90\x00 not a document"), filename: "contract.pdf" }).expect(400);   // an exe named .pdf
    await upload(c, e, c.owner, { buf: Buffer.from("<?php echo 1; ?>"), filename: "id.png" }).expect(400);
    await upload(c, e, c.owner, { noFile: true }).expect(400);
    await upload(c, e, c.owner, { category: "selfie" }).expect(400);
    await upload(c, e, c.owner, { name: "" }).expect(400);
    await upload(c, e, c.owner, { buf: png, filename: "../../etc/passwd.png", name: "ID card", category: "id_proof" }).expect(201)
      .then((r) => expect(r.body.document.originalName).not.toMatch(/[\\/]/));    // path separators never survive in the stored name
    const names = (await pool.query("SELECT file_key FROM employee_documents WHERE employee_id=$1", [e.employeeId])).rows.map((r) => r.file_key);
    expect(names.every((k: string) => /^[0-9a-f-]{36}\.png$/.test(k))).toBe(true);                   // the client's filename never reaches the disk
    await api().post(`${c.base}/employees/00000000-0000-4000-8000-000000000000/documents`).set(c.owner.auth).field("name", "x").field("category", "other").attach("file", pdf, "a.pdf").expect(404);
  });

  it("counts documents against the business's storage plan", async () => {
    const c = await setup(); const e = await addEmployee(c); await putOnPlan(c, "tiny");
    const r = await upload(c, e, c.owner, {}).expect(403);
    expect(r.body.error).toMatchObject({ code: "PLAN_LIMIT", details: { resource: "storageMb" } });
    expect((await pool.query("SELECT count(*)::int AS n FROM employee_documents WHERE employee_id=$1", [e.employeeId])).rows[0].n).toBe(0);
    await putOnPlan(c, "starter");
    await upload(c, e, c.owner, {}).expect(201);
  });
});
