import { Router } from "express";
import { z } from "zod";
import { httpUrlRe, uploadedImageRe, uploadedPdfRe } from "../../lib/limits.js";
import { pageQuery } from "../../lib/pagination.js";
import { requireAccountType, requireAuth } from "../../middleware/auth.js";
import { buyerOrderRouter } from "../orders/buyer.routes.js";
import { body, parse } from "../../middleware/validate.js";
import * as jobs from "../jobs/job.service.js";
import * as reviews from "../reviews/review.service.js";
import * as svc from "./profile.service.js";

const uuid = z.string().uuid();
const str = (n: number) => z.string().trim().max(n);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const url = z.string().trim().regex(httpUrlRe, "Use a full http(s) link").max(300);
const skills = z.array(str(40).min(1)).max(30);

export const meRouter = Router();
meRouter.use(requireAuth);
meRouter.use("/orders", requireAccountType("individual"), buyerOrderRouter);      // individuals buying from the marketplace

meRouter.get("/profile", async (req, res) => res.json({ profile: await svc.getProfile(req.user!.id) }));
meRouter.patch("/profile", body(z.object({
  headline: str(120).nullable(), bio: str(2000).nullable(), city: str(80).nullable(), phone: str(30).nullable(),
  avatarUrl: z.string().regex(uploadedImageRe, "Upload the image first, then use its URL").nullable(),
  resumeUrl: z.string().regex(uploadedPdfRe, "Upload the PDF first, then use its URL").nullable(),
  availability: z.enum(["available", "open", "unavailable"]), isPublic: z.boolean(),
}).partial()), async (req, res) => res.json({ profile: await svc.updateProfile(req.user!, req.body, req.ip) }));

meRouter.put("/skills", body(z.object({ skills: z.array(str(40).min(1)).max(50) })), async (req, res) => res.json({ skills: await svc.setSkills(req.user!.id, req.body.skills) }));
meRouter.get("/resume", async (req, res) => res.json({ resume: await svc.resume(req.user!.id, true) }));
meRouter.get("/dashboard", async (req, res) => res.json(await svc.dashboard(req.user!.id)));

const entry = (path: string, kind: svc.EntryKind, schema: z.ZodObject<any>) => {
  meRouter.get(`/${path}`, async (req, res) => res.json({ [path]: await svc.listEntries(kind, req.user!.id) }));
  meRouter.post(`/${path}`, body(schema), async (req, res) => res.status(201).json({ entry: await svc.createEntry(kind, req.user!.id, req.body) }));
  meRouter.patch(`/${path}/:id`, body(schema.partial()), async (req, res) => res.json({ entry: await svc.updateEntry(kind, req.user!.id, parse(uuid, req.params.id), req.body) }));
  meRouter.delete(`/${path}/:id`, async (req, res) => { await svc.deleteEntry(kind, req.user!.id, parse(uuid, req.params.id)); res.json({ ok: true }); });
};
entry("experience", "experience", z.object({ company: str(160).min(1), role: str(160).min(1), startDate: date, endDate: date.nullable().optional(),
  responsibilities: str(3000).optional(), achievements: str(3000).optional(), skills: skills.optional() }));
entry("education", "education", z.object({ institution: str(160).min(1), degree: str(120).optional(), fieldOfStudy: str(120).optional(),
  startYear: z.number().int().min(1950).max(2100).optional(), endYear: z.number().int().min(1950).max(2100).optional() }));
entry("certifications", "certifications", z.object({ name: str(160).min(1), issuer: str(160).optional(), issuedOn: date.optional(), expiresOn: date.optional(), url: url.optional() }));
entry("projects", "projects", z.object({ title: str(160).min(1), description: str(3000).optional(), url: url.optional(), skills: skills.optional() }));

// ---- my applications ----
meRouter.get("/applications", async (req, res) => {
  const q = parse(pageQuery.extend({ status: z.enum(["applied", "shortlisted", "interview", "selected", "rejected", "withdrawn"]).optional() }), req.query);
  res.json(await jobs.myApplications(req.user!.id, q));
});
meRouter.get("/applications/:id", async (req, res) => res.json({ application: await jobs.myApplication(req.user!.id, parse(uuid, req.params.id)) }));
meRouter.post("/applications/:id/withdraw", async (req, res) => res.json({ application: await jobs.withdraw(req.user!.id, parse(uuid, req.params.id), req.ip) }));

// ---- reviews I have received ----
meRouter.get("/reviews", async (req, res) => { const q = parse(pageQuery, req.query); res.json(await reviews.received(req.user!.id, q.limit, q.offset)); });
