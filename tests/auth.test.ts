import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { api, PASSWORD, pool, registerUser, resetDb, tokenFromMail } from "./helpers.js";
import { outbox } from "../server/src/lib/email.js";

beforeAll(resetDb);
afterAll(() => pool.end());

describe("registration & verification", () => {
  it("registers, sends a verification email, and never returns the password hash", async () => {
    const r = await api().post("/api/auth/register").send({ email: "A@Example.com", password: PASSWORD, fullName: "Ann", accountType: "individual" });
    expect(r.status).toBe(201);
    expect(r.body.user.email).toBe("a@example.com");
    expect(JSON.stringify(r.body)).not.toMatch(/password|hash/i);
    expect(r.body.user.emailVerified).toBe(false);
    await api().post("/api/auth/verify-email").send({ token: tokenFromMail("a@example.com") }).expect(200);
    const l = await api().post("/api/auth/login").send({ email: "a@example.com", password: PASSWORD });
    expect(l.body.user.emailVerified).toBe(true);
  });

  it("rejects weak passwords, bad account types (no self-registered super_admin), and duplicates", async () => {
    const base = { email: "dup@example.com", fullName: "D", accountType: "individual" };
    expect((await api().post("/api/auth/register").send({ ...base, password: "short1" })).status).toBe(400);
    expect((await api().post("/api/auth/register").send({ ...base, password: "onlyletterslong" })).status).toBe(400);
    expect((await api().post("/api/auth/register").send({ ...base, password: PASSWORD, accountType: "super_admin" })).status).toBe(400);
    expect((await api().post("/api/auth/register").send({ ...base, password: PASSWORD })).status).toBe(201);
    expect((await api().post("/api/auth/register").send({ ...base, password: PASSWORD })).status).toBe(409);
  });

  it("verification tokens are single-use", async () => {
    await api().post("/api/auth/register").send({ email: "once@example.com", password: PASSWORD, fullName: "O", accountType: "individual" });
    const t = tokenFromMail("once@example.com");
    await api().post("/api/auth/verify-email").send({ token: t }).expect(200);
    await api().post("/api/auth/verify-email").send({ token: t }).expect(400);
  });
});

describe("login, lockout, sessions", () => {
  it("gives identical errors for unknown email and wrong password", async () => {
    const u = await registerUser("individual");
    const a = await api().post("/api/auth/login").send({ email: u.email, password: "Wrong12345678" });
    const b = await api().post("/api/auth/login").send({ email: "nobody@example.com", password: "Wrong12345678" });
    expect(a.status).toBe(401); expect(b.status).toBe(401);
    expect(a.body.error.message).toBe(b.body.error.message);
  });

  it("locks the account after 5 failures, even for the right password", async () => {
    const u = await registerUser("individual");
    for (let i = 0; i < 5; i++) await api().post("/api/auth/login").send({ email: u.email, password: "Wrong12345678" }).expect(401);
    const r = await api().post("/api/auth/login").send({ email: u.email, password: PASSWORD });
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe("ACCOUNT_LOCKED");
  });

  it("/me needs auth; bearer token works", async () => {
    await api().get("/api/auth/me").expect(401);
    const u = await registerUser("individual");
    const r = await api().get("/api/auth/me").set(u.auth).expect(200);
    expect(r.body.user.id).toBe(u.id);
  });

  it("rotates refresh tokens and revokes everything on reuse", async () => {
    const u = await registerUser("individual");
    const r1 = await api().post("/api/auth/refresh").send({ refreshToken: u.refresh }).expect(200);
    expect(r1.body.refreshToken).not.toBe(u.refresh);
    // replaying the old (rotated) token is treated as theft
    await api().post("/api/auth/refresh").send({ refreshToken: u.refresh }).expect(401);
    // ...and the newer token is now dead too
    await api().post("/api/auth/refresh").send({ refreshToken: r1.body.refreshToken }).expect(401);
  });

  it("logout revokes the refresh token", async () => {
    const u = await registerUser("individual");
    await api().post("/api/auth/logout").set(u.auth).send({ refreshToken: u.refresh }).expect(200);
    await api().post("/api/auth/refresh").send({ refreshToken: u.refresh }).expect(401);
  });

  it("suspended users cannot log in or use existing tokens", async () => {
    const u = await registerUser("individual");
    await pool.query("UPDATE users SET status='suspended' WHERE id=$1", [u.id]);
    await api().get("/api/auth/me").set(u.auth).expect(401);
    expect((await api().post("/api/auth/login").send({ email: u.email, password: PASSWORD })).status).toBe(403);
  });
});

describe("password reset", () => {
  it("does not reveal whether an email exists", async () => {
    const before = outbox.length;
    const r = await api().post("/api/auth/forgot-password").send({ email: "ghost@example.com" });
    expect(r.status).toBe(200);
    expect(outbox.length).toBe(before);
  });

  it("resets the password, kills old sessions, and the token is single-use", async () => {
    const u = await registerUser("individual");
    await api().post("/api/auth/forgot-password").send({ email: u.email }).expect(200);
    const t = tokenFromMail(u.email);
    await api().post("/api/auth/reset-password").send({ token: t, password: "BrandNew12345" }).expect(200);
    await api().post("/api/auth/reset-password").send({ token: t, password: "AnotherOne12345" }).expect(400);
    await api().post("/api/auth/refresh").send({ refreshToken: u.refresh }).expect(401);
    await api().post("/api/auth/login").send({ email: u.email, password: PASSWORD }).expect(401);
    await api().post("/api/auth/login").send({ email: u.email, password: "BrandNew12345" }).expect(200);
    expect(outbox.some((m) => m.to === u.email && /changed/i.test(m.subject))).toBe(true);
  });

  it("change-password requires the current password", async () => {
    const u = await registerUser("individual");
    await api().post("/api/auth/change-password").set(u.auth).send({ currentPassword: "nope", newPassword: "BrandNew12345" }).expect(400);
    await api().post("/api/auth/change-password").set(u.auth).send({ currentPassword: PASSWORD, newPassword: "BrandNew12345" }).expect(200);
  });
});

describe("csrf guard", () => {
  it("blocks cookie-authenticated writes without the custom header", async () => {
    const u = await registerUser("individual");
    const cookie = `bx_at=${u.token}`;
    await api().post("/api/notifications/read-all").set("Cookie", cookie).expect(403);
    await api().post("/api/notifications/read-all").set("Cookie", cookie).set("X-Requested-With", "blinxot").expect(200);
  });
});
