import { Router } from "express";
import { z } from "zod";
import { pageQuery } from "../../lib/pagination.js";
import { requireAuth, requireBusinessAccess } from "../../middleware/auth.js";
import { body, parse } from "../../middleware/validate.js";
import * as svc from "./salary.service.js";

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const gen = z.object({
  employeeId: uuid, periodStart: date, periodEnd: date,
  bonus: z.number().min(0).max(10_000_000).optional(), deductions: z.number().min(0).max(10_000_000).optional(),
  notes: z.string().trim().max(500).optional(),
});
const bid = (req: any) => String(req.params.businessId);

export const salaryRouter = Router({ mergeParams: true });
salaryRouter.use(requireAuth);

salaryRouter.post("/preview", requireBusinessAccess("salary.view"), body(gen),
  async (req, res) => res.json(await svc.generate(bid(req), req.user!.id, req.body, false, req.ip)));
salaryRouter.post("/generate", requireBusinessAccess("salary.manage"), body(gen),
  async (req, res) => res.status(201).json(await svc.generate(bid(req), req.user!.id, req.body, true, req.ip)));
salaryRouter.get("/", requireBusinessAccess("salary.view"), async (req, res) => {
  const q = parse(pageQuery.extend({ employeeId: uuid.optional(), status: z.enum(["draft", "finalized", "paid"]).optional() }), req.query);
  res.json(await svc.list(bid(req), q));
});
salaryRouter.patch("/:id/status", requireBusinessAccess("salary.manage"), body(z.object({ status: z.enum(["finalized", "paid"]) })),
  async (req, res) => res.json({ record: await svc.advanceStatus(bid(req), parse(uuid, req.params.id), req.body.status, req.user!.id, req.ip) }));
