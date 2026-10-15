import fs from "node:fs";
import nodemailer from "nodemailer";
import { config, isProd, isTest } from "../config.js";
import { logger } from "../logger.js";

export interface Mail { to: string; subject: string; text: string; html?: string; replyTo?: string }

// In test/dev without SMTP, mails are captured here instead of being sent.
export const outbox: Mail[] = [];

export interface SmtpSettings { host: string; port: number; secure: boolean; user?: string; pass?: string; from: string; ca?: string; insecure?: boolean; timeoutMs?: number }

/** Reads SMTP_* from the environment. Returns null when no host is configured. */
export function smtpSettings(): SmtpSettings | null {
  if (!config.SMTP_HOST) return null;
  const host = config.SMTP_HOST.trim().toLowerCase();
  let pass = config.SMTP_PASSWORD ?? config.SMTP_PASS;
  if (pass && /(^|\.)(gmail|googlemail)\.com$/.test(host)) pass = pass.replace(/\s+/g, "");      // Google shows app passwords in groups of four; the spaces are not part of it
  return { host, port: config.SMTP_PORT, secure: config.SMTP_SECURE ? config.SMTP_SECURE === "true" : config.SMTP_PORT === 465,
    user: config.SMTP_USER?.trim() || undefined, pass, from: config.SMTP_FROM,
    ca: config.SMTP_CA_FILE ? fs.readFileSync(config.SMTP_CA_FILE, "utf8") : undefined,
    insecure: config.SMTP_TLS_INSECURE === "true" && !isProd };           // never honoured in production
}

export const buildTransport = (s: SmtpSettings) => nodemailer.createTransport({
  host: s.host, port: s.port, secure: s.secure, auth: s.user ? { user: s.user, pass: s.pass } : undefined,
  tls: { ca: s.ca, rejectUnauthorized: !s.insecure },
  connectionTimeout: s.timeoutMs ?? 15_000, greetingTimeout: s.timeoutMs ?? 15_000, socketTimeout: 30_000,
});

const CERT_ERR = /self[- ]signed|SELF_SIGNED_CERT|UNABLE_TO_VERIFY|CERT_|certificate (has expired|is not yet valid)|unable to get (local )?issuer/i;
export type SmtpDiagnosis = { ok: true } | { ok: false; code: string; message: string; hint: string; suggestion?: { port: number; secure: boolean } };
export interface Alt { port: number; secure: boolean }
export const STANDARD_ALTS: Alt[] = [{ port: 587, secure: false }, { port: 465, secure: true }];

/** Classifies a Nodemailer failure. Nodemailer wraps many low-level errors as ESOCKET / ECONNECTION / ETIMEDOUT, so the message is checked too. */
function classify(err: { code?: string; message: string }) {
  const text = `${err.code} ${err.message}`;
  if (CERT_ERR.test(text)) return "CERT_UNTRUSTED";
  if (/ENOTFOUND|EAI_AGAIN/.test(text)) return "ENOTFOUND";
  if (/ECONNREFUSED/.test(text)) return "ECONNREFUSED";
  if (/greeting never received/i.test(text)) return "NO_GREETING";
  if (/wrong version number|ssl routines|packet length too long|unknown protocol/i.test(text)) return "TLS_MISMATCH";
  return err.code ?? "ERROR";
}

/** Tries the other standard port / SSL combinations so we can tell the user exactly which one works. Reaching the server (even if login then fails) counts. */
async function probe(s: SmtpSettings, alts: Alt[]): Promise<{ alt: Alt; loginOk: boolean } | null> {
  const results = await Promise.all(alts.filter((a) => !(a.port === s.port && a.secure === s.secure)).map(async (a) => {
    try { await buildTransport({ ...s, ...a, timeoutMs: 8_000 }).verify(); return { alt: a, loginOk: true }; }
    catch (e) { return (e as { code?: string }).code === "EAUTH" ? { alt: a, loginOk: false } : null; }
  }));
  return results.find(Boolean) ?? null;
}

/** Connects and authenticates (without sending) and explains a failure in plain words. */
export async function diagnoseSmtp(s: SmtpSettings, opts: { alternatives?: Alt[] } = {}): Promise<SmtpDiagnosis> {
  if (/(^|\.)example\.(com|org|net)$/.test(s.host)) {
    return { ok: false, code: "PLACEHOLDER_HOST", message: `SMTP_HOST is "${s.host}", which is a placeholder`, hint: "Use your provider's real SMTP host, e.g. smtp.gmail.com for Gmail." };
  }
  if (s.user && !s.pass) return { ok: false, code: "NO_PASSWORD", message: "SMTP_USER is set but no password was found", hint: "Set SMTP_PASSWORD (SMTP_PASS also works)." };
  try { await buildTransport(s).verify(); return { ok: true }; }
  catch (e) {
    const err = e as { code?: string; message: string };
    const code = classify(err); const gmail = /gmail|google/.test(s.host);
    const scanner = "an antivirus \"mail shield\" / email scanning feature (Avast, AVG, Kaspersky, Bitdefender, ESET, Norton...) that holds the connection, so turn its email scanning off";
    const hints: Record<string, string> = {
      CERT_UNTRUSTED: "The server's TLS certificate is not trusted by this computer. When the host is smtp.gmail.com this means something is intercepting the connection and re-signing it: antivirus \"email / HTTPS scanning\" (Avast, Kaspersky, Bitdefender, ESET...), a company or school proxy, or a router/firewall that inspects traffic. Best fix: turn off the scanner's email/SSL scanning, or export its root certificate as a .pem file and set SMTP_CA_FILE=/path/to/it.pem (or NODE_EXTRA_CA_CERTS). For local development only, SMTP_TLS_INSECURE=true skips the check (ignored in production).",
      EAUTH: gmail ? "Gmail rejected the login. Use the full Gmail address as SMTP_USER and a 16-character App Password (Google Account > Security > 2-Step Verification > App passwords), not your normal password." : "The server rejected the username or password. Check both, and whether your provider needs an app-specific password or API key.",
      ENOTFOUND: `The host "${s.host}" does not exist (or this computer has no internet/DNS). Check SMTP_HOST for typos and your connection.`,
      ECONNREFUSED: `Nothing is listening on ${s.host}:${s.port}. Try port 587 (STARTTLS, SMTP_SECURE=false) or 465 (SSL).`,
      NO_GREETING: `The connection to ${s.host}:${s.port} opened but the server never said hello within ${Math.round((s.timeoutMs ?? 15_000) / 1000)} seconds. Usual causes: (1) the port and SSL setting do not match: port 465 needs SSL (SMTP_SECURE=true, or leave it unset) and port 587 needs SMTP_SECURE=false; (2) ${scanner}; (3) a firewall, hotspot or internet provider that silently blocks outgoing mail, so try another network such as a phone hotspot.`,
      TLS_MISMATCH: "SSL/TLS mismatch: use port 465 with SMTP_SECURE=true, or port 587 with SMTP_SECURE=false.",
      ETIMEDOUT: `Could not connect to ${s.host}:${s.port} in time. A firewall or network may be blocking outgoing mail (try another network, or the other port), or ${scanner}.`,
      ECONNECTION: `Could not reach ${s.host}:${s.port}. A firewall or network may be blocking outgoing mail; try another network or the other port.`,
      ESOCKET: `The connection to ${s.host}:${s.port} was interrupted. A firewall, antivirus or proxy may be interfering; try another network or the other port.`,
    };
    let hint = hints[code] ?? "See the message above.";
    let suggestion: { port: number; secure: boolean } | undefined;
    if (["NO_GREETING", "TLS_MISMATCH", "ETIMEDOUT", "ECONNECTION", "ESOCKET", "ECONNREFUSED"].includes(code)) {
      const found = await probe(s, opts.alternatives ?? STANDARD_ALTS);
      if (found) {
        suggestion = found.alt;
        hint = `${hint}\n\nGOOD NEWS: port ${found.alt.port} (${found.alt.secure ? "SSL" : "STARTTLS"}) is reachable${found.loginOk ? " and the login works" : " (the login was then rejected, so also check the username and App Password)"}. Set SMTP_PORT=${found.alt.port} and SMTP_SECURE=${found.alt.secure}.`;
      } else if (code !== "ECONNREFUSED") {
        hint = `${hint}\n\nI also tried the other standard combinations (587 STARTTLS, 465 SSL) and none responded, which points to antivirus, a firewall or the network rather than your settings.`;
      }
    }
    return { ok: false, code, message: err.message, hint, suggestion };
  }
}

let transport: ReturnType<typeof buildTransport> | null | undefined;
const getTransport = () => (transport === undefined ? (transport = smtpSettings() ? buildTransport(smtpSettings()!) : null) : transport);

/** Mismatches between the visible From address and the account that sends are the most common reason mail lands in spam or is rewritten. */
export function senderWarnings(s: SmtpSettings): string[] {
  const out: string[] = []; const addr = (/<([^>]+)>/.exec(s.from)?.[1] ?? s.from).trim().toLowerCase(); const fromDomain = addr.split("@")[1];
  const userDomain = s.user?.includes("@") ? s.user.toLowerCase().split("@")[1] : undefined; const gmail = /(^|\.)(gmail|googlemail)\.com$/.test(s.host);
  if (!fromDomain) out.push(`SMTP_FROM "${s.from}" has no valid email address.`);
  else if (gmail && fromDomain !== "gmail.com" && fromDomain !== "googlemail.com") out.push(`SMTP_FROM uses ${fromDomain} but you send through Gmail: Gmail will replace it with ${s.user} unless that address is added under Gmail > Settings > Accounts > "Send mail as", and mail may land in spam. See docs/EMAIL_DELIVERABILITY.md.`);
  else if (!gmail && userDomain && userDomain !== fromDomain && !/^(apikey|resend|postmaster)/i.test(s.user ?? "")) out.push(`SMTP_FROM is on ${fromDomain} but the SMTP login is on ${userDomain}. Make sure ${fromDomain} is verified with your mail provider (SPF/DKIM) or mail may be rejected or marked as spam.`);
  if (!/<[^>]+>/.test(s.from)) out.push('Tip: use a display name, e.g. SMTP_FROM="Blinxot <you@yourdomain.com>"; named senders are trusted more than bare addresses.');
  return out;
}

/** Logs whether email can actually be sent. Called once at startup so a bad setting is obvious immediately, not when the first user never gets a code. */
export async function checkSmtpOnBoot() {
  const s = smtpSettings();
  if (!s) return;
  if (config.SMTP_TLS_INSECURE === "true" && isProd) logger.error("SMTP_TLS_INSECURE is ignored in production: certificates are always verified. Use SMTP_CA_FILE to trust a private certificate authority.");
  if (s.insecure) logger.warn("SMTP_TLS_INSECURE=true: email certificate checks are OFF (development only).");
  for (const w of senderWarnings(s)) logger.warn(w);
  const d = await diagnoseSmtp(s);
  if (d.ok) logger.info({ host: s.host, port: s.port, user: s.user }, "SMTP connection verified: email is working");
  else logger.error({ host: s.host, port: s.port, code: d.code, reason: d.message }, `SMTP is NOT working: ${d.hint}`);
}

export async function sendMail(mail: Mail): Promise<void> {
  const t = getTransport();
  if (!t) {
    if (isTest) outbox.push(mail);
    else logger.warn({ to: mail.to, subject: mail.subject }, "SMTP not configured; email not sent");
    return;
  }
  try {
    await t.sendMail({ from: config.SMTP_FROM, headers: { "Auto-Submitted": "auto-generated", "X-Auto-Response-Suppress": "OOF, AutoReply" }, ...mail });
  } catch (e) {
    // Never fail the request because email failed; log for operators.
    const err = e as { message: string; code?: string; responseCode?: number };
    logger.error({ err: err.message, code: err.code, responseCode: err.responseCode, to: mail.to, subject: mail.subject }, "email send failed (run `npm run smtp:test -- you@example.com` to diagnose)");
  }
}

const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Simple, accessible, single-column HTML email with the plain-text twin sent alongside (multipart mail is treated as more trustworthy than text-only or HTML-only). All values are escaped. */
function layout(o: { preheader: string; heading: string; paragraphs: string[]; button?: { label: string; url: string }; footer?: string }) {
  const p = (t: string) => `<p style="margin:0 0 16px;line-height:1.55;font-size:16px;color:#1f2430">${esc(t)}</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(o.heading)}</title></head>
<body style="margin:0;padding:0;background:#f5f6fa;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(o.preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f6fa"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;padding:28px">
<tr><td><p style="margin:0 0 20px;font-size:20px;font-weight:700;color:#4f46e5">Blinxot</p>
<h1 style="margin:0 0 16px;font-size:20px;color:#111827">${esc(o.heading)}</h1>
${o.paragraphs.map(p).join("")}
${o.button ? `<p style="margin:24px 0"><a href="${esc(o.button.url)}" style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:8px">${esc(o.button.label)}</a></p>
<p style="margin:0 0 16px;font-size:13px;line-height:1.5;color:#6b7280">Button not working? Copy this link into your browser:<br><a href="${esc(o.button.url)}" style="color:#4f46e5;word-break:break-all">${esc(o.button.url)}</a></p>` : ""}
<p style="margin:24px 0 0;font-size:12px;line-height:1.5;color:#6b7280">${esc(o.footer ?? "You received this email because of activity on your Blinxot account.")}</p>
</td></tr></table></td></tr></table></body></html>`;
}

export const mails = {
  verify: (to: string, name: string, token: string): Mail => {
    const link = `${config.APP_URL}/verify-email?token=${token}`;
    return { to, subject: "Verify your Blinxot email", text: `Hi ${name},\n\nVerify your email: ${link}\n\nThis link expires in 24 hours.\n— Blinxot`,
      html: layout({ preheader: "Confirm your email to finish setting up Blinxot.", heading: "Verify your email", paragraphs: [`Hi ${name},`, "Confirm your email address to finish creating your Blinxot account. This link expires in 24 hours."], button: { label: "Verify email", url: link } }) };
  },
  reset: (to: string, name: string, token: string): Mail => {
    const link = `${config.APP_URL}/reset-password?token=${token}`;
    return { to, subject: "Reset your Blinxot password", text: `Hi ${name},\n\nReset your password: ${link}\n\nThis link expires in 1 hour. If you didn't request it, ignore this email.\n— Blinxot`,
      html: layout({ preheader: "Use this link to choose a new password.", heading: "Reset your password", paragraphs: [`Hi ${name},`, "Use the button below to choose a new password. This link expires in 1 hour.", "If you didn't ask for this, you can ignore this email; your password will not change."], button: { label: "Reset password", url: link } }) };
  },
  invite: (to: string, name: string, businessName: string, token: string): Mail => {
    const link = `${config.APP_URL}/reset-password?token=${token}&invite=1`;
    return { to, subject: `You've been added to ${businessName} on Blinxot`, text: `Hi ${name},\n\n${businessName} added you as an employee on Blinxot. Set your password to sign in: ${link}\n\nThis link expires in 7 days.\n— Blinxot`,
      html: layout({ preheader: `${businessName} added you on Blinxot.`, heading: `Welcome to ${businessName}`, paragraphs: [`Hi ${name},`, `${businessName} added you as an employee on Blinxot. Set your password to sign in. This link expires in 7 days.`], button: { label: "Set your password", url: link } }) };
  },
  passwordChanged: (to: string, name: string): Mail => ({
    to, subject: "Your Blinxot password was changed",
    text: `Hi ${name},\n\nYour password was just changed. If this wasn't you, reset it immediately and contact support.\n— Blinxot`,
    html: layout({ preheader: "Your password was just changed.", heading: "Your password was changed", paragraphs: [`Hi ${name},`, "Your Blinxot password was just changed.", "If this wasn't you, reset your password immediately and contact support."], button: { label: "Reset password", url: `${config.APP_URL}/forgot-password` } }),
  }),
};
