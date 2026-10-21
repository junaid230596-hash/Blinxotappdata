import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api as _api, pool, registerUser, resetDb } from "./helpers.js";
import { experienceMonths } from "../server/src/lib/experience.js";

const api = _api;
beforeAll(resetDb);
afterAll(() => pool.end());

describe("experienceMonths", () => {
  const now = new Date("2026-09-15T00:00:00Z");
  it("sums spans, merges overlaps, and treats open-ended roles as running until now", () => {
    expect(experienceMonths([{ start: "2020-01-01", end: "2021-01-01" }], now)).toBe(12);
    expect(experienceMonths([{ start: "2020-01-01", end: "2021-01-01" }, { start: "2020-07-01", end: "2021-07-01" }], now)).toBe(18);   // overlap counted once
    expect(experienceMonths([{ start: "2020-01-01", end: "2020-07-01" }, { start: "2021-01-01", end: "2021-04-01" }], now)).toBe(9);    // gap excluded
    expect(experienceMonths([{ start: "2025-09-01" }], now)).toBe(12);
    expect(experienceMonths([{ start: "2020-01-01", end: "2022-01-01" }, { start: "2020-06-01", end: "2020-09-01" }], now)).toBe(24);   // fully contained
    expect(experienceMonths([], now)).toBe(0);
    expect(experienceMonths([{ start: "2022-05-01", end: "2021-01-01" }], now)).toBe(0);                                                 // invalid span ignored
  });
});

describe("profile & resume", () => {
  it("tracks completion as the profile is filled in", async () => {
    const u = await registerUser("individual");
    let p = (await api().get("/api/me/profile").set(u.auth).expect(200)).body.profile;
    expect(p.completion.percent).toBe(0); expect(p.completion.missing).toHaveLength(8); expect(p.skills).toEqual([]);
    p = (await api().patch("/api/me/profile").set(u.auth).send({ headline: "Barista & cashier", bio: "Five years in cafes.", city: "Udaipur", phone: "99999" }).expect(200)).body.profile;
    expect(p.completion.percent).toBe(30);
    await api().put("/api/me/skills").set(u.auth).send({ skills: ["Coffee", "POS", "coffee", " Billing "] }).expect(200);
    await api().post("/api/me/experience").set(u.auth).send({ company: "Cafe One", role: "Barista", startDate: "2021-01-01" }).expect(201);
    await api().post("/api/me/education").set(u.auth).send({ institution: "Govt College" }).expect(201);
    await api().post("/api/me/projects").set(u.auth).send({ title: "Menu redesign" }).expect(201);
    p = (await api().get("/api/me/profile").set(u.auth)).body.profile;
    expect(p.skills).toEqual(["Billing", "Coffee", "POS"]);                      // de-duplicated case-insensitively
    expect(p.completion.percent).toBe(30 + 15 + 20 + 10 + 15);
    expect(p.completion.missing).toEqual(["Upload a profile photo"]);
    await api().patch("/api/me/profile").set(u.auth).send({ avatarUrl: "https://evil.example/a.png" }).expect(400);
    await api().patch("/api/me/profile").set(u.auth).send({ resumeUrl: "/uploads/../../etc/passwd" }).expect(400);
    await api().patch("/api/me/profile").set(u.auth).send({ availability: "someday" }).expect(400);
    await api().patch("/api/me/profile").set(u.auth).send({}).expect(400);
    await api().get("/api/me/profile").expect(401);
  });

  it("manages every resume section, validates dates, and isolates users", async () => {
    const a = await registerUser("individual"); const b = await registerUser("individual");
    const exp = (await api().post("/api/me/experience").set(a.auth).send({ company: "Acme", role: "Clerk", startDate: "2019-03-01", endDate: "2020-03-01", skills: ["Excel", "excel", "Tally"] }).expect(201)).body.entry;
    expect(exp).toMatchObject({ company: "Acme", startDate: "2019-03-01", endDate: "2020-03-01", skills: ["Excel", "Tally"] });
    const bad = await api().post("/api/me/experience").set(a.auth).send({ company: "Bad", role: "x", startDate: "2020-01-01", endDate: "2019-01-01" }).expect(400);
    expect(bad.body.error.message).toMatch(/end cannot be before the start/);                       // a clear message, not a generic constraint error
    await api().patch(`/api/me/experience/${exp.id}`).set(a.auth).send({ endDate: "2018-01-01" }).expect(400);
    const upd = await api().patch(`/api/me/experience/${exp.id}`).set(a.auth).send({ role: "Senior clerk", endDate: null }).expect(200);
    expect(upd.body.entry).toMatchObject({ role: "Senior clerk", endDate: null });
    await api().patch(`/api/me/experience/${exp.id}`).set(b.auth).send({ role: "Hacked" }).expect(404);
    await api().delete(`/api/me/experience/${exp.id}`).set(b.auth).expect(404);
    const cert = (await api().post("/api/me/certifications").set(a.auth).send({ name: "Tally Prime", issuer: "Tally", issuedOn: "2022-01-01", url: "https://example.com/c" }).expect(201)).body.entry;
    await api().post("/api/me/certifications").set(a.auth).send({ name: "Bad", url: "javascript:alert(1)" }).expect(400);
    await api().post("/api/me/education").set(a.auth).send({ institution: "X", startYear: 2015, endYear: 2012 }).expect(400);
    await api().post("/api/me/education").set(a.auth).send({ institution: "MLSU", degree: "B.Com", fieldOfStudy: "Commerce", startYear: 2012, endYear: 2015 }).expect(201);
    const r = (await api().get("/api/me/resume").set(a.auth).expect(200)).body.resume;
    expect(r.experience).toHaveLength(1); expect(r.education[0]).toMatchObject({ institution: "MLSU", fieldOfStudy: "Commerce" });
    expect(r.certifications[0].id).toBe(cert.id); expect(r.email).toBeDefined();
    expect(r.totalExperienceMonths).toBeGreaterThan(60);                          // open-ended role since 2019
    expect((await api().get("/api/me/resume").set(b.auth)).body.resume.experience).toEqual([]);
    await api().delete(`/api/me/experience/${exp.id}`).set(a.auth).expect(200);
    expect((await api().get("/api/me/experience").set(a.auth)).body.experience).toEqual([]);
  });

  it("publishes a profile only when the owner chooses, never exposing contact details", async () => {
    const unverified = await registerUser("individual", { verify: false });
    await api().patch("/api/me/profile").set(unverified.auth).send({ isPublic: true }).expect(403);
    const u = await registerUser("individual");
    await api().patch("/api/me/profile").set(u.auth).send({ headline: "Electrician", bio: "Licensed.", phone: "98765", city: "Jaipur" }).expect(200);
    await api().put("/api/me/skills").set(u.auth).send({ skills: ["Wiring"] }).expect(200);
    await api().post("/api/me/experience").set(u.auth).send({ company: "Volt Co", role: "Electrician", startDate: "2020-01-01", endDate: "2022-01-01" }).expect(201);
    const pub = await api().patch("/api/me/profile").set(u.auth).send({ isPublic: true }).expect(200);
    const slug = pub.body.profile.slug; expect(slug).toMatch(/^test-user-[0-9a-f]{6}$/);
    const page = (await api().get(`/api/public/people/${slug}`).expect(200)).body.person;
    expect(page).toMatchObject({ headline: "Electrician", city: "Jaipur", skills: ["Wiring"], totalExperienceMonths: 24 });
    const raw = JSON.stringify(page);
    expect(raw).not.toContain("98765"); expect(raw).not.toContain(u.email); expect(page.email).toBeUndefined(); expect(page.phone).toBeUndefined();
    expect(page.rating).toMatchObject({ average: null, count: 0 });
    // the slug is stable when toggling, and unpublishing hides the page again
    await api().patch("/api/me/profile").set(u.auth).send({ isPublic: false }).expect(200);
    await api().get(`/api/public/people/${slug}`).expect(404);
    expect((await api().patch("/api/me/profile").set(u.auth).send({ isPublic: true }).expect(200)).body.profile.slug).toBe(slug);
    await api().get("/api/public/people/does-not-exist").expect(404);
  });

  it("serves an individual dashboard with application counts and skill-matched jobs", async () => {
    const u = await registerUser("individual");
    await api().put("/api/me/skills").set(u.auth).send({ skills: ["Welding"] }).expect(200);
    const owner = await registerUser();
    const biz = (await api().post("/api/businesses").set(owner.auth).send({ name: `Dash Co ${Date.now()}` }).expect(201)).body.business;
    const job = (await api().post(`/api/businesses/${biz.id}/jobs`).set(owner.auth).send({ title: "Welder", description: "Weld things", workType: "full_time", skills: ["welding"] }).expect(201)).body.job;
    await api().patch(`/api/businesses/${biz.id}/jobs/${job.id}`).set(owner.auth).send({ status: "open" }).expect(200);
    let d = (await api().get("/api/me/dashboard").set(u.auth).expect(200)).body;
    expect(d.recommendedJobs.map((j: any) => j.title)).toEqual(["Welder"]);
    expect(d.applications.total).toBe(0);
    await api().post(`/api/jobs/${job.id}/apply`).set(u.auth).send({}).expect(201);
    d = (await api().get("/api/me/dashboard").set(u.auth)).body;
    expect(d.recommendedJobs).toEqual([]);                                       // already applied
    expect(d.applications).toEqual({ total: 1, byStatus: { applied: 1 } });
    expect(d).toMatchObject({ skillsCount: 1, experienceCount: 0, rating: { count: 0 } });
  });
});
