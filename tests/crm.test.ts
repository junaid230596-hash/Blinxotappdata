import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api as _api, pool, resetDb } from "./helpers.js";
import { addEmployee, setup } from "./factory.js";
import { sendDueReminders } from "../server/src/modules/crm/crm.service.js";

const api = _api;
beforeAll(resetDb);
afterAll(() => pool.end());

const post = (c: any, path: string, b: any) => api().post(`${c.base}/crm/${path}`).set(c.owner.auth).send(b);
const patch = (c: any, path: string, b: any) => api().patch(`${c.base}/crm/${path}`).set(c.owner.auth).send(b);
const get = (c: any, path: string) => api().get(`${c.base}/crm/${path}`).set(c.owner.auth);
const stages = async (c: any) => (await get(c, "stages").expect(200)).body.stages as any[];
const stageId = async (c: any, name: string) => (await stages(c)).find((s) => s.name === name).id as string;
const mk = async (c: any, path: string, b: any) => { const r = await post(c, path, b).expect(201); return Object.values(r.body)[0] as any; };

describe("pipeline stages", () => {
  it("creates the default pipeline and lets the business configure it", async () => {
    const c = await setup();
    expect((await stages(c)).map((s) => `${s.name}:${s.kind}`)).toEqual(["Lead:open", "Contacted:open", "Qualified:open", "Proposal:open", "Negotiation:open", "Won:won", "Lost:lost"]);
    const demo = (await post(c, "stages", { name: "Demo" }).expect(201)).body.stage;
    const order = (await stages(c)).map((s) => s.name);
    expect(order.indexOf("Demo")).toBe(order.indexOf("Won") - 1);           // new open stages slot in before Won/Lost
    await post(c, "stages", { name: "demo" }).expect(409);
    expect((await patch(c, `stages/${demo.id}`, { name: "Product demo" }).expect(200)).body.stage.name).toBe("Product demo");
    const ids = (await stages(c)).map((s) => s.id);
    await api().put(`${c.base}/crm/stages/order`).set(c.owner.auth).send({ ids: ids.slice(1) }).expect(400);   // must include every stage
    const reversedOpen = [...ids.slice(0, 6).reverse(), ...ids.slice(6)];   // 6 open stages (incl. Demo), then Won + Lost
    const re = (await api().put(`${c.base}/crm/stages/order`).set(c.owner.auth).send({ ids: reversedOpen }).expect(200)).body.stages;
    expect(re.map((s: any) => s.id)).toEqual(reversedOpen);
    await api().delete(`${c.base}/crm/stages/${demo.id}`).set(c.owner.auth).expect(200);
  });

  it("protects stages that hold deals and the last open stage", async () => {
    const c = await setup();
    const lead = await stageId(c, "Lead");
    await mk(c, "deals", { title: "Holder", stageId: lead });
    await api().delete(`${c.base}/crm/stages/${lead}`).set(c.owner.auth).expect(409);
    for (const name of ["Contacted", "Qualified", "Proposal", "Negotiation"]) await api().delete(`${c.base}/crm/stages/${await stageId(c, name)}`).set(c.owner.auth).expect(200);
    await patch(c, `stages/${lead}`, { kind: "won" }).expect(409);           // would leave no open stage
    const other = await mk(c, "deals", { title: "Mover", stageId: await stageId(c, "Won") });
    await api().delete(`${c.base}/crm/stages/${await stageId(c, "Won")}`).set(c.owner.auth).expect(409);
    void other;
  });
});

describe("companies, contacts and leads", () => {
  it("normalises tags and supports search, tag filter, sorting and company links", async () => {
    const c = await setup(); const o = await setup();
    const acme = await mk(c, "companies", { name: "Acme Corp", industry: "Retail", tags: ["VIP", " vip ", "Retail"] });
    expect(acme.tags).toEqual(["vip", "retail"]);
    const zed = await mk(c, "companies", { name: "Zed Ltd" });
    const ann = await mk(c, "contacts", { name: "Ann", email: "ann@acme.test", companyId: acme.id, tags: ["buyer"] });
    await mk(c, "contacts", { name: "Bob", companyId: zed.id });
    expect(ann.companyName).toBe("Acme Corp");
    expect((await get(c, "companies?tag=VIP").expect(200)).body.companies.map((x: any) => x.name)).toEqual(["Acme Corp"]);
    expect((await get(c, "companies?sort=name&dir=desc").expect(200)).body.companies.map((x: any) => x.name)).toEqual(["Zed Ltd", "Acme Corp"]);
    expect((await get(c, "contacts?q=ann@acme").expect(200)).body.contacts.map((x: any) => x.name)).toEqual(["Ann"]);
    expect((await get(c, `contacts?companyId=${zed.id}`).expect(200)).body.contacts.map((x: any) => x.name)).toEqual(["Bob"]);
    const foreign = await mk(o, "companies", { name: "Theirs" });
    await post(c, "contacts", { name: "X", companyId: foreign.id }).expect(400);
    await post(c, "contacts", { name: "Bad", email: "nope" }).expect(400);
    await api().delete(`${c.base}/crm/companies/${acme.id}`).set(c.owner.auth).expect(200);
    expect((await get(c, `contacts/${ann.id}`).expect(200)).body.contact.companyId).toBeNull();   // contact survives
  });

  it("manages leads, restricts owners to members, and converts them into contact + company + deal", async () => {
    const c = await setup(); const emp = await addEmployee(c); const outsider = await setup();
    const existing = await mk(c, "companies", { name: "Globex" });
    const lead = await mk(c, "leads", { name: "Hank Scorpio", email: "hank@globex.test", companyName: "GLOBEX", source: "Referral", ownerId: emp.userId, tags: ["hot"] });
    expect(lead).toMatchObject({ status: "new", ownerName: "Emp" });
    await post(c, "leads", { name: "Bad owner", ownerId: outsider.owner.id }).expect(400);
    await patch(c, `leads/${lead.id}`, { status: "converted" }).expect(400);
    expect((await patch(c, `leads/${lead.id}`, { status: "qualified" }).expect(200)).body.lead.status).toBe("qualified");
    expect((await get(c, "leads?status=qualified").expect(200)).body.total).toBe(1);
    expect((await get(c, `leads?ownerId=${emp.userId}`).expect(200)).body.total).toBe(1);
    const act = await mk(c, "activities", { entityType: "lead", entityId: lead.id, type: "task", subject: "Send brochure" });
    const conv = (await post(c, `leads/${lead.id}/convert`, { dealTitle: "Globex rollout", value: 5000 }).expect(201)).body;
    expect(conv.lead).toMatchObject({ status: "converted", convertedDealId: conv.deal.id });
    expect(conv.deal).toMatchObject({ title: "Globex rollout", value: 5000, stageName: "Lead", status: "open", contactName: "Hank Scorpio", companyId: existing.id, ownerId: emp.userId });
    expect((await get(c, "companies").expect(200)).body.total).toBe(1);               // reused the existing company (case-insensitive)
    expect((await get(c, `activities?entityType=deal&entityId=${conv.deal.id}`).expect(200)).body.activities.map((a: any) => a.id)).toEqual([act.id]);
    await post(c, `leads/${lead.id}/convert`, {}).expect(409);
    await patch(c, `leads/${lead.id}`, { status: "new" }).expect(409);
  });
});

describe("deals", () => {
  it("moves through the pipeline, tracking won/lost state and clearing it on reopen", async () => {
    const c = await setup(); const emp = await addEmployee(c);
    const contact = await mk(c, "contacts", { name: "Client" });
    const d = await mk(c, "deals", { title: "Big sale", value: 1000, contactId: contact.id, ownerId: emp.userId, expectedClose: "2026-12-31", tags: ["Q4"] });
    expect(d).toMatchObject({ stageName: "Lead", status: "open", closedAt: null, expectedClose: "2026-12-31", tags: ["q4"], contactName: "Client" });
    const won = (await patch(c, `deals/${d.id}`, { stageId: await stageId(c, "Won") }).expect(200)).body.deal;
    expect(won).toMatchObject({ status: "won" }); expect(won.closedAt).not.toBeNull();
    const lost = (await patch(c, `deals/${d.id}`, { stageId: await stageId(c, "Lost"), lostReason: "Price" }).expect(200)).body.deal;
    expect(lost).toMatchObject({ status: "lost", lostReason: "Price" });
    // reopening clears closed state, even when the patch also sets a lost reason (no duplicate-column error)
    const back = (await patch(c, `deals/${d.id}`, { stageId: await stageId(c, "Proposal"), lostReason: "ignored" }).expect(200)).body.deal;
    expect(back).toMatchObject({ status: "open", closedAt: null, stageName: "Proposal" });
    expect((await get(c, "deals?status=open").expect(200)).body.total).toBe(1);
    expect((await get(c, `deals?stageId=${await stageId(c, "Proposal")}`).expect(200)).body.total).toBe(1);
    expect((await get(c, `deals?ownerId=${emp.userId}`).expect(200)).body.total).toBe(1);
    await mk(c, "deals", { title: "Small sale", value: 50 });
    expect((await get(c, "deals?sort=value&dir=desc").expect(200)).body.deals.map((x: any) => x.title)).toEqual(["Big sale", "Small sale"]);
    expect((await get(c, "deals?sort=value").expect(200)).body.deals[0].title).toBe("Small sale");
    await post(c, "deals", { title: "x", stageId: (await setup().then((o) => stages(o)))[0].id }).expect(400);   // other business's stage
    await post(c, "deals", { title: "x", value: -1 }).expect(400);
    await mk(c, "deals", { title: "Born won", stageId: await stageId(c, "Won") }).then((x) => expect(x.closedAt).not.toBeNull());
  });
});

describe("activities and reminders", () => {
  it("creates notes/tasks/follow-ups with validation, filters, and completion", async () => {
    const c = await setup(); const o = await setup(); const emp = await addEmployee(c);
    const contact = await mk(c, "contacts", { name: "Cathy" });
    const foreign = await mk(o, "contacts", { name: "Foreign" });
    await post(c, "activities", { entityType: "contact", entityId: contact.id, type: "follow_up", subject: "Call back" }).expect(400);          // needs a due date
    await post(c, "activities", { entityType: "contact", entityId: foreign.id, type: "note", subject: "x" }).expect(400);                      // other business's entity
    await post(c, "activities", { entityType: "contact", entityId: contact.id, type: "task", subject: "x", assignedTo: o.owner.id }).expect(400); // non-member
    const note = await mk(c, "activities", { entityType: "contact", entityId: contact.id, type: "note", subject: "Met at expo", body: "Likes the premium plan" });
    const past = await mk(c, "activities", { entityType: "contact", entityId: contact.id, type: "follow_up", subject: "Overdue chase", dueAt: "2020-01-01T10:00:00Z" });
    const soon = new Date(Date.now() + 2 * 3600_000).toISOString();
    const later = await mk(c, "activities", { entityType: "contact", entityId: contact.id, type: "task", subject: "Prepare quote", dueAt: soon, assignedTo: emp.userId });
    expect(past.assigneeName).toBe("Test User");                                                                                              // due items default to their creator
    expect((await get(c, `activities?entityType=contact&entityId=${contact.id}`).expect(200)).body.total).toBe(3);
    expect((await get(c, "activities?due=overdue").expect(200)).body.activities.map((a: any) => a.id)).toEqual([past.id]);
    expect((await get(c, "activities?due=upcoming").expect(200)).body.activities.map((a: any) => a.id)).toEqual([later.id]);
    expect((await get(c, `activities?assignedTo=${emp.userId}`).expect(200)).body.total).toBe(1);
    expect((await api().get("/api/notifications").set(emp.auth)).body.notifications.some((n: any) => n.type === "crm.task_assigned")).toBe(true);
    const done = (await api().post(`${c.base}/crm/activities/${past.id}/done`).set(c.owner.auth).expect(200)).body.activity;
    expect(done.doneAt).not.toBeNull();
    expect((await get(c, "activities?due=overdue").expect(200)).body.total).toBe(0);
    expect((await get(c, "activities?done=false").expect(200)).body.total).toBe(2);
    await api().post(`${c.base}/crm/activities/${past.id}/reopen`).set(c.owner.auth).expect(200);
    await api().delete(`${c.base}/crm/activities/${note.id}`).set(c.owner.auth).expect(200);
    await api().delete(`${o.base}/crm/activities/${past.id}`).set(o.owner.auth).expect(404);
  });

  it("sends each due reminder exactly once, skips done/unassigned items, and re-arms on reschedule", async () => {
    const c = await setup(); const emp = await addEmployee(c);
    const lead = await mk(c, "leads", { name: "Reminder lead" });
    const due = new Date(Date.now() + 3600_000);
    const mkAct = (b: any) => mk(c, "activities", { entityType: "lead", entityId: lead.id, subject: "S", ...b });
    const a = await mkAct({ type: "task", subject: "Assigned task", dueAt: due.toISOString(), assignedTo: emp.userId });
    const done = await mkAct({ type: "task", subject: "Already done", dueAt: due.toISOString(), assignedTo: emp.userId });
    await api().post(`${c.base}/crm/activities/${done.id}/done`).set(c.owner.auth).expect(200);
    await mkAct({ type: "note", subject: "No due date" });
    const reminders = async () => (await api().get("/api/notifications?limit=100").set(emp.auth)).body.notifications.filter((n: any) => n.type === "crm.reminder");
    // Reminders are claimed globally by design (one scheduler for every business), so drain leftovers from other tests first.
    const before = new Date(due.getTime() - 60_000);
    await sendDueReminders(before);
    expect(await sendDueReminders(before)).toBe(0);                                            // nothing of ours is due yet
    const [r1, r2] = await Promise.all([sendDueReminders(new Date(due.getTime() + 60_000)), sendDueReminders(new Date(due.getTime() + 60_000))]);
    expect(r1 + r2).toBe(1);                                                                   // two overlapping runs, one claim: no duplicate
    expect((await reminders()).map((n: any) => n.title)).toEqual(["Reminder: Assigned task"]); // the completed task and the note were skipped
    expect(await sendDueReminders(new Date(due.getTime() + 120_000))).toBe(0);                 // never twice
    const later = new Date(due.getTime() + 86_400_000);
    await patch(c, `activities/${a.id}`, { dueAt: later.toISOString() }).expect(200);          // reschedule
    await sendDueReminders(new Date(later.getTime() - 60_000));                                 // drain others; ours is not due yet
    expect(await sendDueReminders(new Date(later.getTime() + 60_000))).toBe(1);
    expect(await reminders()).toHaveLength(2);
  });

  it("removes an entity's activities when the entity is deleted", async () => {
    const c = await setup(); const co = await mk(c, "companies", { name: "Gone Inc" });
    await mk(c, "activities", { entityType: "company", entityId: co.id, type: "note", subject: "x" });
    await api().delete(`${c.base}/crm/companies/${co.id}`).set(c.owner.auth).expect(200);
    expect((await get(c, "activities").expect(200)).body.total).toBe(0);
  });
});

describe("dashboard, permissions and isolation", () => {
  it("summarises leads, pipeline value, wins and overdue work", async () => {
    const c = await setup();
    await mk(c, "leads", { name: "L1" }); const l2 = await mk(c, "leads", { name: "L2" }); await patch(c, `leads/${l2.id}`, { status: "qualified" }).expect(200);
    await mk(c, "deals", { title: "Open A", value: 300 }); await mk(c, "deals", { title: "Open B", value: 200, stageId: await stageId(c, "Proposal") });
    await mk(c, "deals", { title: "Won", value: 700, stageId: await stageId(c, "Won") });
    await mk(c, "deals", { title: "Won 2", value: 100, stageId: await stageId(c, "Won") });
    await mk(c, "deals", { title: "Lost", value: 50, stageId: await stageId(c, "Lost") });
    await mk(c, "activities", { entityType: "lead", entityId: l2.id, type: "follow_up", subject: "Late", dueAt: "2020-01-01T00:00:00Z" });
    const d = (await get(c, "dashboard").expect(200)).body;
    expect(d.leadsByStatus).toEqual({ new: 1, qualified: 1 });
    expect(d).toMatchObject({ openDeals: 2, openPipelineValue: 500, wonDeals: 2, wonValue: 800, lostDeals: 1, winRate: 66.7, wonLast30Days: { deals: 2, value: 800 } });
    expect(d.activities).toEqual({ overdue: 1, dueToday: 0 });
    expect(d.pipeline.find((s: any) => s.name === "Proposal")).toMatchObject({ deals: 1, value: 200 });
    expect(d.recentActivity).toHaveLength(1);
  });

  it("keeps CRM away from employees and other businesses", async () => {
    const a = await setup(); const b = await setup(); const emp = await addEmployee(a);
    const lead = await mk(a, "leads", { name: "Private lead" }); const deal = await mk(a, "deals", { title: "Private deal" });
    for (const p of ["dashboard", "leads", "contacts", "companies", "deals", "stages", "activities"]) await api().get(`${a.base}/crm/${p}`).set(emp.auth).expect(403);
    await api().post(`${a.base}/crm/leads`).set(emp.auth).send({ name: "x" }).expect(403);
    await api().get(`${a.base}/crm/leads`).expect(401);
    await api().get(`${b.base}/crm/leads/${lead.id}`).set(b.owner.auth).expect(404);
    await api().patch(`${b.base}/crm/leads/${lead.id}`).set(b.owner.auth).send({ name: "x" }).expect(404);
    await api().delete(`${b.base}/crm/deals/${deal.id}`).set(b.owner.auth).expect(404);
    await api().post(`${b.base}/crm/leads/${lead.id}/convert`).set(b.owner.auth).send({}).expect(404);
    await api().get(`${b.base}/crm/leads/not-a-uuid`).set(b.owner.auth).expect(400);
    expect((await api().get(`${b.base}/crm/leads`).set(b.owner.auth)).body.total).toBe(0);
  });
});
