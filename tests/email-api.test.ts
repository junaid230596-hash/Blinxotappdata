import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// A fake Brevo/Resend API that records requests and answers with whatever the test sets.
let server: http.Server; let url = ""; const seen: { method?: string; path?: string; headers: http.IncomingHttpHeaders; body: any }[] = [];
let reply: { status: number; body: string } = { status: 201, body: "{}" };
beforeAll(async () => {
  server = http.createServer((req, res) => { let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => { seen.push({ method: req.method, path: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null }); res.writeHead(reply.status, { "content-type": "application/json" }); res.end(reply.body); }); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r)); url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const KEY = "xkeysib-SECRET-KEY-123";
async function load(env: Record<string, string | undefined>) {
  const saved = { ...process.env };
  for (const k of ["BREVO_API_KEY", "RESEND_API_KEY", "EMAIL_PROVIDER", "SMTP_HOST", "TRUST_PROXY"]) delete process.env[k];
  Object.assign(process.env, { SMTP_FROM: "Blinxot <hello@blinxot.example>", APP_URL: "https://blinxot.example", BREVO_API_URL: url, RESEND_API_URL: url }, env);
  vi.resetModules(); const mod = await import("../server/src/lib/email.js"); const cfg = await import("../server/src/config.js"); process.env = saved; return { ...mod, config: cfg.config };
}

describe("choosing the email provider", () => {
  it("prefers Brevo, then Resend, then SMTP, and can be forced", async () => {
    expect((await load({ BREVO_API_KEY: KEY, RESEND_API_KEY: "re_x", SMTP_HOST: "smtp.x.test" })).emailProvider()).toBe("brevo");
    expect((await load({ RESEND_API_KEY: "re_x", SMTP_HOST: "smtp.x.test" })).emailProvider()).toBe("resend");
    expect((await load({ SMTP_HOST: "smtp.x.test" })).emailProvider()).toBe("smtp");
    expect((await load({})).emailProvider()).toBeNull();
    expect((await load({ BREVO_API_KEY: KEY, SMTP_HOST: "smtp.x.test", EMAIL_PROVIDER: "smtp" })).emailProvider()).toBe("smtp");
    expect((await load({ EMAIL_PROVIDER: "brevo" })).emailProvider()).toBeNull();                        // forced but no key: nothing to send with
  });
  it("parses the From address", async () => {
    const { parseFrom } = await load({});
    expect(parseFrom("Blinxot <hello@blinxot.example>")).toEqual({ name: "Blinxot", email: "hello@blinxot.example" });
    expect(parseFrom('"JD Web, Studio" <a@b.co>')).toEqual({ name: "JD Web, Studio", email: "a@b.co" });
    expect(parseFrom("plain@b.co")).toEqual({ name: undefined, email: "plain@b.co" });
  });
});

describe("sending through the Brevo and Resend HTTP APIs", () => {
  it("sends the right request to Brevo (HTTPS API, so it works where SMTP ports are blocked)", async () => {
    const { sendMail, mails } = await load({ BREVO_API_KEY: KEY }); seen.length = 0; reply = { status: 201, body: '{"messageId":"<1@x>"}' };
    await sendMail(mails.verify("new@user.test", "Asha <b>", "tok9"));
    const r = seen[0]; expect(r.method).toBe("POST"); expect(r.path).toBe("/v3/smtp/email"); expect(r.headers["api-key"]).toBe(KEY);
    expect(r.body).toMatchObject({ sender: { name: "Blinxot", email: "hello@blinxot.example" }, to: [{ email: "new@user.test" }], subject: "Verify your Blinxot email" });
    expect(r.body.textContent).toContain("https://blinxot.example/verify-email?token=tok9");
    expect(r.body.htmlContent).toContain("Verify email"); expect(r.body.htmlContent).toContain("Asha &lt;b&gt;"); expect(r.body.htmlContent).not.toContain("Asha <b>");
    expect(r.body.headers["Auto-Submitted"]).toBe("auto-generated");
  });

  it("sends the right request to Resend, including reply-to", async () => {
    const { sendMail } = await load({ RESEND_API_KEY: "re_secret_key" }); seen.length = 0; reply = { status: 200, body: '{"id":"abc"}' };
    await sendMail({ to: "x@y.test", subject: "Hi", text: "Body", html: "<p>Body</p>", replyTo: "visitor@z.test" });
    const r = seen[0]; expect(r.path).toBe("/emails"); expect(r.headers.authorization).toBe("Bearer re_secret_key");
    expect(r.body).toMatchObject({ from: "Blinxot <hello@blinxot.example>", to: ["x@y.test"], subject: "Hi", text: "Body", html: "<p>Body</p>", reply_to: "visitor@z.test" });
  });

  it("never throws into the request when the provider fails, and explains the common failures", async () => {
    const { sendMail, sendViaApi } = await load({ BREVO_API_KEY: KEY });
    reply = { status: 401, body: '{"message":"Key not found","code":"unauthorized"}' };
    await expect(sendMail({ to: "a@b.test", subject: "s", text: "t" })).resolves.toBeUndefined();          // registration must not fail because email failed
    const err = await sendViaApi("brevo", { to: "a@b.test", subject: "s", text: "t" }).catch((e) => e);
    expect(err.responseCode).toBe(401); expect(err.hint).toMatch(/BREVO_API_KEY was rejected/); expect(JSON.stringify([err.message, err.hint])).not.toContain(KEY);   // the key never appears in errors
    reply = { status: 400, body: '{"message":"Sender is not valid / not verified","code":"invalid_parameter"}' };
    expect((await sendViaApi("brevo", { to: "a@b.test", subject: "s", text: "t" }).catch((e) => e)).hint).toMatch(/verified sender/);
    const r = await load({ RESEND_API_KEY: "re_k" });
    reply = { status: 403, body: '{"message":"You can only send testing emails to your own email address"}' };
    expect((await r.sendViaApi("resend", { to: "a@b.test", subject: "s", text: "t" }).catch((e) => e)).hint).toMatch(/verified domain/);
    reply = { status: 429, body: "{}" }; expect((await r.sendViaApi("resend", { to: "a@b.test", subject: "s", text: "t" }).catch((e) => e)).hint).toMatch(/limit/);
  });

  it("checks the API key without sending anything", async () => {
    const b = await load({ BREVO_API_KEY: KEY }); seen.length = 0;
    reply = { status: 200, body: "{}" }; expect(await b.diagnoseApiProvider("brevo")).toEqual({ ok: true }); expect(seen[0].path).toBe("/v3/account");
    reply = { status: 401, body: "{}" }; expect(await b.diagnoseApiProvider("brevo")).toMatchObject({ ok: false, code: "HTTP_401" });
    const r = await load({ RESEND_API_KEY: "re_k" });
    reply = { status: 403, body: '{"name":"restricted_api_key","message":"This API key is restricted to only send emails"}' }; expect(await r.diagnoseApiProvider("resend")).toEqual({ ok: true });   // "sending access" keys are valid
    reply = { status: 401, body: '{"name":"validation_error"}' }; expect(await r.diagnoseApiProvider("resend")).toMatchObject({ ok: false });
    const down = await load({ BREVO_API_KEY: KEY, BREVO_API_URL: "http://127.0.0.1:1" }); expect(await down.diagnoseApiProvider("brevo")).toMatchObject({ ok: false, code: "NETWORK" });
  });
});

describe("proxy trust (needed when Vercel forwards to Render)", () => {
  it("TRUST_PROXY sets how many proxies the app trusts, defaulting to 1", async () => {
    expect((await load({ TRUST_PROXY: "2" })).config.TRUST_PROXY).toBe(2);
    expect((await load({})).config.TRUST_PROXY).toBe(1);
    const saved = { ...process.env }; Object.assign(process.env, { TRUST_PROXY: "2" }); vi.resetModules();
    const app = (await import("../server/src/app.js")).createApp(); process.env = saved;
    expect(app.get("trust proxy")).toBe(2);
  });
});
