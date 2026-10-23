// Usage: npm run email:test -- you@example.com      (npm run smtp:test does the same)
// Checks the configured email provider (Brevo, Resend or SMTP) from the environment (.env), explains any problem, and sends one real test email.
import "dotenv/config";
const to = process.argv[2];
const email = await import("./lib/email.js");
const { config } = await import("./config.js");
const provider = email.emailProvider();
if (!provider) { console.error("No email provider is configured. Set BREVO_API_KEY or RESEND_API_KEY (works on any host), or SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASSWORD."); process.exit(1); }

if (provider !== "smtp") {
  const from = email.parseFrom(config.SMTP_FROM);
  console.log(`Provider: ${provider} (HTTPS API)  from: ${config.SMTP_FROM}  key: ${(provider === "brevo" ? config.BREVO_API_KEY : config.RESEND_API_KEY)?.slice(0, 6)}…`);
  if (!from.email.includes("@")) { console.error("FAILED: SMTP_FROM is not a valid email address."); process.exit(2); }
  const d = await email.diagnoseApiProvider(provider);
  if (!d.ok) { console.error(`\nFAILED: ${d.code}: ${d.message}\n\n=> ${d.hint}`); process.exit(2); }
  console.log("API key accepted.");
  if (!to) { console.log("Add a recipient to send a test message:  npm run email:test -- you@example.com"); process.exit(0); }
  try { await email.sendViaApi(provider, { to, subject: "Blinxot test email", text: "If you can read this, Blinxot can send email." }); console.log(`Sent to ${to}. Check the inbox (and spam).`); }
  catch (e) { const err = e as { message: string; hint?: string }; console.error(`\nSEND FAILED: ${err.message}\n\n=> ${err.hint ?? ""}`); process.exit(3); }
  process.exit(0);
}

const s = email.smtpSettings()!;
console.log(`Host ${s.host}:${s.port} (${s.secure ? "SSL" : "STARTTLS"}) user ${s.user ?? "(none)"} password ${s.pass ? `set (${s.pass.length} characters)` : "MISSING"} from ${s.from}`);
if (s.insecure) console.log("WARNING: SMTP_TLS_INSECURE=true, certificate checks are off (development only).");
const d = await email.diagnoseSmtp(s);
if (!d.ok) { console.error(`\nFAILED: ${d.code}: ${d.message}\n\n=> ${d.hint}`); process.exit(2); }
console.log("Connected and logged in OK.");
if (!to) { console.log("Add a recipient to send a test message:  npm run email:test -- you@example.com"); process.exit(0); }
try {
  const info = await email.buildTransport(s).sendMail({ from: config.SMTP_FROM, to, subject: "Blinxot test email", text: "If you can read this, Blinxot can send email." });
  console.log(`Sent to ${to}. Server said: ${info.response}`);
} catch (e) { const err = e as { code?: string; message: string }; console.error(`\nSEND FAILED: ${err.code ?? ""} ${err.message}`); process.exit(3); }
