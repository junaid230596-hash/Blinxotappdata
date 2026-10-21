import { api as _api, PASSWORD, registerUser, tokenFromMail } from "./helpers.js";
const api = _api;

let n = 0;
export async function setup(name?: string) {
  const owner = await registerUser();
  const biz = (await api().post("/api/businesses").set(owner.auth).send({ name: name ?? `Biz ${++n} ${Date.now()}` }).expect(201)).body.business;
  return { owner, biz, id: biz.id as string, base: `/api/businesses/${biz.id}` };
}

export async function addEmployee(ctx: { owner: any; base: string }, name = "Emp") {
  const email = `emp${++n}_${Date.now()}@example.com`;
  const r = await api().post(`${ctx.base}/employees`).set(ctx.owner.auth).send({ email, fullName: name }).expect(201);
  await api().post("/api/auth/reset-password").send({ token: tokenFromMail(email), password: PASSWORD }).expect(200);
  const l = await api().post("/api/auth/login").send({ email, password: PASSWORD }).expect(200);
  return { employeeId: r.body.employee.id as string, userId: l.body.user.id as string, auth: { Authorization: `Bearer ${l.body.accessToken}` } };
}

let skuN = 0;
export async function addProduct(ctx: { owner: any; base: string }, o: any = {}) {
  const r = await api().post(`${ctx.base}/products`).set(ctx.owner.auth)
    .send({ name: `Item ${++skuN}`, sku: `SKU-${Date.now()}-${skuN}`, sellingPrice: 100, costPrice: 60, ...o }).expect(201);
  return r.body.product as any;
}

export async function stockOf(ctx: { owner: any; base: string }, productId: string): Promise<number> {
  return (await api().get(`${ctx.base}/products/${productId}`).set(ctx.owner.auth).expect(200)).body.product.stockQty;
}

import { expect } from "vitest";
import { pool } from "./helpers.js";
import { outbox } from "../server/src/lib/email.js";

export async function assertLedgerConsistent(businessId: string) {
  const { rows } = await pool.query(
    `SELECT p.stock_qty, COALESCE(sum(m.quantity_delta),0) AS s FROM products p
       LEFT JOIN inventory_movements m ON m.product_id=p.id WHERE p.business_id=$1 GROUP BY p.id`, [businessId]);
  for (const r of rows) expect(Number(r.stock_qty)).toBe(Number(r.s));
  const { rows: chain } = await pool.query(
    `SELECT balance_after, sum(quantity_delta) OVER (PARTITION BY product_id ORDER BY id) AS running FROM inventory_movements WHERE business_id=$1`, [businessId]);
  for (const r of chain) expect(Number(r.balance_after)).toBe(Number(r.running));
}

// OTP as the buyer sees it: in-app notification (business buyers) or email (customers).
export async function otpFromNotifications(auth: any): Promise<string | null> {
  const r = await api().get("/api/notifications?limit=100").set(auth).expect(200);
  const n = r.body.notifications.find((x: any) => x.type === "order.otp" && /(\d{6})\. Valid/.test(x.body ?? ""));
  return n ? n.body.match(/(\d{6})\. Valid/)[1] : null;
}
export function otpFromEmail(to: string): string | null {
  const m = [...outbox].reverse().find((x) => x.to === to && /delivery code/i.test(x.subject));
  return m ? m.text.match(/code is (\d{6})/)![1] : null;
}

// ---- step 5 helpers ----
export async function makeAdmin() {
  const u = await registerUser("individual");
  await pool.query("UPDATE users SET account_type='super_admin' WHERE id=$1", [u.id]);
  return u;
}

// Adds an existing-style member with a named business role (e.g. 'Manager') without making them an employee.
export async function addMember(ctx: { id: string }, roleName: string) {
  const u = await registerUser("individual");
  const { rows } = await pool.query("SELECT id FROM roles WHERE business_id=$1 AND name=$2", [ctx.id, roleName]);
  await pool.query("INSERT INTO business_members (business_id, user_id, role_id) VALUES ($1,$2,$3)", [ctx.id, u.id, rows[0].id]);
  return u;
}

// A deliberately tiny plan so limits are easy to hit in tests.
export async function ensureTinyPlan() {
  await pool.query(
    `INSERT INTO plans (key, name, price_monthly, limits, is_public, sort_order) VALUES ('tiny','Tiny',0,$1,false,99)
     ON CONFLICT (key) DO UPDATE SET limits=$1`, [JSON.stringify({ members: 2, products: 2, ordersPerMonth: 2, storageMb: 0.00001, businesses: 1 })]);
}
export async function putOnPlan(ctx: { id: string }, planKey: string) {
  await pool.query("UPDATE subscriptions SET plan_key=$2, status='active' WHERE business_id=$1", [ctx.id, planKey]);
}
