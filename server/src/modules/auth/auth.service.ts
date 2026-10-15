import bcrypt from "bcryptjs";
import { config } from "../../config.js";
import { pool, tx } from "../../db.js";
import { randomToken, sha256 } from "../../lib/crypto.js";
import { mails, sendMail } from "../../lib/email.js";
import { AppError, badRequest, conflict, unauthorized } from "../../lib/errors.js";
import { audit } from "../audit/audit.service.js";
import { signAccessToken } from "../../middleware/auth.js";
import { getSetting } from "../settings/settings.service.js";

const BCRYPT_COST = config.NODE_ENV === "test" ? 4 : 12;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
// Used to equalise timing when the email does not exist.
const DUMMY_HASH = bcrypt.hashSync("dummy-password-for-timing", BCRYPT_COST);

export const publicUser = (u: any) => ({
  id: u.id, email: u.email, fullName: u.full_name, accountType: u.account_type,
  emailVerified: !!u.email_verified_at, createdAt: u.created_at,
});

export async function issueUserToken(userId: string, purpose: "verify_email" | "reset_password", ttlMinutes: number, db = pool) {
  // Invalidate earlier unused tokens of the same purpose.
  await db.query("UPDATE user_tokens SET used_at = now() WHERE user_id=$1 AND purpose=$2 AND used_at IS NULL", [userId, purpose]);
  const token = randomToken();
  await db.query(
    `INSERT INTO user_tokens (user_id, purpose, token_hash, expires_at)
     VALUES ($1,$2,$3, now() + ($4 || ' minutes')::interval)`, [userId, purpose, sha256(token), String(ttlMinutes)]);
  return token;
}

async function createSession(userId: string, ip?: string, userAgent?: string) {
  const refresh = randomToken(48);
  await pool.query(
    `INSERT INTO sessions (user_id, refresh_hash, ip, user_agent, expires_at)
     VALUES ($1,$2,$3,$4, now() + ($5 || ' days')::interval)`,
    [userId, sha256(refresh), ip ?? null, userAgent?.slice(0, 250) ?? null, String(config.REFRESH_TOKEN_TTL_DAYS)]);
  return { access: signAccessToken(userId), refresh };
}

export async function register(input: { email: string; password: string; fullName: string; accountType: string }, ip?: string) {
  if (!(await getSetting("registration_open"))) throw new AppError(403, "REGISTRATION_CLOSED", "New registrations are temporarily closed.");
  const hash = await bcrypt.hash(input.password, BCRYPT_COST);
  let user: any;
  try {
    user = await tx(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO users (email, password_hash, full_name, account_type) VALUES ($1,$2,$3,$4) RETURNING *`,
        [input.email, hash, input.fullName, input.accountType]);
      await c.query("INSERT INTO profiles (user_id) VALUES ($1)", [rows[0].id]);
      return rows[0];
    });
  } catch (e: any) {
    if (e.code === "23505") throw conflict("An account with this email already exists");
    throw e;
  }
  const token = await issueUserToken(user.id, "verify_email", 24 * 60);
  await sendMail(mails.verify(user.email, user.full_name, token));
  await audit({ actorId: user.id, action: "user.register", entity: "user", entityId: user.id, ip });
  return publicUser(user);
}

export async function login(email: string, password: string, ip?: string, userAgent?: string) {
  const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
  const u = rows[0];
  const ok = await bcrypt.compare(password, u?.password_hash ?? DUMMY_HASH);
  if (!u) throw unauthorized("Invalid email or password");
  if (u.locked_until && new Date(u.locked_until) > new Date()) {
    throw new AppError(429, "ACCOUNT_LOCKED", "Too many failed attempts. Try again later.");
  }
  if (!ok) {
    const { rows: r } = await pool.query(
      `UPDATE users SET failed_login_count = failed_login_count + 1,
         locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN now() + ($3 || ' minutes')::interval ELSE locked_until END
       WHERE id = $1 RETURNING failed_login_count`, [u.id, MAX_FAILED, String(LOCK_MINUTES)]);
    await audit({ actorId: u.id, action: "user.login_failed", entity: "user", entityId: u.id, ip, metadata: { attempts: r[0].failed_login_count } });
    throw unauthorized("Invalid email or password");
  }
  if (u.status !== "active") throw new AppError(403, "ACCOUNT_SUSPENDED", "This account is suspended");
  await pool.query("UPDATE users SET failed_login_count=0, locked_until=NULL, last_login_at=now() WHERE id=$1", [u.id]);
  const tokens = await createSession(u.id, ip, userAgent);
  await audit({ actorId: u.id, action: "user.login", entity: "user", entityId: u.id, ip });
  return { user: publicUser(u), ...tokens };
}

export async function refresh(refreshToken: string, ip?: string, userAgent?: string) {
  const h = sha256(refreshToken);
  const { rows } = await pool.query("SELECT * FROM sessions WHERE refresh_hash = $1", [h]);
  const s = rows[0];
  if (!s) throw unauthorized("Invalid session");
  if (s.revoked_at) {
    // Reuse of a rotated token => assume theft, kill all sessions.
    await pool.query("UPDATE sessions SET revoked_at = now() WHERE user_id=$1 AND revoked_at IS NULL", [s.user_id]);
    await audit({ actorId: s.user_id, action: "security.refresh_reuse_detected", ip });
    throw unauthorized("Invalid session");
  }
  if (new Date(s.expires_at) < new Date()) throw unauthorized("Session expired");
  const { rows: ur } = await pool.query("SELECT * FROM users WHERE id=$1", [s.user_id]);
  if (!ur[0] || ur[0].status !== "active") throw unauthorized("Invalid session");
  await pool.query("UPDATE sessions SET revoked_at = now() WHERE id=$1", [s.id]);
  const tokens = await createSession(s.user_id, ip, userAgent);
  return { user: publicUser(ur[0]), ...tokens };
}

export async function logout(refreshToken: string | undefined, userId?: string, ip?: string) {
  if (refreshToken) {
    await pool.query("UPDATE sessions SET revoked_at = now() WHERE refresh_hash=$1 AND revoked_at IS NULL", [sha256(refreshToken)]);
  }
  if (userId) await audit({ actorId: userId, action: "user.logout", entity: "user", entityId: userId, ip });
}

async function consumeToken(token: string, purpose: string) {
  const { rows } = await pool.query(
    `UPDATE user_tokens SET used_at = now()
      WHERE token_hash=$1 AND purpose=$2 AND used_at IS NULL AND expires_at > now()
      RETURNING user_id`, [sha256(token), purpose]);
  if (!rows[0]) throw badRequest("This link is invalid or has expired");
  return rows[0].user_id as string;
}

export async function verifyEmail(token: string) {
  const userId = await consumeToken(token, "verify_email");
  await pool.query("UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()), updated_at=now() WHERE id=$1", [userId]);
  await audit({ actorId: userId, action: "user.email_verified", entity: "user", entityId: userId });
}

export async function resendVerification(userId: string) {
  const { rows } = await pool.query("SELECT * FROM users WHERE id=$1", [userId]);
  const u = rows[0];
  if (!u || u.email_verified_at) return;
  const token = await issueUserToken(u.id, "verify_email", 24 * 60);
  await sendMail(mails.verify(u.email, u.full_name, token));
}

// Always resolves silently so attackers cannot enumerate registered emails.
export async function forgotPassword(email: string, ip?: string) {
  const { rows } = await pool.query("SELECT * FROM users WHERE email=$1 AND status='active'", [email]);
  const u = rows[0];
  if (!u) return;
  const token = await issueUserToken(u.id, "reset_password", 60);
  await sendMail(mails.reset(u.email, u.full_name, token));
  await audit({ actorId: u.id, action: "security.password_reset_requested", ip });
}

export async function resetPassword(token: string, newPassword: string, ip?: string) {
  const userId = await consumeToken(token, "reset_password");
  const hash = await bcrypt.hash(newPassword, BCRYPT_COST);
  const { rows } = await pool.query(
    `UPDATE users SET password_hash=$2, failed_login_count=0, locked_until=NULL, updated_at=now(),
         email_verified_at = COALESCE(email_verified_at, now())  -- the link was delivered to this inbox
      WHERE id=$1 RETURNING email, full_name`, [userId, hash]);
  // Revoke every session after a password reset.
  await pool.query("UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [userId]);
  await sendMail(mails.passwordChanged(rows[0].email, rows[0].full_name));
  await audit({ actorId: userId, action: "security.password_reset", entity: "user", entityId: userId, ip });
}

export async function changePassword(userId: string, current: string, next: string, ip?: string) {
  const { rows } = await pool.query("SELECT * FROM users WHERE id=$1", [userId]);
  if (!rows[0] || !(await bcrypt.compare(current, rows[0].password_hash))) throw badRequest("Current password is incorrect");
  await pool.query("UPDATE users SET password_hash=$2, updated_at=now() WHERE id=$1", [userId, await bcrypt.hash(next, BCRYPT_COST)]);
  await pool.query("UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [userId]);
  await sendMail(mails.passwordChanged(rows[0].email, rows[0].full_name));
  await audit({ actorId: userId, action: "security.password_changed", entity: "user", entityId: userId, ip });
}

export async function getUser(userId: string) {
  const { rows } = await pool.query("SELECT * FROM users WHERE id=$1", [userId]);
  return rows[0] ? publicUser(rows[0]) : null;
}
