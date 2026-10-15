import { Router, type Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { config, isProd, isTest } from "../../config.js";
import { ACCESS_COOKIE, requireAuth } from "../../middleware/auth.js";
import { body } from "../../middleware/validate.js";
import { unauthorized } from "../../lib/errors.js";
import * as svc from "./auth.service.js";

const REFRESH_COOKIE = "bx_rt";

const password = z.string().min(10, "Use at least 10 characters").max(128)
  .refine((p) => /[a-zA-Z]/.test(p) && /[0-9]/.test(p), "Include letters and numbers");
const email = z.string().trim().toLowerCase().email().max(254);

const limiter = (max: number) => rateLimit({
  windowMs: 15 * 60 * 1000, max, standardHeaders: true, legacyHeaders: false,
  skip: () => isTest,
  message: { error: { code: "RATE_LIMITED", message: "Too many requests. Please try again later." } },
});

function setAuthCookies(res: Response, access: string, refresh: string) {
  const base = { httpOnly: true, secure: isProd, sameSite: "lax" as const, domain: config.COOKIE_DOMAIN };
  res.cookie(ACCESS_COOKIE, access, { ...base, path: "/", maxAge: config.ACCESS_TOKEN_TTL_MIN * 60_000 });
  res.cookie(REFRESH_COOKIE, refresh, { ...base, path: "/api/auth", maxAge: config.REFRESH_TOKEN_TTL_DAYS * 86_400_000 });
}
function clearAuthCookies(res: Response) {
  res.clearCookie(ACCESS_COOKIE, { path: "/", domain: config.COOKIE_DOMAIN });
  res.clearCookie(REFRESH_COOKIE, { path: "/api/auth", domain: config.COOKIE_DOMAIN });
}

export const authRouter = Router();

authRouter.post("/register", limiter(10), body(z.object({
  email, password, fullName: z.string().trim().min(1).max(120),
  accountType: z.enum(["individual", "business_owner", "supplier"]),
})), async (req, res) => {
  const user = await svc.register(req.body, req.ip);
  res.status(201).json({ user });
});

authRouter.post("/login", limiter(20), body(z.object({ email, password: z.string().min(1).max(128) })), async (req, res) => {
  const r = await svc.login(req.body.email, req.body.password, req.ip, req.headers["user-agent"]);
  setAuthCookies(res, r.access, r.refresh);
  // Tokens are also returned for non-browser clients (mobile/API); browsers use the httpOnly cookies.
  res.json({ user: r.user, accessToken: r.access, refreshToken: r.refresh });
});

authRouter.post("/refresh", limiter(60), async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE] ?? req.body?.refreshToken;
  if (!token || typeof token !== "string") throw unauthorized("Missing refresh token");
  const r = await svc.refresh(token, req.ip, req.headers["user-agent"]);
  setAuthCookies(res, r.access, r.refresh);
  res.json({ user: r.user, accessToken: r.access, refreshToken: r.refresh });
});

authRouter.post("/logout", async (req, res) => {
  await svc.logout(req.cookies?.[REFRESH_COOKIE] ?? req.body?.refreshToken, req.user?.id, req.ip);
  clearAuthCookies(res);
  res.json({ ok: true });
});

authRouter.post("/verify-email", limiter(20), body(z.object({ token: z.string().min(10).max(200) })), async (req, res) => {
  await svc.verifyEmail(req.body.token);
  res.json({ ok: true });
});

authRouter.post("/resend-verification", requireAuth, limiter(5), async (req, res) => {
  await svc.resendVerification(req.user!.id);
  res.json({ ok: true });
});

authRouter.post("/forgot-password", limiter(5), body(z.object({ email })), async (req, res) => {
  await svc.forgotPassword(req.body.email, req.ip);
  res.json({ ok: true, message: "If that email is registered, a reset link has been sent." });
});

authRouter.post("/reset-password", limiter(10), body(z.object({ token: z.string().min(10).max(200), password })), async (req, res) => {
  await svc.resetPassword(req.body.token, req.body.password, req.ip);
  clearAuthCookies(res);
  res.json({ ok: true });
});

authRouter.post("/change-password", requireAuth, limiter(10), body(z.object({ currentPassword: z.string().min(1), newPassword: password })), async (req, res) => {
  await svc.changePassword(req.user!.id, req.body.currentPassword, req.body.newPassword, req.ip);
  clearAuthCookies(res);
  res.json({ ok: true });
});

authRouter.get("/me", requireAuth, async (req, res) => {
  res.json({ user: await svc.getUser(req.user!.id) });
});
