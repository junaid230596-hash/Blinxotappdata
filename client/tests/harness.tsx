// Renders the real React app against the real API and database (in-process), with real cookie sessions.
import { render } from "@testing-library/react";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { MemoryRouter } from "react-router-dom";
import App from "../src/App";
import { setFetch } from "../src/lib/api";
import { AuthProvider } from "../src/lib/auth";
import { BusinessProvider } from "../src/lib/business";
import { ToastProvider } from "../src/lib/toast";
import { createApp } from "../../server/src/app.js";
import { pool } from "../../server/src/db.js";
import { outbox } from "../../server/src/lib/email.js";
import { migrate } from "../../server/src/migrate.js";

let server: Server; let origin = "";

// jsdom's FormData cannot be sent through Node's fetch, so encode it as multipart/form-data by hand.
async function toMultipart(fd: FormData): Promise<{ body: Buffer; type: string }> {
  const boundary = `----bx${Math.random().toString(16).slice(2)}`; const parts: Buffer[] = [];
  for (const [name, value] of (fd as any).entries()) {
    if (typeof value === "string") { parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)); continue; }
    const bytes = await new Promise<Buffer>((res) => { const fr = new FileReader(); fr.onload = () => res(Buffer.from(fr.result as ArrayBuffer)); fr.readAsArrayBuffer(value as Blob); });
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${(value as File).name}"\r\nContent-Type: ${(value as File).type || "application/octet-stream"}\r\n\r\n`), bytes, Buffer.from("\r\n"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${boundary}` };
}
export const PASSWORD = "Sup3rSecret99";
const realFetch = globalThis.fetch.bind(globalThis);

/** A tiny browser-like cookie jar around fetch (httpOnly cookies, as a browser would send them). */
export class Session {
  jar = new Map<string, string>();
  fetch: typeof fetch = async (input: any, init: any = {}) => {
    const url = new URL(String(input), origin);
    const headers = new Headers(init.headers);
    if (init.body && typeof init.body !== "string" && typeof (init.body as any).entries === "function" && (init.body as any).constructor?.name === "FormData") {
      const { body, type } = await toMultipart(init.body as any); init = { ...init, body }; headers.set("content-type", type);
    } if (this.jar.size) headers.set("cookie", [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await realFetch(url, { ...init, headers });
    for (const c of res.headers.getSetCookie?.() ?? []) { const [pair, ...attrs] = c.split(";"); const [k, ...v] = pair.split("="); const val = v.join("="); if (/max-age=0|expires=thu, 01 jan 1970/i.test(attrs.join(";")) || val === "") this.jar.delete(k.trim()); else this.jar.set(k.trim(), val); }
    return res;
  };
  async req(method: string, path: string, body?: unknown) {
    const res = await this.fetch(path, { method, headers: { "Content-Type": "application/json", "X-Requested-With": "blinxot" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text(); const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
    return data;
  }
}

export async function startServer() {
  await migrate();
  server = createApp().listen(0); await new Promise((r) => server.once("listening", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
export async function stopServer() { await new Promise((r) => server.close(r)); await pool.end(); }

export async function resetDb() {
  for (const t of ["leave_requests", "performance_reviews", "employee_documents", "review_reports", "reviews", "crm_activities", "crm_leads", "crm_deals", "order_return_items", "order_returns", "order_otps", "order_items", "orders", "purchase_items", "purchases", "suppliers"]) await pool.query(`DELETE FROM ${t}`);
  await pool.query("DELETE FROM audit_logs"); await pool.query("DELETE FROM notifications"); await pool.query("DELETE FROM settings"); await pool.query("DELETE FROM platform_categories");
  await pool.query("DELETE FROM businesses"); await pool.query("DELETE FROM users"); outbox.length = 0;
}

let n = 0;
export const uniqueEmail = (p = "u") => `${p}${++n}_${Date.now()}@example.com`;
export const tokenFor = (to: string) => { const m = [...outbox].reverse().find((x) => x.to === to)?.text.match(/token=([A-Za-z0-9_-]+)/); if (!m) throw new Error(`no token mail for ${to}`); return m[1]; };
export const otpFor = (to: string) => { const m = [...outbox].reverse().find((x) => x.to === to && /delivery code/i.test(x.subject)); if (!m) throw new Error("no otp mail"); return m.text.match(/code is (\d{6})/)![1]; };

/** Creates a verified user through the API (as a seeding shortcut) and returns a logged-in API session for them. */
export async function seedUser(accountType = "business_owner", name = "Test User") {
  const s = new Session(); const email = uniqueEmail();
  await s.req("POST", "/api/auth/register", { email, password: PASSWORD, fullName: name, accountType });
  await s.req("POST", "/api/auth/verify-email", { token: tokenFor(email) });
  const login = await s.req("POST", "/api/auth/login", { email, password: PASSWORD });
  return { s, email, id: login.user.id as string };
}
export async function seedBusiness(name = `Biz ${Date.now()}`) {
  const owner = await seedUser(); const { business } = await owner.s.req("POST", "/api/businesses", { name });
  return { owner, biz: business, base: `/api/businesses/${business.id}` };
}
export async function seedEmployee(b: { owner: { s: Session }; base: string }, fullName = "Emp Loyee") {
  const email = uniqueEmail("emp");
  const { employee } = await b.owner.s.req("POST", `${b.base}/employees`, { email, fullName, position: "Cashier" });
  await new Session().req("POST", "/api/auth/reset-password", { token: tokenFor(email), password: PASSWORD });
  return { email, employeeId: employee.id as string, userId: employee.userId as string };
}

export async function otpForBuyer(buyer: { s: Session }) {
  const { notifications } = await buyer.s.req("GET", "/api/notifications?limit=100");
  const n = notifications.find((x: any) => x.type === "order.otp" && /(\d{6})\. Valid/.test(x.body ?? ""));
  if (!n) throw new Error("no delivery code notification"); return n.body.match(/(\d{6})\. Valid/)[1] as string;
}
export async function seedAdmin() {
  const u = await seedUser("individual", "Platform Admin"); await pool.query("UPDATE users SET account_type='super_admin' WHERE id=$1", [u.id]); return u;
}

export function renderApp(route = "/app", session = new Session()) {
  setFetch(session.fetch);
  const utils = render(
    <MemoryRouter initialEntries={[route]}>
      <ToastProvider><AuthProvider><BusinessProvider><App /></BusinessProvider></AuthProvider></ToastProvider>
    </MemoryRouter>,
  );
  return { ...utils, session };
}
