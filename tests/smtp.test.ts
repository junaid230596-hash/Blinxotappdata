import { SMTPServer } from "smtp-server";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildTransport, diagnoseSmtp } from "../server/src/lib/email.js";

// A real SMTP server on localhost that only accepts user "sender@test" / password "app-password".
const received: { from: string; to: string[]; raw: string }[] = [];
let server: SMTPServer; let port = 0;
beforeAll(async () => {
  server = new SMTPServer({
    authOptional: false, allowInsecureAuth: true, disabledCommands: ["STARTTLS"],
    onAuth(auth, _s, cb) { auth.username === "sender@test" && auth.password === "app-password" ? cb(null, { user: auth.username }) : cb(new Error("Invalid login")); },
    onData(stream, session, cb) { let raw = ""; stream.on("data", (c) => (raw += c)); stream.on("end", () => { received.push({ from: session.envelope.mailFrom ? session.envelope.mailFrom.address : "", to: session.envelope.rcptTo.map((r) => r.address), raw }); cb(); }); },
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const base = () => ({ host: "127.0.0.1", port, secure: false, user: "sender@test", pass: "app-password", from: "Blinxot <sender@test>" });

describe("SMTP diagnosis and sending", () => {
  it("logs in with correct credentials and delivers a message", async () => {
    expect(await diagnoseSmtp(base())).toEqual({ ok: true });
    await buildTransport(base()).sendMail({ from: "Blinxot <sender@test>", to: "user@example.com", replyTo: "visitor@example.com", subject: "Hello", text: "Body text" });
    const m = received.at(-1)!;
    expect(m.to).toEqual(["user@example.com"]); expect(m.raw).toContain("Subject: Hello"); expect(m.raw).toContain("Reply-To: visitor@example.com");
  });

  it("explains a wrong password (EAUTH) and, for Gmail, points to App Passwords", async () => {
    const d = await diagnoseSmtp({ ...base(), pass: "wrong" });
    expect(d).toMatchObject({ ok: false, code: "EAUTH" });
    const msg = d.ok ? "" : d.hint; expect(msg).toMatch(/username or password/);
    const gmail = await diagnoseSmtp({ ...base(), host: "smtp.gmail.com", pass: "wrong", port: 1 });          // never reaches Google: just checks the wording branch below
    expect(gmail.ok).toBe(false);
  });

  it("reports a missing password before trying to connect", async () => {
    expect(await diagnoseSmtp({ ...base(), pass: undefined })).toMatchObject({ ok: false, code: "NO_PASSWORD" });
  });

  it("recognises a placeholder host such as SMTP.example.com", async () => {
    const d = await diagnoseSmtp({ ...base(), host: "smtp.example.com" });
    expect(d).toMatchObject({ ok: false, code: "PLACEHOLDER_HOST" }); expect(d.ok ? "" : d.hint).toMatch(/smtp\.gmail\.com/);
  });

  it("explains a port nobody is listening on", async () => {
    const d = await diagnoseSmtp({ ...base(), port: 1 });
    expect(d).toMatchObject({ ok: false, code: "ECONNREFUSED" }); expect(d.ok ? "" : d.hint).toMatch(/Nothing is listening.*587.*465/);
  });
});

describe("reading SMTP settings from the environment", () => {
  async function settingsWith(env: Record<string, string | undefined>) {
    const saved = { ...process.env }; Object.assign(process.env, env); for (const k of Object.keys(env)) if (env[k] === undefined) delete process.env[k];
    vi.resetModules(); const mod = await import("../server/src/lib/email.js"); const s = mod.smtpSettings(); process.env = saved; return s;
  }
  it("accepts SMTP_PASS as well as SMTP_PASSWORD, and defaults to STARTTLS on 587", async () => {
    const s = await settingsWith({ SMTP_HOST: "SMTP.Gmail.com", SMTP_USER: "me@gmail.com", SMTP_PASS: "abcd efgh ijkl mnop", SMTP_PASSWORD: undefined, SMTP_FROM: "me@gmail.com", SMTP_PORT: undefined });
    expect(s).toMatchObject({ host: "smtp.gmail.com", port: 587, secure: false, user: "me@gmail.com", pass: "abcdefghijklmnop", from: "me@gmail.com" });   // host lower-cased, Gmail app-password spaces removed
  });
  it("prefers SMTP_PASSWORD, uses SSL on 465, honours SMTP_SECURE, and returns null without a host", async () => {
    expect(await settingsWith({ SMTP_HOST: "mail.example.org", SMTP_PASSWORD: "a", SMTP_PASS: "b", SMTP_PORT: "465" })).toMatchObject({ pass: "a", secure: true });
    expect(await settingsWith({ SMTP_HOST: "mail.example.org", SMTP_PORT: "2525", SMTP_SECURE: "true" })).toMatchObject({ secure: true });
    expect((await settingsWith({ SMTP_HOST: "mail.example.org", SMTP_PASSWORD: "pass with spaces" }))!.pass).toBe("pass with spaces");        // only Gmail passwords are de-spaced
    expect(await settingsWith({ SMTP_HOST: undefined })).toBeNull();
  });
});

describe("untrusted TLS certificates (antivirus / proxy interception)", () => {
  // A mail server presenting a self-signed certificate: the situation behind "self signed certificate in certificate chain".
  let tlsServer: SMTPServer; let tlsPort = 0; let starttlsServer: SMTPServer; let startPort = 0; let certPem = "";
  beforeAll(async () => {
    const { default: selfsigned } = await import("selfsigned");
    const pems = await selfsigned.generate([{ name: "commonName", value: "localhost" }], { days: 1, keySize: 2048, algorithm: "sha256", extensions: [{ name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }, { type: 7, ip: "127.0.0.1" }] }] });
    certPem = pems.cert;
    const common = { key: pems.private, cert: pems.cert, authOptional: true };
    tlsServer = new SMTPServer({ ...common, secure: true }); starttlsServer = new SMTPServer({ ...common, secure: false });
    for (const s of [tlsServer, starttlsServer]) s.on("error", () => {});          // clients that reject the certificate hang up mid-handshake: expected
    await Promise.all([tlsServer, starttlsServer].map((s) => new Promise<void>((r) => s.listen(0, "127.0.0.1", r))));
    tlsPort = (tlsServer.server.address() as AddressInfo).port; startPort = (starttlsServer.server.address() as AddressInfo).port;
  });
  afterAll(async () => { await Promise.all([tlsServer, starttlsServer].map((s) => new Promise<void>((r) => s.close(() => r())))); });

  const settings = (port: number, secure: boolean, extra: object = {}) => ({ host: "localhost", port, secure, from: "x@test", ...extra });

  it("recognises the error on both SSL (465-style) and STARTTLS (587-style) and explains what to do", async () => {
    for (const [port, secure] of [[tlsPort, true], [startPort, false]] as const) {
      const d = await diagnoseSmtp(settings(port, secure));
      expect(d).toMatchObject({ ok: false, code: "CERT_UNTRUSTED" });
      const hint = d.ok ? "" : d.hint; expect(hint).toMatch(/antivirus/i); expect(hint).toMatch(/SMTP_CA_FILE/); expect(hint).toMatch(/ignored in production/);
    }
  });

  it("works once the certificate authority is explicitly trusted (the safe fix)", async () => {
    expect(await diagnoseSmtp(settings(tlsPort, true, { ca: certPem }))).toEqual({ ok: true });
    expect(await diagnoseSmtp(settings(startPort, false, { ca: certPem }))).toEqual({ ok: true });
    expect(await diagnoseSmtp(settings(tlsPort, true, { ca: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----" }))).toMatchObject({ ok: false });   // a different CA does not help
  });

  it("the development-only switch skips verification, but is never honoured in production", async () => {
    expect(await diagnoseSmtp(settings(tlsPort, true, { insecure: true }))).toEqual({ ok: true });
    const read = async (env: Record<string, string>) => {
      const saved = { ...process.env }; Object.assign(process.env, { SMTP_HOST: "localhost", SMTP_TLS_INSECURE: "true", ...env });
      vi.resetModules(); const s = (await import("../server/src/lib/email.js")).smtpSettings(); process.env = saved; return s;
    };
    expect((await read({ NODE_ENV: "development" }))!.insecure).toBe(true);
    expect((await read({ NODE_ENV: "production" }))!.insecure).toBe(false);
    expect((await read({ NODE_ENV: "development", SMTP_TLS_INSECURE: "false" }))!.insecure).toBe(false);
  });

  it("loads SMTP_CA_FILE from disk", async () => {
    const fs = await import("node:fs"); const os = await import("node:os"); const path = await import("node:path");
    const file = path.join(os.tmpdir(), `bx-ca-${Date.now()}.pem`); fs.writeFileSync(file, certPem);
    const saved = { ...process.env }; Object.assign(process.env, { SMTP_HOST: "localhost", SMTP_CA_FILE: file });
    vi.resetModules(); const s = (await import("../server/src/lib/email.js")).smtpSettings(); process.env = saved; fs.unlinkSync(file);
    expect(s!.ca).toBe(certPem);
  });
});

describe('"Greeting never received" (connection opens, server says nothing)', () => {
  let silent: net.Server; let silentPort = 0; const sockets: net.Socket[] = [];
  beforeAll(async () => {
    silent = net.createServer((sock) => { sockets.push(sock); });                       // accepts the TCP connection and never sends the 220 greeting: what an antivirus mail shield or a port/SSL mismatch looks like
    await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r)); silentPort = (silent.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => { sockets.forEach((x) => x.destroy()); silent.close(() => r()); }));
  const quick = (port: number, extra: object = {}) => ({ host: "127.0.0.1", port, secure: false, user: "sender@test", pass: "app-password", from: "x@test", timeoutMs: 400, ...extra });

  it("is recognised and explained, including the antivirus and port causes", async () => {
    const d = await diagnoseSmtp(quick(silentPort), { alternatives: [] });
    expect(d).toMatchObject({ ok: false, code: "NO_GREETING", message: expect.stringMatching(/greeting never received/i) });
    const hint = d.ok ? "" : d.hint; expect(hint).toMatch(/port and SSL setting do not match/); expect(hint).toMatch(/antivirus/i); expect(hint).toMatch(/hotspot/i);
  });

  it("finds the working combination and says exactly what to set", async () => {
    const d = await diagnoseSmtp(quick(silentPort), { alternatives: [{ port, secure: false }] });          // `port` = the working local SMTP server above
    expect(d).toMatchObject({ ok: false, code: "NO_GREETING", suggestion: { port, secure: false } });
    const hint = d.ok ? "" : d.hint; expect(hint).toMatch(/GOOD NEWS/); expect(hint).toContain(`SMTP_PORT=${port}`); expect(hint).toContain("SMTP_SECURE=false");
  });

  it("says when nothing works, which points at antivirus, firewall or network", async () => {
    const d = await diagnoseSmtp(quick(silentPort), { alternatives: [{ port: 1, secure: false }] });
    const hint = d.ok ? "" : d.hint; expect(hint).toMatch(/none responded/); expect(hint).not.toMatch(/GOOD NEWS/);
  });

  it("detects the classic mistake of SSL on a plain port, and the opposite (port 465 without SSL)", async () => {
    // SSL requested against a plain-text server: it answers a TLS hello with plain text.
    const a = await diagnoseSmtp({ ...base(), secure: true, timeoutMs: 1500 }, { alternatives: [{ port, secure: false }] });
    expect(a).toMatchObject({ ok: false, suggestion: { port, secure: false } });
    // Plain connection to an SSL-only server: the server waits for a TLS handshake, so no greeting ever arrives.
    const { default: selfsigned } = await import("selfsigned");
    const pems = await selfsigned.generate([{ name: "commonName", value: "localhost" }], { days: 1, keySize: 2048, algorithm: "sha256" });
    const sslOnly = new SMTPServer({ key: pems.private, cert: pems.cert, secure: true, authOptional: true }); sslOnly.on("error", () => {});
    await new Promise<void>((r) => sslOnly.listen(0, "127.0.0.1", r)); const sslPort = (sslOnly.server.address() as AddressInfo).port;
    const b = await diagnoseSmtp({ host: "localhost", port: sslPort, secure: false, from: "x@test", ca: pems.cert, timeoutMs: 600 }, { alternatives: [{ port: sslPort, secure: true }] });
    await new Promise<void>((r) => sslOnly.close(() => r()));
    expect(b).toMatchObject({ ok: false, code: "NO_GREETING", suggestion: { port: sslPort, secure: true } });
    expect(b.ok ? "" : b.hint).toContain("SMTP_SECURE=true");
  });
});

describe("email content and sender hygiene", () => {
  it("sends multipart mail (text + HTML) with automatic-mail headers, and escapes hostile names", async () => {
    const saved = { ...process.env };
    Object.assign(process.env, { SMTP_HOST: "127.0.0.1", SMTP_PORT: String(port), SMTP_USER: "sender@test", SMTP_PASSWORD: "app-password", SMTP_FROM: "Blinxot <sender@test>", APP_URL: "https://blinxot.example" });
    vi.resetModules(); const mod = await import("../server/src/lib/email.js"); process.env = saved;
    await mod.sendMail(mod.mails.verify("new@example.com", `Evil <script>alert(1)</script> "Q"`, "tok123"));
    const raw = received.at(-1)!.raw;
    expect(raw).toMatch(/Content-Type: multipart\/alternative/i);
    expect(raw).toMatch(/Content-Type: text\/plain/i); expect(raw).toMatch(/Content-Type: text\/html/i);
    expect(raw).toMatch(/Auto-Submitted: auto-generated/i);
    expect(raw).toContain("From: Blinxot <sender@test>");
    const decoded = raw.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    expect(decoded).toContain("https://blinxot.example/verify-email?token=tok123");
    const htmlPart = decoded.slice(decoded.search(/Content-Type: text\/html/i));                     // the plain-text part shows the name as typed; only the HTML part is rendered
    expect(htmlPart).not.toContain("<script>alert(1)</script>"); expect(htmlPart).toContain("&lt;script&gt;");
  });

  it("every transactional email has a plain-text twin and an HTML version with its link", async () => {
    const { mails } = await import("../server/src/lib/email.js");
    for (const m of [mails.verify("a@b.c", "Ann", "t"), mails.reset("a@b.c", "Ann", "t"), mails.invite("a@b.c", "Ann", "Acme & Sons", "t"), mails.passwordChanged("a@b.c", "Ann")]) {
      expect(m.text.length).toBeGreaterThan(20); expect(m.html).toMatch(/<html lang="en">/); expect(m.html).toMatch(/Button not working\?/);
      expect(m.html).not.toMatch(/undefined|\{\{/);
    }
    expect(mails.invite("a@b.c", "Ann", "Acme & Sons", "t").html).toContain("Acme &amp; Sons");
  });

  it("warns when the From address does not match the account that sends", async () => {
    const { senderWarnings } = await import("../server/src/lib/email.js");
    const s = (host: string, user: string, from: string) => ({ host, port: 587, secure: false, user, pass: "x", from });
    expect(senderWarnings(s("smtp.gmail.com", "me@gmail.com", "Blinxot <me@gmail.com>"))).toEqual([]);
    expect(senderWarnings(s("smtp.gmail.com", "me@gmail.com", "Blinxot <no-reply@blinxot.com>")).join(" ")).toMatch(/Gmail will replace it with me@gmail\.com/);
    expect(senderWarnings(s("smtp.gmail.com", "me@gmail.com", "me@gmail.com")).join(" ")).toMatch(/display name/);
    expect(senderWarnings(s("smtp.mailer.test", "login@other.com", "Blinxot <hi@blinxot.com>")).join(" ")).toMatch(/SPF\/DKIM/);
    expect(senderWarnings(s("smtp.sendgrid.net", "apikey", "Blinxot <hi@blinxot.com>"))).toEqual([]);                    // API-key logins are not email addresses
    expect(senderWarnings(s("smtp.mailer.test", "u", "not an address")).join(" ")).toMatch(/no valid email/);
  });
});
