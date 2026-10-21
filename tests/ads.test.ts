import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api as _api, pool, registerUser, resetDb } from "./helpers.js";
import { addEmployee, setup } from "./factory.js";

const api = _api;
beforeAll(resetDb);
afterAll(() => pool.end());

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const makeAdmin = async () => { const u = await registerUser("individual"); await pool.query("UPDATE users SET account_type='super_admin' WHERE id=$1", [u.id]); return u; };
let n = 0;
const mkAd = async (c: any, o: any = {}) =>
  (await api().post(`${c.base}/ads`).set(c.owner.auth).send({ title: `Ad ${++n} ${Date.now()}`, placements: ["discover"], startDate: day(-2), endDate: day(2), ctaLabel: "Visit", ctaUrl: "https://example.com", ...o }).expect(201)).body.ad;
const live = (c: any, id: string) => api().patch(`${c.base}/ads/${id}`).set(c.owner.auth).send({ status: "active" });
const serve = async (placement: string, extra = "") => (await api().get(`/api/public/ads?placement=${placement}&limit=10${extra}`).expect(200)).body.ads as any[];

describe("managing ads", () => {
  it("validates creative, dates and links, and enforces permissions and tenancy", async () => {
    const c = await setup(); const o = await setup(); const emp = await addEmployee(c);
    const base = { title: "T", placements: ["discover"], startDate: day(0), endDate: day(1) };
    await api().post(`${c.base}/ads`).set(c.owner.auth).send({ ...base, ctaUrl: "javascript:alert(1)" }).expect(400);
    await api().post(`${c.base}/ads`).set(c.owner.auth).send({ ...base, imageUrl: "https://evil.example/a.png" }).expect(400);
    await api().post(`${c.base}/ads`).set(c.owner.auth).send({ ...base, placements: ["homepage"] }).expect(400);
    await api().post(`${c.base}/ads`).set(c.owner.auth).send({ ...base, placements: [] }).expect(400);
    await api().post(`${c.base}/ads`).set(c.owner.auth).send({ ...base, startDate: day(3), endDate: day(1) }).expect(400);
    await api().post(`${c.base}/ads`).set(emp.auth).send(base).expect(403);
    const ad = await mkAd(c);
    expect(ad).toMatchObject({ status: "draft", moderationStatus: "approved", tier: "free", impressions: 0, clicks: 0 });
    await api().get(`${o.base}/ads/${ad.id}`).set(o.owner.auth).expect(404);
    await api().patch(`${o.base}/ads/${ad.id}`).set(o.owner.auth).send({ title: "x" }).expect(404);
    await api().delete(`${o.base}/ads/${ad.id}`).set(o.owner.auth).expect(404);
    await api().patch(`${c.base}/ads/${ad.id}`).set(c.owner.auth).send({ startDate: day(5) }).expect(400);   // would end before it starts
    await api().patch(`${c.base}/ads/${ad.id}`).set(c.owner.auth).send({}).expect(400);
    expect((await api().get(`${c.base}/ads?status=draft`).set(c.owner.auth)).body.total).toBe(1);
    await api().delete(`${c.base}/ads/${ad.id}`).set(c.owner.auth).expect(200);
    expect((await api().get(`${c.base}/ads`).set(c.owner.auth)).body.total).toBe(0);
  });
});

describe("serving ads", () => {
  it("serves only live, approved ads inside their dates and placement, and counts impressions and clicks", async () => {
    const c = await setup(); const tag = `Live${Date.now()}`;
    const ad = await mkAd(c, { title: tag, placements: ["discover", "product_discovery"], imageUrl: undefined });
    expect((await serve("discover")).map((a) => a.title)).not.toContain(tag);                      // drafts are never served
    await live(c, ad.id).expect(200);
    const hit = (await serve("discover")).find((a) => a.title === tag)!;
    expect(hit).toMatchObject({ ctaLabel: "Visit", ctaUrl: "https://example.com", business: { name: c.biz.name, slug: c.biz.slug } });
    expect((await serve("product_discovery")).map((a) => a.title)).toContain(tag);
    expect((await serve("business_profile")).map((a) => a.title)).not.toContain(tag);              // wrong placement
    expect((await serve("business_profile", `&businessId=${c.id}`)).length).toBe(0);
    expect((await serve("discover", `&businessId=${c.id}`)).map((a) => a.title)).toEqual([tag]);
    await api().get("/api/public/ads?placement=homepage").expect(400);
    expect((await api().get(`${c.base}/ads/${ad.id}`).set(c.owner.auth)).body.ad.impressions).toBe(3);
    await api().post(`/api/public/ads/${ad.id}/click`).expect(200);
    await api().post(`/api/public/ads/${ad.id}/click`).expect(200);
    expect((await api().get(`${c.base}/ads/${ad.id}`).set(c.owner.auth)).body.ad.clicks).toBe(2);

    await api().patch(`${c.base}/ads/${ad.id}`).set(c.owner.auth).send({ status: "paused" }).expect(200);
    expect((await serve("discover", `&businessId=${c.id}`))).toHaveLength(0);
    await api().post(`/api/public/ads/${ad.id}/click`).expect(404);                                // paused ads cannot collect clicks
    await live(c, ad.id).expect(200);
    await api().patch(`${c.base}/ads/${ad.id}`).set(c.owner.auth).send({ startDate: day(1), endDate: day(3) }).expect(200);
    expect(await serve("discover", `&businessId=${c.id}`)).toHaveLength(0);                        // not started yet
    await api().patch(`${c.base}/ads/${ad.id}`).set(c.owner.auth).send({ startDate: day(-5), endDate: day(-1) }).expect(200);
    expect(await serve("discover", `&businessId=${c.id}`)).toHaveLength(0);                        // already ended
    await api().patch(`${c.base}/ads/${ad.id}`).set(c.owner.auth).send({ startDate: day(-1), endDate: day(1) }).expect(200);
    expect(await serve("discover", `&businessId=${c.id}`)).toHaveLength(1);
    await api().patch(`${c.base}`).set(c.owner.auth).send({ isPublic: false }).expect(200);
    expect(await serve("discover", `&businessId=${c.id}`)).toHaveLength(0);                        // hidden with a private business
    await api().post("/api/public/ads/not-a-uuid/click").expect(400);
  });

  it("lets moderators reject (pausing and blocking the ad, and telling the owner) or re-approve it", async () => {
    const c = await setup(); const admin = await makeAdmin(); const ad = await mkAd(c);
    await live(c, ad.id).expect(200);
    await api().post(`/api/admin/ads/${ad.id}/reject`).set(c.owner.auth).send({ note: "not allowed" }).expect(403);
    await api().post(`/api/admin/ads/${ad.id}/reject`).set(admin.auth).send({ note: "x" }).expect(400);
    await api().post(`/api/admin/ads/${ad.id}/reject`).set(admin.auth).send({ note: "Misleading claims" }).expect(200);
    const after = (await api().get(`${c.base}/ads/${ad.id}`).set(c.owner.auth)).body.ad;
    expect(after).toMatchObject({ status: "paused", moderationStatus: "rejected", moderationNote: "Misleading claims" });
    expect(await serve("discover", `&businessId=${c.id}`)).toHaveLength(0);
    expect((await live(c, ad.id).expect(409)).body.error.message).toMatch(/rejected/);
    expect((await api().get("/api/notifications").set(c.owner.auth)).body.notifications.some((x: any) => x.type === "ad.rejected" && x.body === "Misleading claims")).toBe(true);
    expect((await api().get("/api/admin/ads?moderation=rejected").set(admin.auth)).body.ads.some((a: any) => a.id === ad.id && a.businessName === c.biz.name)).toBe(true);
    await api().post(`/api/admin/ads/${ad.id}/approve`).set(admin.auth).expect(200);
    await live(c, ad.id).expect(200);
    expect(await serve("discover", `&businessId=${c.id}`)).toHaveLength(1);
  });
});
