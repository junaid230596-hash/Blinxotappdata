import { Router } from "express";
import { z } from "zod";
import { pageQuery } from "../../lib/pagination.js";
import { forbidden } from "../../lib/errors.js";
import { requireAuth, requireBusinessAccess } from "../../middleware/auth.js";
import { body, parse } from "../../middleware/validate.js";
import { getEmployeeByUser } from "../employees/employee.service.js";
import * as salary from "../salary/salary.service.js";
import { employeeDashboard } from "../dashboard/dashboard.service.js";
import { registerSelfHr } from "../hr/hr.routes.js";
import * as svc from "./attendance.service.js";

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use YYYY-MM");
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM");
const bid = (req: any) => String(req.params.businessId);

// ---- Manager-facing: /api/businesses/:businessId/attendance ----
export const attendanceRouter = Router({ mergeParams: true });
attendanceRouter.use(requireAuth);

attendanceRouter.get("/", requireBusinessAccess("attendance.view"), async (req, res) => {
  const q = parse(pageQuery.extend({ from: date.optional(), to: date.optional(), employeeId: uuid.optional() }), req.query);
  res.json(await svc.listRecords(bid(req), q));
});

attendanceRouter.get("/report", requireBusinessAccess("attendance.view"), async (req, res) => {
  const q = parse(z.object({ month: month.optional(), from: date.optional(), to: date.optional() }), req.query);
  const range = q.month ? svc.monthRange(q.month) : { from: q.from, to: q.to };
  if (!range.from || !range.to) return res.status(400).json({ error: { code: "BAD_REQUEST", message: "Provide month=YYYY-MM or from & to" } });
  res.json({ from: range.from, to: range.to, employees: await svc.report(bid(req), range.from, range.to) });
});

attendanceRouter.patch("/:recordId", requireBusinessAccess("attendance.manage"),
  body(z.object({ punchIn: z.coerce.date().optional(), punchOut: z.coerce.date().optional() })),
  async (req, res) => res.json({ record: await svc.correctRecord(bid(req), parse(uuid, req.params.recordId), req.user!.id, req.body, req.ip) }));

// ---- Settings ----
export const settingsRouter = Router({ mergeParams: true });
settingsRouter.use(requireAuth);
settingsRouter.get("/", requireBusinessAccess(), async (req, res) => res.json({ settings: await svc.getSettings(bid(req)) }));
settingsRouter.put("/", requireBusinessAccess("attendance.manage"),
  body(z.object({ timezone: z.string().min(1).max(64), workStart: time, workEnd: time, lateGraceMinutes: z.number().int().min(0).max(240) })),
  async (req, res) => res.json({ settings: await svc.putSettings(bid(req), req.user!.id, req.body, req.ip) }));

// ---- Employee self-service: /api/businesses/:businessId/me ----
export const selfRouter = Router({ mergeParams: true });
selfRouter.use(requireAuth, requireBusinessAccess());
selfRouter.use(async (req, res, next) => {
  const emp = await getEmployeeByUser(bid(req), req.user!.id);
  if (!emp) return next(forbidden("You do not have an active employee profile in this business"));
  (req as any).employee = emp;
  next();
});
const emp = (req: any) => req.employee;

selfRouter.get("/", (req, res) => res.json({ employee: {
  id: emp(req).id, position: emp(req).position, department: emp(req).department, joiningDate: emp(req).joining_date, status: emp(req).status } }));
selfRouter.get("/dashboard", async (req, res) => res.json(await employeeDashboard(bid(req), emp(req).id, req.user!.id)));
selfRouter.get("/today", async (req, res) => res.json(await svc.today(bid(req), emp(req).id)));
selfRouter.post("/punch-in", async (req, res) => res.status(201).json({ record: await svc.punchIn(bid(req), emp(req).id) }));
selfRouter.post("/punch-out", async (req, res) => res.json({ record: await svc.punchOut(bid(req), emp(req).id) }));
selfRouter.get("/attendance", async (req, res) => {
  const q = parse(z.object({ month: month.optional() }), req.query);
  const m = q.month ?? new Date().toISOString().slice(0, 7);
  res.json(await svc.myMonth(emp(req).id, m));
});
selfRouter.get("/salary", async (req, res) => res.json({ records: await salary.mine(emp(req).id) }));
registerSelfHr(selfRouter);
