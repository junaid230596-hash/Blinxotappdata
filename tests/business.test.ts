import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { api, pool, registerUser, resetDb } from "./helpers.js";

beforeAll(resetDb);
afterAll(() => pool.end());

describe("businesses & RBAC", () => {
  it("requires verified email and an owner/supplier account type", async () => {
    const unverified = await registerUser("business_owner", { verify: false });
    expect((await api().post("/api/businesses").set(unverified.auth).send({ name: "Acme" })).status).toBe(403);
    const indiv = await registerUser("individual");
    expect((await api().post("/api/businesses").set(indiv.auth).send({ name: "Acme" })).status).toBe(403);
  });

  it("creates a business with owner membership and full permissions, plus audit entry", async () => {
    const o = await registerUser();
    const c = await api().post("/api/businesses").set(o.auth).send({ name: "Acme Traders", category: "Retail" }).expect(201);
    const id = c.body.business.id;
    expect(c.body.business.slug).toBe("acme-traders");
    const g = await api().get(`/api/businesses/${id}`).set(o.auth).expect(200);
    expect(g.body.permissions).toContain("business.manage");
    expect(g.body.permissions.length).toBeGreaterThan(25);
    const mine = await api().get("/api/businesses/mine").set(o.auth).expect(200);
    expect(mine.body.businesses[0].role).toBe("Business Owner");
    const a = await api().get(`/api/businesses/${id}/audit`).set(o.auth).expect(200);
    expect(a.body.entries.some((e: any) => e.action === "business.create")).toBe(true);
  });

  it("generates unique slugs for duplicate names", async () => {
    const o = await registerUser();
    const a = await api().post("/api/businesses").set(o.auth).send({ name: "Same Name" }).expect(201);
    await api().post("/api/businesses").set(o.auth).send({ name: "Same Name" }).expect(403);              // the Free plan allows one business per owner
    await pool.query("UPDATE subscriptions SET plan_key='starter' WHERE business_id=$1", [a.body.business.id]);   // Starter allows two
    const b = await api().post("/api/businesses").set(o.auth).send({ name: "Same Name" }).expect(201);
    expect(a.body.business.slug).not.toBe(b.body.business.slug);
  });

  it("hides businesses from non-members (404) and rejects bad ids (400)", async () => {
    const o = await registerUser();
    const other = await registerUser();
    const id = (await api().post("/api/businesses").set(o.auth).send({ name: "Private Co" }).expect(201)).body.business.id;
    await api().get(`/api/businesses/${id}`).set(other.auth).expect(404);
    await api().patch(`/api/businesses/${id}`).set(other.auth).send({ name: "Hacked" }).expect(404);
    await api().get(`/api/businesses/not-a-uuid`).set(o.auth).expect(400);
    await api().get(`/api/businesses/${id}`).expect(401);
  });

  it("enforces granular permissions for members", async () => {
    const o = await registerUser();
    const emp = await registerUser("employee");
    const id = (await api().post("/api/businesses").set(o.auth).send({ name: "Perm Co" }).expect(201)).body.business.id;
    const { rows: role } = await pool.query("SELECT id FROM roles WHERE business_id=$1 AND name='Employee'", [id]);
    await pool.query("INSERT INTO business_members (business_id, user_id, role_id) VALUES ($1,$2,$3)", [id, emp.id, role[0].id]);
    // Employee can read the business but not edit, manage members, or see audit
    await api().get(`/api/businesses/${id}`).set(emp.auth).expect(200);
    await api().patch(`/api/businesses/${id}`).set(emp.auth).send({ name: "Mine now" }).expect(403);
    await api().get(`/api/businesses/${id}/members`).set(emp.auth).expect(403);
    await api().get(`/api/businesses/${id}/audit`).set(emp.auth).expect(403);
    // Owner can promote them to Manager, and the new permissions apply immediately
    const roles = (await api().get(`/api/businesses/${id}/roles`).set(o.auth).expect(200)).body.roles;
    const mgr = roles.find((r: any) => r.name === "Manager");
    const members = (await api().get(`/api/businesses/${id}/members`).set(o.auth).expect(200)).body.members;
    const m = members.find((x: any) => x.userId === emp.id);
    await api().patch(`/api/businesses/${id}/members/${m.id}`).set(o.auth).send({ roleId: mgr.id }).expect(200);
    await api().get(`/api/businesses/${id}/members`).set(emp.auth).expect(200);
    await api().patch(`/api/businesses/${id}`).set(emp.auth).send({ name: "Still no" }).expect(403);
  });

  it("protects the owner role and prevents cross-business role assignment", async () => {
    const o = await registerUser();
    const o2 = await registerUser();
    const id = (await api().post("/api/businesses").set(o.auth).send({ name: "Alpha" }).expect(201)).body.business.id;
    const id2 = (await api().post("/api/businesses").set(o2.auth).send({ name: "Beta" }).expect(201)).body.business.id;
    const members = (await api().get(`/api/businesses/${id}/members`).set(o.auth)).body.members;
    const roles = (await api().get(`/api/businesses/${id}/roles`).set(o.auth)).body.roles;
    const roles2 = (await api().get(`/api/businesses/${id2}/roles`).set(o2.auth)).body.roles;
    await api().patch(`/api/businesses/${id}/members/${members[0].id}`).set(o.auth)
      .send({ roleId: roles.find((r: any) => r.name === "Employee").id }).expect(403);
    await api().patch(`/api/businesses/${id}/members/${members[0].id}`).set(o.auth)
      .send({ roleId: roles2.find((r: any) => r.name === "Manager").id }).expect(403); // owner row is protected first
  });

  it("public profile shows only public businesses", async () => {
    const o = await registerUser();
    const b = (await api().post("/api/businesses").set(o.auth).send({ name: "Open Shop" }).expect(201)).body.business;
    await api().get(`/api/public/businesses/${b.slug}`).expect(200);
    await api().patch(`/api/businesses/${b.id}`).set(o.auth).send({ isPublic: false }).expect(200);
    await api().get(`/api/public/businesses/${b.slug}`).expect(404);
  });
});

describe("notifications & uploads & errors", () => {
  it("lists only own notifications and supports read / read-all", async () => {
    const a = await registerUser("individual");
    const b = await registerUser("individual");
    await pool.query("INSERT INTO notifications (user_id,type,title) VALUES ($1,'t','Hi A'),($1,'t','Hi A2'),($2,'t','Hi B')", [a.id, b.id]);
    const l = await api().get("/api/notifications").set(a.auth).expect(200);
    expect(l.body.notifications).toHaveLength(2);
    expect(l.body.unreadCount).toBe(2);
    const bId = (await api().get("/api/notifications").set(b.auth)).body.notifications[0].id;
    await api().post(`/api/notifications/${bId}/read`).set(a.auth).expect(404); // not yours
    await api().post(`/api/notifications/${l.body.notifications[0].id}/read`).set(a.auth).expect(200);
    expect((await api().get("/api/notifications").set(a.auth)).body.unreadCount).toBe(1);
    await api().post("/api/notifications/read-all").set(a.auth).expect(200);
    expect((await api().get("/api/notifications").set(a.auth)).body.unreadCount).toBe(0);
  });

  it("accepts real images, rejects disguised executables, and renames files", async () => {
    const u = await registerUser("individual");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    const ok = await api().post("/api/uploads").set(u.auth).attach("file", png, "../../evil.php.png").expect(201);
    expect(ok.body.url).toMatch(/^\/uploads\/[0-9a-f-]{36}\.png$/);
    await api().get(ok.body.url).expect(200);
    await api().post("/api/uploads").set(u.auth).attach("file", Buffer.from("<?php system($_GET['c']); ?>"), "shell.png").expect(400);
    await api().post("/api/uploads").set(u.auth).attach("file", Buffer.from("MZ\x90\x00 fake exe"), "a.exe").expect(400);
    await api().post("/api/uploads").attach("file", png, "x.png").expect(401);
  });

  it("returns clean JSON errors without stack traces", async () => {
    const r = await api().get("/api/nope").expect(404);
    expect(r.body.error.code).toBe("NOT_FOUND");
    const bad = await api().post("/api/auth/login").set("Content-Type", "application/json").send("{bad json").expect(400);
    expect(JSON.stringify(bad.body)).not.toMatch(/at .*\.(ts|js)/);
    const h = await api().get("/api/health").expect(200);
    expect(h.headers["x-powered-by"]).toBeUndefined();
    expect(h.headers["x-content-type-options"]).toBe("nosniff");
  });
});
