import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { pool } from "../db.js";
import { badRequest, forbidden, unauthorized } from "../lib/errors.js";

export interface AuthUser { id: string; email: string; accountType: string; emailVerified: boolean }

declare module "express-serve-static-core" {
  interface Request { user?: AuthUser; authVia?: "cookie" | "bearer"; permissions?: Set<string>; memberId?: string }
}

export const ACCESS_COOKIE = "bx_at";

export function signAccessToken(userId: string): string {
  return jwt.sign({ sub: userId }, config.JWT_ACCESS_SECRET, { expiresIn: `${config.ACCESS_TOKEN_TTL_MIN}m`, algorithm: "HS256" });
}

// Resolves the user if a valid token is present; never throws for missing tokens.
export async function loadUser(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    let token: string | undefined;
    if (header?.startsWith("Bearer ")) { token = header.slice(7); req.authVia = "bearer"; }
    else if (req.cookies?.[ACCESS_COOKIE]) { token = req.cookies[ACCESS_COOKIE]; req.authVia = "cookie"; }
    if (!token) return next();
    let sub: string;
    try {
      const payload = jwt.verify(token, config.JWT_ACCESS_SECRET, { algorithms: ["HS256"] }) as jwt.JwtPayload;
      sub = String(payload.sub);
    } catch { return next(); }
    const { rows } = await pool.query(
      "SELECT id, email, account_type, email_verified_at, status FROM users WHERE id = $1", [sub]);
    const u = rows[0];
    if (u && u.status === "active") {
      req.user = { id: u.id, email: u.email, accountType: u.account_type, emailVerified: !!u.email_verified_at };
    }
    next();
  } catch (e) { next(e); }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(unauthorized());
  next();
}

export function requireAccountType(...types: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (!types.includes(req.user.accountType)) return next(forbidden());
    next();
  };
}

// CSRF defence for cookie-authenticated, state-changing requests:
// SameSite cookies + a custom header that cross-site forms cannot set.
export function csrfGuard(req: Request, _res: Response, next: NextFunction) {
  const safe = ["GET", "HEAD", "OPTIONS"].includes(req.method);
  if (!safe && req.authVia === "cookie" && req.headers["x-requested-with"] !== "blinxot") {
    return next(forbidden("Missing CSRF header"));
  }
  next();
}

// Loads the caller's membership + permissions for :businessId and enforces the given permission(s).
export function requireBusinessAccess(...needed: string[]) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw unauthorized();
      const businessId = String(req.params.businessId);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(businessId)) throw badRequest("Invalid id");
      const { rows } = await pool.query(
        `SELECT m.id, array_agg(rp.permission_key) FILTER (WHERE rp.permission_key IS NOT NULL) AS perms
           FROM business_members m
           JOIN businesses b ON b.id = m.business_id AND b.status = 'active'
           LEFT JOIN role_permissions rp ON rp.role_id = m.role_id
          WHERE m.business_id = $1 AND m.user_id = $2 AND m.status = 'active'
          GROUP BY m.id`, [businessId, req.user.id]);
      // 404 (not 403) so non-members cannot probe for business IDs.
      if (!rows[0]) throw new (await import("../lib/errors.js")).AppError(404, "NOT_FOUND", "Not found");
      const perms = new Set<string>(rows[0].perms ?? []);
      if (!needed.every((p) => perms.has(p))) throw forbidden();
      req.permissions = perms;
      req.memberId = rows[0].id;
      next();
    } catch (e) { next(e); }
  };
}
