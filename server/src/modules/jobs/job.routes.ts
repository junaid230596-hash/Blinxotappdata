import { Router } from "express";
import { z } from "zod";
import { pageQuery } from "../../lib/pagination.js";
import { requireAuth, requireBusinessAccess } from "../../middleware/auth.js";
import { body, parse } from "../../middleware/validate.js";
import * as svc from "./job.service.js";

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const str = (n: number) => z.string().trim().max(n);
const bid = (r: any) => String(r.params.businessId);
const rid = (r: any, k = "id") => parse(uuid, r.params[k]);
const appStatus = z.enum(["applied", "shortlisted", "interview", "selected", "rejected", "withdrawn"]);

const jobFields = {
  title: str(200).min(1), description: str(10000).min(1), requirements: str(5000).optional(), skills: z.array(str(40).min(1)).max(30).optional(),
  payMin: z.number().min(0).max(100_000_000).nullable().optional(), payMax: z.number().min(0).max(100_000_000).nullable().optional(),
  payPeriod: z.enum(["hour", "day", "week", "month", "year", "fixed"]).nullable().optional(), currency: z.string().trim().length(3).toUpperCase().optional(),
  location: str(160).optional(), isRemote: z.boolean().optional(),
  workType: z.enum(["full_time", "part_time", "contract", "temporary", "internship", "freelance"]), deadline: date.nullable().optional(),
};

// ---- business side: /api/businesses/:businessId/jobs ----
export const jobRouter = Router({ mergeParams: true });
jobRouter.use(requireAuth);
jobRouter.post("/", requireBusinessAccess("jobs.manage"), body(z.object(jobFields)),
  async (req, res) => res.status(201).json({ job: await svc.createJob(bid(req), req.user!.id, req.body, req.ip) }));
jobRouter.get("/", requireBusinessAccess("jobs.manage"), async (req, res) => {
  const q = parse(pageQuery.extend({ status: z.enum(["draft", "open", "closed"]).optional(), q: str(100).optional() }), req.query);
  res.json(await svc.listJobs(bid(req), q));
});
jobRouter.get("/:id", requireBusinessAccess("jobs.manage"), async (req, res) => res.json({ job: await svc.getJob(bid(req), rid(req)) }));
jobRouter.patch("/:id", requireBusinessAccess("jobs.manage"), body(z.object({ ...jobFields, status: z.enum(["open", "closed"]) }).partial()),
  async (req, res) => res.json({ job: await svc.updateJob(bid(req), rid(req), req.user!.id, req.body, req.ip) }));
jobRouter.delete("/:id", requireBusinessAccess("jobs.manage"), async (req, res) => { await svc.deleteJob(bid(req), rid(req), req.user!.id, req.ip); res.json({ ok: true }); });

// ---- business side: applicants ----
export const applicationRouter = Router({ mergeParams: true });
applicationRouter.use(requireAuth);
applicationRouter.get("/", requireBusinessAccess("jobs.manage"), async (req, res) => {
  const q = parse(pageQuery.extend({ jobId: uuid.optional(), status: appStatus.optional() }), req.query);
  res.json(await svc.listApplications(bid(req), q));
});
applicationRouter.get("/:id", requireBusinessAccess("jobs.manage"), async (req, res) => res.json({ application: await svc.getApplication(bid(req), rid(req)) }));
applicationRouter.patch("/:id/status", requireBusinessAccess("jobs.manage"),
  body(z.object({ status: z.enum(["shortlisted", "interview", "selected", "rejected"]), note: str(500).optional(), interviewAt: z.coerce.date().optional() })),
  async (req, res) => res.json({ application: await svc.setApplicationStatus(bid(req), rid(req), req.user!.id, req.body, req.ip) }));

// ---- applicants: POST /api/jobs/:jobId/apply ----
export const applyRouter = Router();
applyRouter.post("/:jobId/apply", requireAuth, body(z.object({ coverLetter: str(5000).optional() })),
  async (req, res) => res.status(201).json({ application: await svc.apply(req.user!, rid(req, "jobId"), req.body.coverLetter, req.ip) }));
