import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api as _api, pool, registerUser, resetDb } from "./helpers.js";
import { addEmployee, setup } from "./factory.js";

const api = _api;
beforeAll(resetDb);
afterAll(() => pool.end());

let n = 0;
const mkJob = async (c: any, o: any = {}, open = true) => {
  const job = (await api().post(`${c.base}/jobs`).set(c.owner.auth).send({ title: `Role ${++n}`, description: "Do the work", workType: "full_time", ...o }).expect(201)).body.job;
  if (!open) return job;
  return (await api().patch(`${c.base}/jobs/${job.id}`).set(c.owner.auth).send({ status: "open" }).expect(200)).body.job;
};
const apply = (u: any, jobId: string, b: any = {}) => api().post(`/api/jobs/${jobId}/apply`).set(u.auth).send(b);
const setApp = (c: any, id: string, b: any) => api().patch(`${c.base}/applications/${id}/status`).set(c.owner.auth).send(b);

describe("job posting", () => {
  it("validates, saves as draft, opens/closes, and only shows open jobs publicly", async () => {
    const c = await setup(); const tag = `zq${Date.now()}`;
    await api().post(`${c.base}/jobs`).set(c.owner.auth).send({ title: "x", description: "d", workType: "full_time", payMin: 500, payMax: 100 }).expect(400);
    await api().post(`${c.base}/jobs`).set(c.owner.auth).send({ title: "x", description: "d", workType: "full_time", deadline: "2020-01-01" }).expect(400);
    await api().post(`${c.base}/jobs`).set(c.owner.auth).send({ title: "x", description: "d", workType: "weekend" }).expect(400);
    const draft = await mkJob(c, { title: `Cashier ${tag}`, skills: ["POS", "pos", "Billing"], payMin: 12000, payMax: 18000, payPeriod: "month", location: "Udaipur", deadline: "2099-12-31" }, false);
    expect(draft).toMatchObject({ status: "draft", skills: ["POS", "Billing"], payMin: 12000, currency: "INR", applicantCount: 0, deadline: "2099-12-31" });
    expect((await api().get(`/api/public/jobs?q=${tag}`).expect(200)).body.total).toBe(0);               // drafts are private
    await api().patch(`${c.base}/jobs/${draft.id}`).set(c.owner.auth).send({ status: "closed" }).expect(409);   // draft -> closed is not a thing
    await api().patch(`${c.base}/jobs/${draft.id}`).set(c.owner.auth).send({ payMax: 5000 }).expect(400);
    const open = (await api().patch(`${c.base}/jobs/${draft.id}`).set(c.owner.auth).send({ status: "open" }).expect(200)).body.job;
    expect(open.status).toBe("open"); expect(open.publishedAt).not.toBeNull();
    const found = (await api().get(`/api/public/jobs?q=${tag}`).expect(200)).body.jobs;
    expect(found).toHaveLength(1); expect(found[0].business).toMatchObject({ name: c.biz.name, slug: c.biz.slug });
    expect(found[0].applicantCount).toBeUndefined();                                                      // applicant info is never public
    await api().patch(`${c.base}/jobs/${draft.id}`).set(c.owner.auth).send({ status: "closed" }).expect(200);
    expect((await api().get(`/api/public/jobs?q=${tag}`).expect(200)).body.total).toBe(0);
    await api().patch(`${c.base}/jobs/${draft.id}`).set(c.owner.auth).send({ status: "open" }).expect(200);   // reopen
    await pool.query("UPDATE jobs SET deadline = CURRENT_DATE - 1 WHERE id=$1", [draft.id]);
    expect((await api().get(`/api/public/jobs?q=${tag}`).expect(200)).body.total).toBe(0);               // deadline passed => hidden
    await api().get(`/api/public/jobs/${draft.id}`).expect(404);
    await api().patch(`${c.base}/jobs/${draft.id}`).set(c.owner.auth).send({ status: "closed" }).expect(200);
    await api().patch(`${c.base}/jobs/${draft.id}`).set(c.owner.auth).send({ status: "open" }).expect(400);  // expired deadline must be fixed first
    await api().patch(`${c.base}/jobs/${draft.id}`).set(c.owner.auth).send({ deadline: "2099-01-01", status: "open" }).expect(200);
  });

  it("searches publicly by text, location, skill, type, remote and business", async () => {
    const a = await setup(); const b = await setup(); const tag = `srch${Date.now()}`;
    const j1 = await mkJob(a, { title: `Chef ${tag}`, location: "Mumbai", skills: ["Cooking"], workType: "full_time" });
    await mkJob(a, { title: `Driver ${tag}`, location: "Delhi", skills: ["Driving"], workType: "contract", isRemote: false });
    await mkJob(b, { title: `Designer ${tag}`, description: "Remote friendly", location: "Anywhere", skills: ["Figma"], workType: "freelance", isRemote: true });
    const titles = async (q: string) => (await api().get(`/api/public/jobs?q=${tag}&${q}`).expect(200)).body.jobs.map((j: any) => j.title.split(" ")[0]).sort();
    expect(await titles("")).toEqual(["Chef", "Designer", "Driver"]);
    expect(await titles("location=mum")).toEqual(["Chef"]);
    expect(await titles("skill=cooking")).toEqual(["Chef"]);
    expect(await titles("workType=contract")).toEqual(["Driver"]);
    expect(await titles("remote=true")).toEqual(["Designer"]);
    expect(await titles(`businessId=${b.id}`)).toEqual(["Designer"]);
    expect((await api().get(`/api/public/jobs?q=${tag}&limit=2&offset=2`).expect(200)).body).toMatchObject({ total: 3 });
    expect((await api().get(`/api/public/jobs/${j1.id}`).expect(200)).body.job.title).toContain("Chef");
    await api().patch(`${b.base}`).set(b.owner.auth).send({ isPublic: false }).expect(200);
    expect(await titles("")).toEqual(["Chef", "Driver"]);                                                  // hidden with their business
    expect((await api().get("/api/public/jobs?q=%25").expect(200)).body.total).toBe(0);                    // LIKE wildcards are escaped
  });

  it("enforces permissions and tenant isolation, and protects jobs that have applicants", async () => {
    const a = await setup(); const b = await setup(); const emp = await addEmployee(a);
    const job = await mkJob(a); const person = await registerUser("individual");
    await api().get(`${a.base}/jobs`).set(emp.auth).expect(403);
    await api().post(`${a.base}/jobs`).set(emp.auth).send({ title: "x", description: "d", workType: "full_time" }).expect(403);
    await api().get(`${b.base}/jobs/${job.id}`).set(b.owner.auth).expect(404);
    await api().patch(`${b.base}/jobs/${job.id}`).set(b.owner.auth).send({ title: "Hijack" }).expect(404);
    await api().delete(`${b.base}/jobs/${job.id}`).set(b.owner.auth).expect(404);
    await apply(person, job.id).expect(201);
    await api().delete(`${a.base}/jobs/${job.id}`).set(a.owner.auth).expect(409);
    const lone = await mkJob(a, {}, false);
    await api().delete(`${a.base}/jobs/${lone.id}`).set(a.owner.auth).expect(200);
    expect((await api().get(`${a.base}/jobs?status=open`).set(a.owner.auth)).body.jobs[0].applicantCount).toBe(1);
  });
});

describe("applications", () => {
  it("lets individuals apply once, with the right restrictions", async () => {
    const c = await setup(); const job = await mkJob(c); const person = await registerUser("individual");
    const emp = await addEmployee(c);
    await api().post(`/api/jobs/${job.id}/apply`).send({}).expect(401);
    await apply(await registerUser("business_owner"), job.id).expect(403);                  // business accounts cannot apply
    await apply({ auth: c.owner.auth } as any, job.id).expect(403);
    await apply(emp, job.id).expect(403);                                                    // a member of the hiring business cannot apply to their own job
    const outsideEmployee = await registerUser("employee");
    await apply(outsideEmployee, job.id).expect(201);                                        // employees elsewhere can
    const res = await apply(person, job.id, { coverLetter: "I am keen." }).expect(201);
    expect(res.body.application).toMatchObject({ status: "applied", jobTitle: job.title, coverLetter: "I am keen." });
    expect(res.body.application.history.map((h: any) => h.status)).toEqual(["applied"]);
    await apply(person, job.id).expect(409);
    await apply(person, "00000000-0000-4000-8000-000000000000").expect(404);
    const closed = await mkJob(c, {}, true); await api().patch(`${c.base}/jobs/${closed.id}`).set(c.owner.auth).send({ status: "closed" }).expect(200);
    await apply(person, closed.id).expect(404);
    const draft = await mkJob(c, {}, false); await apply(person, draft.id).expect(404);
    expect((await api().get(`/api/public/jobs/${job.id}`).set(person.auth).expect(200)).body.job.applied).toBe(true);
    expect((await api().get(`/api/public/jobs/${job.id}`).expect(200)).body.job.applied).toBeUndefined();
    const notes = (await api().get("/api/notifications").set(c.owner.auth)).body.notifications;
    expect(notes.filter((x: any) => x.type === "application.new")).toHaveLength(2);
    const mine = (await api().get("/api/me/applications").set(person.auth).expect(200)).body;
    expect(mine.total).toBe(1); expect(mine.applications[0].jobTitle).toBe(job.title);
  });

  it("runs the hiring pipeline with history, contact visibility and notifications", async () => {
    const c = await setup(); const job = await mkJob(c);
    const person = await registerUser("individual");
    await api().patch("/api/me/profile").set(person.auth).send({ headline: "Cashier", city: "Pune", phone: "90000" }).expect(200);
    await api().put("/api/me/skills").set(person.auth).send({ skills: ["POS", "Billing"] }).expect(200);
    await api().post("/api/me/experience").set(person.auth).send({ company: "Mart", role: "Cashier", startDate: "2020-01-01", endDate: "2022-01-01" }).expect(201);
    const app = (await apply(person, job.id, { coverLetter: "Hire me" }).expect(201)).body.application;
    const list = (await api().get(`${c.base}/applications`).set(c.owner.auth).expect(200)).body;
    expect(list.total).toBe(1);
    expect(list.applications[0].applicant).toMatchObject({ name: "Test User", headline: "Cashier", city: "Pune", skills: ["Billing", "POS"], experienceMonths: 24 });
    expect(JSON.stringify(list)).not.toContain("90000");                                    // contact details only on the detail view
    const detail = (await api().get(`${c.base}/applications/${app.id}`).set(c.owner.auth).expect(200)).body.application;
    expect(detail.applicant).toMatchObject({ phone: "90000", email: person.email }); expect(detail.coverLetter).toBe("Hire me");

    await setApp(c, app.id, { status: "interview" }).expect(409);                           // must shortlist first
    await setApp(c, app.id, { status: "shortlisted", note: "Strong CV" }).expect(200);
    await setApp(c, app.id, { status: "shortlisted" }).expect(409);
    await setApp(c, app.id, { status: "selected", interviewAt: "2030-01-01T10:00:00Z" }).expect(400);   // interview time only for interviews
    const when = "2030-01-01T10:00:00.000Z";
    const iv = (await setApp(c, app.id, { status: "interview", interviewAt: when, note: "Round 1" }).expect(200)).body.application;
    expect(iv).toMatchObject({ status: "interview", interviewAt: when });
    const sel = (await setApp(c, app.id, { status: "selected" }).expect(200)).body.application;
    expect(sel.history.map((h: any) => h.status)).toEqual(["applied", "shortlisted", "interview", "selected"]);
    expect(sel.history[1]).toMatchObject({ note: "Strong CV", actorName: "Test User" });
    await setApp(c, app.id, { status: "rejected" }).expect(409);                            // selected is final
    const mine = (await api().get(`/api/me/applications/${app.id}`).set(person.auth).expect(200)).body.application;
    expect(mine.status).toBe("selected"); expect(mine.history).toHaveLength(4);
    const types = (await api().get("/api/notifications").set(person.auth)).body.notifications.filter((x: any) => x.type === "application.status");
    expect(types).toHaveLength(3);
    expect((await api().get(`${c.base}/applications?status=selected`).set(c.owner.auth)).body.total).toBe(1);
    expect((await api().get(`${c.base}/applications?jobId=${job.id}&status=applied`).set(c.owner.auth)).body.total).toBe(0);
    await api().post(`/api/me/applications/${app.id}/withdraw`).set(person.auth).expect(409);   // too late to withdraw
  });

  it("lets applicants withdraw (and tells the business), and keeps applications private to each side", async () => {
    const c = await setup(); const o = await setup(); const job = await mkJob(c);
    const p1 = await registerUser("individual"); const p2 = await registerUser("individual");
    const a1 = (await apply(p1, job.id).expect(201)).body.application; await apply(p2, job.id).expect(201);
    await api().get(`/api/me/applications/${a1.id}`).set(p2.auth).expect(404);
    await api().post(`/api/me/applications/${a1.id}/withdraw`).set(p2.auth).expect(404);
    await api().get(`${o.base}/applications/${a1.id}`).set(o.owner.auth).expect(404);
    await setApp(o, a1.id, { status: "shortlisted" }).expect(404);
    const w = (await api().post(`/api/me/applications/${a1.id}/withdraw`).set(p1.auth).expect(200)).body.application;
    expect(w.status).toBe("withdrawn"); expect(w.history.map((h: any) => h.status)).toEqual(["applied", "withdrawn"]);
    expect((await api().get("/api/notifications").set(c.owner.auth)).body.notifications.some((x: any) => x.type === "application.withdrawn")).toBe(true);
    await setApp(c, a1.id, { status: "shortlisted" }).expect(409);                          // withdrawn is final
    await apply(p1, job.id).expect(409);                                                    // and cannot be re-submitted
    const emp = await addEmployee(c);
    await api().get(`${c.base}/applications`).set(emp.auth).expect(403);
    expect((await api().get("/api/me/applications?status=withdrawn").set(p1.auth)).body.total).toBe(1);
  });
});
