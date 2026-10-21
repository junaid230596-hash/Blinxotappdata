import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, pool, registerUser, resetDb } from "./helpers.js";
import { addEmployee, addProduct, setup } from "./factory.js";

beforeAll(resetDb);
afterAll(() => pool.end());

describe("robots.txt and sitemap.xml", () => {
  it("keeps private areas out of search engines and points to the sitemap", async () => {
    const r = await api().get("/robots.txt").expect(200);
    expect(r.type).toBe("text/plain");
    for (const p of ["Disallow: /app", "Disallow: /api/", "Disallow: /uploads/", "Disallow: /login"]) expect(r.text).toContain(p);
    expect(r.text).toMatch(/Sitemap: https?:\/\/[^\s]+\/sitemap\.xml/);
  });

  it("lists static pages plus only public, active businesses, listed products and public profiles", async () => {
    const pub = await setup(); const hidden = await setup(); const susp = await setup();
    await api().patch(pub.base).set(pub.owner.auth).send({ isPublic: true }).expect(200);
    await api().patch(hidden.base).set(hidden.owner.auth).send({ isPublic: false }).expect(200);
    await pool.query("UPDATE businesses SET status='suspended' WHERE id=$1", [susp.id]);
    const slug = (await pool.query("SELECT slug FROM businesses WHERE id=$1", [pub.id])).rows[0].slug;
    const hiddenSlug = (await pool.query("SELECT slug FROM businesses WHERE id=$1", [hidden.id])).rows[0].slug;
    const listed = await addProduct(pub); await pool.query("UPDATE products SET is_listed=true WHERE id=$1", [listed.id ?? listed]);
    const person = await registerUser("individual");
    await api().patch("/api/me/profile").set(person.auth).send({ isPublic: true, headline: "Welder" }).expect(200);
    const personSlug = (await pool.query("SELECT slug FROM profiles WHERE user_id=$1", [person.id])).rows[0].slug;

    const r = await api().get("/sitemap.xml").expect(200);
    expect(r.type).toBe("application/xml");
    for (const p of ["/", "/features", "/pricing", "/discover"]) expect(r.text).toMatch(new RegExp(`<loc>https?://[^<]*${p === "/" ? "/" : p}</loc>`));
    expect(r.text).toContain(`/b/${slug}</loc>`);
    expect(r.text).not.toContain(`/b/${hiddenSlug}<`);
    expect(r.text).toContain(`/p/${personSlug}</loc>`);
    expect(r.text).toContain(`/products/${listed.id ?? listed}</loc>`);
    expect(r.text).not.toContain("/app");
  });
});

describe("public site facts", () => {
  it("exposes only the support email and whether sign-up is open", async () => {
    const r = await api().get("/api/public/site").expect(200);
    expect(Object.keys(r.body).sort()).toEqual(["registrationOpen", "supportEmail"]);
  });
});

describe("business hours and social links", () => {
  it("are validated, saved and shown on the public profile", async () => {
    const c = await setup(); const emp = await addEmployee(c);
    const hours = { mon: { open: "09:00", close: "18:00" }, sun: { closed: true } };
    const social = { instagram: "https://instagram.com/blinxot", x: "https://x.com/blinxot" };
    await api().patch(c.base).set(emp.auth).send({ businessHours: hours }).expect(403);
    await api().patch(c.base).set(c.owner.auth).send({ businessHours: { mon: { open: "18:00", close: "09:00" } } }).expect(400);   // closes before it opens
    await api().patch(c.base).set(c.owner.auth).send({ businessHours: { mon: { open: "9am", close: "6pm" } } }).expect(400);
    await api().patch(c.base).set(c.owner.auth).send({ businessHours: { funday: { closed: true } } }).expect(400);                // unknown day
    await api().patch(c.base).set(c.owner.auth).send({ socialLinks: { instagram: "javascript:alert(1)" } }).expect(400);          // no script URLs
    await api().patch(c.base).set(c.owner.auth).send({ socialLinks: { myspace: "https://example.com" } }).expect(400);
    await api().patch(c.base).set(c.owner.auth).send({ logoUrl: "javascript:alert(1)" }).expect(400);
    await api().patch(c.base).set(c.owner.auth).send({ website: "javascript:alert(1)" }).expect(400);      // rendered as a link on the public page
    const r = await api().patch(c.base).set(c.owner.auth).send({ businessHours: hours, socialLinks: social, isPublic: true }).expect(200);
    expect(r.body.business).toMatchObject({ businessHours: hours, socialLinks: social });
    const slug = (await pool.query("SELECT slug FROM businesses WHERE id=$1", [c.id])).rows[0].slug;
    const pub = await api().get(`/api/public/businesses/${slug}`).expect(200);
    expect(pub.body.business).toMatchObject({ businessHours: hours, socialLinks: social });
  });
});

describe("AI tool boundary", () => {
  it("offers only read-only tools the caller's permissions allow, and audits use", async () => {
    const c = await setup(); const emp = await addEmployee(c); const outsider = await setup();
    const owner = (await api().get(`${c.base}/ai/tools`).set(c.owner.auth).expect(200)).body.tools.map((t: any) => t.name);
    expect(owner).toEqual(expect.arrayContaining(["business_dashboard", "low_stock_products", "run_report", "search"]));
    expect(owner.join()).not.toMatch(/sql|write|delete|create|update/i);
    const staff = (await api().get(`${c.base}/ai/tools`).set(emp.auth).expect(200)).body.tools.map((t: any) => t.name);
    expect(staff).not.toContain("run_report");
    const canSeeStock = (await api().get(`${c.base}/inventory/low-stock`).set(emp.auth)).status === 200;   // a tool is offered exactly when the matching endpoint is allowed
    expect(staff.includes("low_stock_products")).toBe(canSeeStock);

    await api().post(`${c.base}/ai/tools/run_report`).set(emp.auth).send({ type: "sales", from: "2026-01-01", to: "2026-01-31" }).expect(403);
    await api().post(`${c.base}/ai/tools/drop_database`).set(c.owner.auth).send({}).expect(404);
    await api().post(`${c.base}/ai/tools/run_report`).set(c.owner.auth).send({ type: "sales", from: "2026-02-01", to: "2026-01-01" }).expect(400);
    await api().post(`${c.base}/ai/tools/run_report`).set(c.owner.auth).send({ type: "sales", from: "2026-01-01", to: "2026-01-31", sql: "x" }).expect(400);   // unknown input rejected
    await api().get(`${c.base}/ai/tools`).set(outsider.owner.auth).expect(404);                                                                                    // another tenant
    await api().post(`${c.base}/ai/tools/business_dashboard`).set(outsider.owner.auth).send({}).expect(404);

    const ok = await api().post(`${c.base}/ai/tools/run_report`).set(c.owner.auth).send({ type: "sales", from: "2026-01-01", to: "2026-01-31" }).expect(200);
    expect(ok.body.result).toHaveProperty("rows");
    const logged = await pool.query("SELECT count(*)::int AS n FROM audit_logs WHERE business_id=$1 AND action='ai.tool'", [c.id]);
    expect(logged.rows[0].n).toBe(1);
    expect((await api().get(`${c.base}/ai/status`).set(c.owner.auth)).body).toEqual({ provider: "none", enabled: false });
  });
});

describe("link-preview meta for public pages", () => {
  it("fills title, description, canonical and Open Graph for a public business, and escapes hostile text", async () => {
    const c = await setup('Evil "Name" <script>x</script>');
    await api().patch(c.base).set(c.owner.auth).send({ description: 'Sells <b>things</b> & "stuff"', isPublic: true }).expect(200);
    const slug = (await pool.query("SELECT slug FROM businesses WHERE id=$1", [c.id])).rows[0].slug;
    const r = await api().get(`/b/${slug}`).expect(200);
    expect(r.type).toBe("text/html");
    expect(r.text).toContain(`<link rel="canonical" href="http`);
    expect(r.text).toContain(`/b/${slug}"`);
    expect(r.text).toContain('property="og:title"');
    expect(r.text).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(r.text).not.toContain("<script>x</script>");
    expect(r.text).toContain('<div id="root">');                      // the React app still boots from the same page
    expect((r.text.match(/<title>/g) ?? []).length).toBe(1);
    expect((r.text.match(/property="og:title"/g) ?? []).length).toBe(1);
  });

  it("serves product and person pages, and a 404 noindex page for private, missing or malformed targets", async () => {
    const c = await setup(); const p = await addProduct(c, { name: "Brass Lamp" }); await pool.query("UPDATE products SET is_listed=true WHERE id=$1", [p.id]);
    const ok = await api().get(`/products/${p.id}`).expect(200);
    expect(ok.text).toContain("Brass Lamp · Blinxot"); expect(ok.text).toContain("index, follow");
    await pool.query("UPDATE products SET is_listed=false WHERE id=$1", [p.id]);
    const gone = await api().get(`/products/${p.id}`).expect(404);
    expect(gone.text).toContain("noindex, nofollow"); expect(gone.text).not.toContain("Brass Lamp");
    await api().get("/products/not-a-uuid").expect(404);
    const priv = await setup(); await api().patch(priv.base).set(priv.owner.auth).send({ isPublic: false }).expect(200);
    const privSlug = (await pool.query("SELECT slug FROM businesses WHERE id=$1", [priv.id])).rows[0].slug;
    await api().get(`/b/${privSlug}`).expect(404);
    await api().get("/p/nobody-here").expect(404);
  });
});

describe("contact form", () => {
  const msg = { name: "Ravi", email: "ravi@example.com", message: "I would like to know about the Pro plan." };
  it("refuses until a support email is configured, then emails it with the sender as reply-to", async () => {
    await api().post("/api/public/contact").send(msg).expect(503);
    const { outbox } = await import("../server/src/lib/email.js");
    const admin = await registerUser("individual"); await pool.query("UPDATE users SET account_type='super_admin' WHERE id=$1", [admin.id]);
    await api().put("/api/admin/settings/support_email").set(admin.auth).send({ value: "help@blinxot.example" }).expect(200);
    await new Promise((r) => setTimeout(r, 5100));                    // settings are cached for 5 s
    outbox.length = 0;
    await api().post("/api/public/contact").send(msg).expect(201);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ to: "help@blinxot.example", replyTo: "ravi@example.com" });
    expect(outbox[0].text).toContain("Pro plan");
  }, 15000);

  it("validates input, blocks header injection, and silently drops honeypot submissions", async () => {
    const { outbox } = await import("../server/src/lib/email.js"); outbox.length = 0;
    await api().post("/api/public/contact").send({ ...msg, email: "nope" }).expect(400);
    await api().post("/api/public/contact").send({ ...msg, message: "short" }).expect(400);
    await api().post("/api/public/contact").send({ ...msg, name: "Ravi\r\nBcc: victim@example.com" }).expect(400);
    await api().post("/api/public/contact").send({ ...msg, website: "http://spam.example" }).expect(200);
    expect(outbox).toHaveLength(0);
  });
});
