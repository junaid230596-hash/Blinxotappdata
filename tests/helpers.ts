import request from "supertest";
import { createApp } from "../server/src/app.js";
import { pool } from "../server/src/db.js";
import { migrate } from "../server/src/migrate.js";
import { outbox } from "../server/src/lib/email.js";

export const app = createApp();
export const api = () => request(app);

export async function resetDb() {
  await migrate();
  // Delete per-test data only; system roles/permissions (business_id IS NULL) are seed data and must survive.
  await pool.query("DELETE FROM audit_logs"); await pool.query("DELETE FROM settings"); await pool.query("DELETE FROM platform_categories");
  await pool.query("DELETE FROM notifications");
  // Commerce history references products with NO ACTION (products are never hard-deleted in the app),
  // so clear it in dependency order before removing businesses.
  for (const t of ["leave_requests", "performance_reviews", "employee_documents", "review_reports", "reviews", "crm_activities", "crm_leads", "crm_deals", "order_return_items", "order_returns", "order_otps", "order_items", "orders", "purchase_items", "purchases", "suppliers"]) await pool.query(`DELETE FROM ${t}`);
  await pool.query("DELETE FROM businesses");
  await pool.query("DELETE FROM users");
  outbox.length = 0;
}

export const PASSWORD = "Sup3rSecret99";
let n = 0;

export function tokenFromMail(to: string): string {
  const mail = [...outbox].reverse().find((m) => m.to === to);
  const m = mail?.text.match(/token=([A-Za-z0-9_-]+)/);
  if (!m) throw new Error(`No token email for ${to}`);
  return m[1];
}

export async function registerUser(accountType = "business_owner", opts: { verify?: boolean } = {}) {
  const email = `user${++n}_${Date.now()}@example.com`;
  // Employees cannot self-register (owners create them); simulate that by promoting an individual account.
  const regType = accountType === "employee" ? "individual" : accountType;
  const r = await api().post("/api/auth/register").send({ email, password: PASSWORD, fullName: "Test User", accountType: regType });
  if (r.status !== 201) throw new Error(`register failed: ${JSON.stringify(r.body)}`);
  if (opts.verify !== false) {
    await api().post("/api/auth/verify-email").send({ token: tokenFromMail(email) }).expect(200);
  }
  if (accountType === "employee") await pool.query("UPDATE users SET account_type='employee' WHERE email=$1", [email]);
  const l = await api().post("/api/auth/login").send({ email, password: PASSWORD }).expect(200);
  return { email, id: l.body.user.id as string, token: l.body.accessToken as string, refresh: l.body.refreshToken as string,
    auth: { Authorization: `Bearer ${l.body.accessToken}` } };
}

export { pool };
