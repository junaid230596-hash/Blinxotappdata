import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api as _api, pool, registerUser, resetDb } from "./helpers.js";
import { addEmployee, addProduct, setup } from "./factory.js";

const api = _api;
beforeAll(resetDb);
afterAll(() => pool.end());

const review = (u: any, subjectType: string, subjectId: string, b: any = {}) =>
  api().post("/api/reviews").set(u.auth).send({ subjectType, subjectId, rating: 5, ...b });
const makeAdmin = async () => { const u = await registerUser("individual"); await pool.query("UPDATE users SET account_type='super_admin' WHERE id=$1", [u.id]); return u; };
let n = 0;
async function employeeNamed(c: any, name: string) {
  const email = `rev${++n}_${Date.now()}@example.com`;
  const { PASSWORD, tokenFromMail } = await import("./helpers.js");
  await api().post(`${c.base}/employees`).set(c.owner.auth).send({ email, fullName: name }).expect(201);
  await api().post("/api/auth/reset-password").send({ token: tokenFromMail(email), password: PASSWORD }).expect(200);
  const l = await api().post("/api/auth/login").send({ email, password: PASSWORD }).expect(200);
  return { userId: l.body.user.id as string, id: l.body.user.id as string, auth: { Authorization: `Bearer ${l.body.accessToken}` } };
}

describe("who may review", () => {
  it("blocks strangers and a business's own members, and allows employees", async () => {
    const c = await setup(); const stranger = await registerUser("individual"); const emp = await addEmployee(c);
    expect((await api().get(`/api/reviews/can-review?subjectType=business&subjectId=${c.id}`).set(stranger.auth).expect(200)).body.eligible).toBe(false);
    await review(stranger, "business", c.id).expect(403);
    await review({ auth: c.owner.auth }, "business", c.id).expect(403);                         // own business
    await review(stranger, "business", "00000000-0000-4000-8000-000000000000").expect(404);
    await api().post("/api/reviews").send({ subjectType: "business", subjectId: c.id, rating: 5 }).expect(401);
    expect((await api().get(`/api/reviews/can-review?subjectType=business&subjectId=${c.id}`).set(emp.auth)).body).toMatchObject({ eligible: true, relationship: "employee" });
    const r = (await review(emp, "business", c.id, { rating: 4, body: "Fair pay and a good team." }).expect(201)).body.review;
    expect(r).toMatchObject({ rating: 4, relationship: "employee", status: "published", subjectId: c.id });
    expect((await api().get("/api/notifications").set(c.owner.auth)).body.notifications.some((x: any) => x.type === "review.received")).toBe(true);
  });

  it("requires an interview for applicants, a delivered order for buyers, and employment/hiring for people", async () => {
    const c = await setup(); const seller = await setup("Seller Reviews Co"); const buyer = await setup("Buyer Reviews Co");
    // --- applicant: only after reaching the interview stage
    const job = (await api().post(`${c.base}/jobs`).set(c.owner.auth).send({ title: "Role", description: "d", workType: "full_time" }).expect(201)).body.job;
    await api().patch(`${c.base}/jobs/${job.id}`).set(c.owner.auth).send({ status: "open" }).expect(200);
    const person = await registerUser("individual");
    const app = (await api().post(`/api/jobs/${job.id}/apply`).set(person.auth).send({}).expect(201)).body.application;
    await review(person, "business", c.id).expect(403);
    await api().patch(`${c.base}/applications/${app.id}/status`).set(c.owner.auth).send({ status: "shortlisted" }).expect(200);
    await review(person, "business", c.id).expect(403);
    await api().patch(`${c.base}/applications/${app.id}/status`).set(c.owner.auth).send({ status: "interview" }).expect(200);
    expect((await review(person, "business", c.id, { rating: 3 }).expect(201)).body.review.relationship).toBe("applicant");
    // --- hirer: the business can review that candidate, but only someone with jobs.manage
    expect((await review({ auth: c.owner.auth }, "individual", person.id, { rating: 4 }).expect(201)).body.review.relationship).toBe("hirer");
    const staff = await addEmployee(c);
    await review(staff, "individual", person.id).expect(403);
    // --- buyer: needs a delivered order from the seller
    const prod = await addProduct(seller, { sellingPrice: 10, openingStock: 5, isListed: true });
    const sup = (await api().post(`${buyer.base}/suppliers`).set(buyer.owner.auth).send({ name: "S", linkedBusinessId: seller.id }).expect(201)).body.supplier;
    const po = (await api().post(`${buyer.base}/purchases`).set(buyer.owner.auth).send({ supplierId: sup.id, items: [{ supplierProductId: prod.id, quantity: 1 }] }).expect(201)).body.purchase;
    await api().post(`${buyer.base}/purchases/${po.id}/send`).set(buyer.owner.auth).expect(200);
    await review({ auth: buyer.owner.auth }, "business", seller.id).expect(403);              // order not delivered yet
    await pool.query("UPDATE orders SET status='delivered' WHERE purchase_id=$1", [po.id]);
    expect((await review({ auth: buyer.owner.auth }, "business", seller.id, { rating: 5 }).expect(201)).body.review.relationship).toBe("buyer");
    // --- employer: an owner can review their employee; coworkers and the employee themself cannot
    const e1 = await addEmployee(c); const e2 = await addEmployee(c);
    expect((await review({ auth: c.owner.auth }, "individual", e1.userId, { rating: 5 }).expect(201)).body.review.relationship).toBe("employer");
    await review(e2, "individual", e1.userId).expect(403);
    await review(e1, "individual", e1.userId).expect(403);
    await review({ auth: c.owner.auth }, "individual", (await registerUser("individual")).id).expect(403);    // never worked together
  });
});

describe("review content, edits and abuse limits", () => {
  it("validates ratings and links, prevents duplicates, and lets authors edit or withdraw", async () => {
    const c = await setup(); const e = await addEmployee(c); const other = await addEmployee(c);
    await review(e, "business", c.id, { rating: 0 }).expect(400);
    await review(e, "business", c.id, { rating: 6 }).expect(400);
    await review(e, "business", c.id, { rating: 4.5 }).expect(400);
    await review(e, "business", c.id, { body: "Visit www.spam.example for deals" }).expect(400);
    await review(e, "business", c.id, { body: "see http://spam.example" }).expect(400);
    const r = (await review(e, "business", c.id, { rating: 2, body: "Meh." }).expect(201)).body.review;
    await review(e, "business", c.id).expect(409);                                             // one review per subject
    const edited = (await api().patch(`/api/reviews/${r.id}`).set(e.auth).send({ rating: 4, body: "Improved a lot." }).expect(200)).body.review;
    expect(edited).toMatchObject({ rating: 4, body: "Improved a lot." });
    await api().patch(`/api/reviews/${r.id}`).set(e.auth).send({ body: "now with www.link.com" }).expect(400);
    await api().patch(`/api/reviews/${r.id}`).set(e.auth).send({}).expect(400);
    await api().patch(`/api/reviews/${r.id}`).set(other.auth).send({ rating: 1 }).expect(404);
    await api().delete(`/api/reviews/${r.id}`).set(other.auth).expect(404);
    await api().delete(`/api/reviews/${r.id}`).set(e.auth).expect(200);
    await review(e, "business", c.id, { rating: 3 }).expect(201);                              // may review again after withdrawing
  });

  it("caps how many reviews one account can post per day", async () => {
    const c = await setup(); const e = await addEmployee(c);
    for (let i = 0; i < 10; i++) {
      const { rows } = await pool.query("INSERT INTO businesses (owner_id, name, slug) VALUES ($1,$2,$3) RETURNING id", [c.owner.id, `Filler ${i}`, `filler-${Date.now()}-${i}`]);
      await pool.query("INSERT INTO reviews (reviewer_id, subject_type, subject_business_id, relationship, rating) VALUES ($1,'business',$2,'employee',5)", [e.userId, rows[0].id]);
    }
    const r = await review(e, "business", c.id).expect(429);
    expect(r.body.error.code).toBe("RATE_LIMITED");
  });
});

describe("public reputation", () => {
  it("shows summaries and reviews without exposing reviewer identity details, and hides what is hidden", async () => {
    const c = await setup();
    const a = await employeeNamed(c, "Ravi Kumar"); const b = await employeeNamed(c, "Meena"); const d = await employeeNamed(c, "Arjun Prasad Singh");
    await review(a, "business", c.id, { rating: 5, body: "Great." }).expect(201);
    await review(b, "business", c.id, { rating: 4 }).expect(201);
    const lowId = (await review(d, "business", c.id, { rating: 2, body: "Slow payroll." }).expect(201)).body.review.id;
    const pub = (await api().get(`/api/public/businesses/${c.biz.slug}/reviews`).expect(200)).body;
    expect(pub.summary).toEqual({ average: 3.7, count: 3, distribution: { 1: 0, 2: 1, 3: 0, 4: 1, 5: 1 } });
    expect(pub.reviews.map((r: any) => r.reviewer).sort()).toEqual(["Arjun S.", "Meena", "Ravi K."]);
    expect(pub.reviews[0].badge).toBe("Former or current employee");
    const raw = JSON.stringify(pub);
    for (const x of [a, b, d]) expect(raw).not.toContain(x.userId);
    expect(raw).not.toMatch(/@example\.com/);
    expect((await api().get(`/api/public/businesses/${c.biz.slug}`).expect(200)).body.business.rating).toMatchObject({ average: 3.7, count: 3 });
    expect((await api().get(`/api/public/businesses/${c.biz.slug}/reviews?limit=1&offset=1`).expect(200)).body.reviews).toHaveLength(1);
    await pool.query("UPDATE reviews SET status='hidden' WHERE id=$1", [lowId]);
    expect((await api().get(`/api/public/businesses/${c.biz.slug}/reviews`).expect(200)).body.summary).toMatchObject({ average: 4.5, count: 2 });
    await api().get("/api/public/businesses/nope/reviews").expect(404);
  });

  it("only publishes reviews about a person when their profile is public", async () => {
    const c = await setup(); const e = await addEmployee(c);
    await review({ auth: c.owner.auth }, "individual", e.userId, { rating: 5, body: "Reliable." }).expect(201);
    const mine = (await api().get("/api/me/reviews").set(e.auth).expect(200)).body;
    expect(mine.summary.count).toBe(1); expect(mine.reviews[0].body).toBe("Reliable.");
    const prof = (await api().patch("/api/me/profile").set(e.auth).send({ isPublic: true }).expect(200)).body.profile;
    const list = (await api().get(`/api/public/people/${prof.slug}/reviews`).expect(200)).body;
    expect(list.summary).toMatchObject({ average: 5, count: 1 }); expect(list.reviews[0].badge).toBe("Employer");
    expect((await api().get(`/api/public/people/${prof.slug}`).expect(200)).body.person.rating.count).toBe(1);
    await api().patch("/api/me/profile").set(e.auth).send({ isPublic: false }).expect(200);
    await api().get(`/api/public/people/${prof.slug}/reviews`).expect(404);
  });
});

describe("reports and moderation", () => {
  it("auto-hides a review after three distinct reports, and admins can restore or remove it", async () => {
    const c = await setup(); const e = await addEmployee(c); const admin = await makeAdmin();
    const r = (await review(e, "business", c.id, { rating: 1, body: "Terrible" }).expect(201)).body.review;
    const reporters = [await registerUser("individual"), await registerUser("individual"), await registerUser("individual")];
    const report = (u: any, reason = "Looks fake") => api().post(`/api/reviews/${r.id}/report`).set(u.auth).send({ reason });
    await report(e).expect(403);                                                              // not your own review
    await api().post(`/api/reviews/${r.id}/report`).set(reporters[0].auth).send({ reason: "x" }).expect(400);
    expect((await report(reporters[0]).expect(200)).body.hidden).toBe(false);
    await report(reporters[0]).expect(409);                                                   // one report per person
    await report(reporters[1]).expect(200);
    expect((await api().get(`/api/public/businesses/${c.biz.slug}/reviews`)).body.summary.count).toBe(1);
    const third = await report(reporters[2]).expect(200);
    expect(third.body.hidden).toBe(true);
    expect((await api().get(`/api/public/businesses/${c.biz.slug}/reviews`)).body.summary.count).toBe(0);
    expect((await api().get("/api/notifications").set(e.auth)).body.notifications.some((x: any) => x.type === "review.hidden")).toBe(true);
    await api().patch(`/api/reviews/${r.id}`).set(e.auth).send({ rating: 5 }).expect(409);    // cannot edit your way out of moderation
    await report(await registerUser("individual")).expect(404);                               // already hidden

    await api().get("/api/admin/reviews").set(reporters[0].auth).expect(403);
    await api().get("/api/admin/reviews").expect(401);
    const q = (await api().get("/api/admin/reviews?reported=true").set(admin.auth).expect(200)).body;
    expect(q.reviews[0]).toMatchObject({ id: r.id, status: "hidden", openReports: 3, reviewerName: "Emp" }); expect(q.reviews[0].reports).toHaveLength(3);
    await api().post(`/api/admin/reviews/${r.id}/restore`).set(admin.auth).expect(200);
    expect((await api().get(`/api/public/businesses/${c.biz.slug}/reviews`)).body.summary.count).toBe(1);
    expect((await api().get("/api/admin/reviews?reported=true").set(admin.auth)).body.total).toBe(0);   // reports dismissed
    await api().post(`/api/admin/reviews/${r.id}/hide`).set(admin.auth).send({ reason: "x" }).expect(400);
    await api().post(`/api/admin/reviews/${r.id}/hide`).set(admin.auth).send({ reason: "Targeted harassment" }).expect(200);
    expect((await api().get("/api/admin/reviews?status=hidden").set(admin.auth)).body.total).toBeGreaterThan(0);
    expect((await api().get("/api/notifications?limit=50").set(e.auth)).body.notifications.some((x: any) => x.body === "Targeted harassment")).toBe(true);
    await api().post(`/api/admin/reviews/${r.id}/hide`).set(c.owner.auth).send({ reason: "nope nope" }).expect(403);
  });
});
