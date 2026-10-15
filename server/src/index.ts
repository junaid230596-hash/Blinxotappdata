import bcrypt from "bcryptjs";
import { createApp } from "./app.js";
import { config, isProd } from "./config.js";
import { checkSmtpOnBoot } from "./lib/email.js";
import { pool } from "./db.js";
import { logger } from "./logger.js";
import { migrate } from "./migrate.js";
import { sendDueReminders } from "./modules/crm/crm.service.js";

async function bootstrapAdmin() {
  const { BOOTSTRAP_ADMIN_EMAIL: email, BOOTSTRAP_ADMIN_PASSWORD: pw } = config;
  if (!email || !pw) return;
  const { rows } = await pool.query("SELECT 1 FROM users WHERE account_type='super_admin' LIMIT 1");
  if (rows[0]) return;
  const { rows: u } = await pool.query(
    `INSERT INTO users (email, password_hash, full_name, account_type, email_verified_at)
     VALUES ($1,$2,'Blinxot Admin','super_admin', now()) RETURNING id`, [email, await bcrypt.hash(pw, 12)]);
  await pool.query("INSERT INTO profiles (user_id) VALUES ($1)", [u[0].id]);
  logger.info({ email }, "bootstrap super admin created — remove BOOTSTRAP_ADMIN_* from env now");
}

if (isProd && !config.SMTP_HOST) logger.warn("SMTP_HOST is not set: verification, password-reset and invitation emails will NOT be sent, so new users cannot verify their email or create a business");
if (isProd && config.APP_URL.startsWith("http://")) logger.warn("APP_URL is not https: auth cookies are Secure in production and email links will be wrong");

void checkSmtpOnBoot();          // logs "SMTP connection verified" or exactly why email will not work
const applied = await migrate();
if (applied.length) logger.info({ applied }, "migrations applied");
await bootstrapAdmin();
const server = createApp().listen(config.PORT, () => logger.info(`Blinxot API listening on :${config.PORT}`));

// CRM reminders: claimed atomically, so running on several instances never double-notifies.
const reminderTimer = setInterval(() => { sendDueReminders().catch((e) => logger.error({ err: e.message }, "reminder run failed")); }, 60_000);
reminderTimer.unref();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => server.close(() => pool.end().then(() => process.exit(0))));
}
