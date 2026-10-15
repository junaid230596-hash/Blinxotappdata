import type { NextFunction, Request, Response } from "express";
import { getSetting } from "../modules/settings/settings.service.js";
import { AppError } from "../lib/errors.js";

const ALLOWED_DURING_MAINTENANCE = ["/api/auth/login", "/api/auth/logout", "/api/auth/refresh"];

// While maintenance mode is on, everyone except super admins gets read-only access.
export async function maintenanceGuard(req: Request, _res: Response, next: NextFunction) {
  try {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method) || req.user?.accountType === "super_admin") return next();
    if (ALLOWED_DURING_MAINTENANCE.includes(req.baseUrl + req.path)) return next();
    if (await getSetting("maintenance_mode")) throw new AppError(503, "MAINTENANCE", "Blinxot is undergoing maintenance. You can browse, but changes are paused for a short while.");
    next();
  } catch (e) { next(e); }
}
