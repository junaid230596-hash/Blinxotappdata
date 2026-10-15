import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireBusinessAccess } from "../../middleware/auth.js";
import { pageQuery } from "../../lib/pagination.js";
import { body, parse } from "../../middleware/validate.js";
import * as svc from "./employee.service.js";

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const salary = z.object({
  method: z.enum(["hourly", "daily", "monthly"]),
  rate: z.number().min(0).max(10_000_000),
  standardHoursPerDay: z.number().min(1).max(24).optional(),
  overtimeMultiplier: z.number().min(1).max(5).optional(),
  standardDaysPerMonth: z.number().int().min(1).max(31).optional(),
  latePenalty: z.number().min(0).max(1_000_000).optional(),
});
const profileFields = {
  position: z.string().trim().max(120).optional(), department: z.string().trim().max(120).optional(),
  phone: z.string().trim().max(30).optional(), joiningDate: date.optional(),
};

export const employeeRouter = Router({ mergeParams: true });
employeeRouter.use(requireAuth);

const bid = (req: any) => String(req.params.businessId);
const eid = (req: any) => parse(uuid, req.params.employeeId);

employeeRouter.post("/", requireBusinessAccess("employees.create"),
  body(z.object({ email: z.string().trim().toLowerCase().email().max(254), fullName: z.string().trim().min(1).max(120), ...profileFields, salary: salary.optional() })),
  async (req, res) => {
    // Salary configuration is a separate privilege.
    if (req.body.salary && !req.permissions!.has("salary.manage")) delete req.body.salary;
    res.status(201).json({ employee: await svc.createEmployee(bid(req), req.user!.id, req.body, req.ip) });
  });

employeeRouter.get("/", requireBusinessAccess("employees.view"), async (req, res) => {
  const q = parse(pageQuery.extend({ q: z.string().trim().max(100).optional(), status: z.enum(["active", "inactive"]).optional() }), req.query);
  res.json(await svc.listEmployees(bid(req), q));
});

employeeRouter.get("/:employeeId", requireBusinessAccess("employees.view"), async (req, res) =>
  res.json({ employee: await svc.getEmployee(bid(req), eid(req), req.permissions!.has("salary.view")) }));

employeeRouter.patch("/:employeeId", requireBusinessAccess("employees.edit"), body(z.object(profileFields).partial()),
  async (req, res) => res.json({ employee: await svc.updateEmployee(bid(req), eid(req), req.user!.id, req.body, req.ip) }));

employeeRouter.delete("/:employeeId", requireBusinessAccess("employees.delete"), async (req, res) => {
  await svc.deactivateEmployee(bid(req), eid(req), req.user!.id, req.ip);
  res.json({ ok: true });
});

employeeRouter.put("/:employeeId/salary-config", requireBusinessAccess("salary.manage"), body(salary),
  async (req, res) => res.json({ employee: await svc.setSalaryConfig(bid(req), eid(req), req.user!.id, req.body, req.ip) }));
