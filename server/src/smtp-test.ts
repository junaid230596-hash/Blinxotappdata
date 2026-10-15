// Usage: npm run smtp:test -- you@example.com
// Checks the SMTP settings from the environment (.env), explains any problem, and sends one real test email.
import "dotenv/config";
const to = process.argv[2];
const { smtpSettings, diagnoseSmtp, buildTransport } = await import("./lib/email.js");
const { config } = await import("./config.js");
const s = smtpSettings();
if (!s) { console.error("SMTP_HOST is not set, so no email can be sent. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD and SMTP_FROM."); process.exit(1); }
console.log(`Host ${s.host}:${s.port} (${s.secure ? "SSL" : "STARTTLS"}) user ${s.user ?? "(none)"} password ${s.pass ? `set (${s.pass.length} characters)` : "MISSING"} from ${s.from}`);
if (s.insecure) console.log("WARNING: SMTP_TLS_INSECURE=true, certificate checks are off (development only).");
const d = await diagnoseSmtp(s);
if (!d.ok) { console.error(`\nFAILED: ${d.code}: ${d.message}\n\n=> ${d.hint}`); process.exit(2); }
console.log("Connected and logged in OK.");
if (!to) { console.log("Add a recipient to send a test message:  npm run smtp:test -- you@example.com"); process.exit(0); }
try {
  const info = await buildTransport(s).sendMail({ from: config.SMTP_FROM, to, subject: "Blinxot test email", text: "If you can read this, Blinxot can send email." });
  console.log(`Sent to ${to}. Server said: ${info.response}`);
} catch (e) { const err = e as { code?: string; message: string }; console.error(`\nSEND FAILED: ${err.code ?? ""} ${err.message}`); process.exit(3); }
