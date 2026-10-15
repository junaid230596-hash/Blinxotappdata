import { Router } from "express";
import { z } from "zod";
import { pool } from "../../db.js";
import { notFound } from "../../lib/errors.js";
import { publicLimiter } from "../../lib/limits.js";
import { pageQuery } from "../../lib/pagination.js";
import { parse } from "../../middleware/validate.js";
import * as admin from "../admin/admin.service.js";
import * as ads from "../ads/ad.service.js";
import * as jobs from "../jobs/job.service.js";
import * as reviews from "../reviews/review.service.js";
import * as profiles from "./profile.service.js";

// Public, read-only discovery. Only data owners chose to publish; never contact details.
export const publicRouter = Router();
publicRouter.use(publicLimiter(120));

publicRouter.get("/jobs", async (req, res) => {
  const q = parse(pageQuery.extend({
    q: z.string().trim().max(100).optional(), location: z.string().trim().max(100).optional(), skill: z.string().trim().max(40).optional(),
    workType: z.enum(["full_time", "part_time", "contract", "temporary", "internship", "freelance"]).optional(), businessId: z.string().uuid().optional(),
    remote: z.enum(["true", "false"]).optional().transform((v) => v === "true"), sort: z.enum(["newest", "deadline"]).optional(),
  }), req.query);
  res.json(await jobs.searchPublic(q, req.user?.id));
});
publicRouter.get("/jobs/:id", async (req, res) => res.json({ job: await jobs.getPublic(parse(z.string().uuid(), req.params.id), req.user?.id) }));

publicRouter.get("/people/:slug", async (req, res) => res.json({ person: await profiles.publicPerson(String(req.params.slug)) }));
publicRouter.get("/people/:slug/reviews", async (req, res) => {
  const { rows } = await pool.query("SELECT user_id FROM profiles WHERE slug=$1 AND is_public", [String(req.params.slug)]);
  if (!rows[0]) throw notFound();
  const q = parse(pageQuery, req.query);
  res.json(await reviews.listPublic({ type: "individual", id: rows[0].user_id }, q.limit, q.offset));
});
publicRouter.get("/businesses/:slug/reviews", async (req, res) => {
  const { rows } = await pool.query("SELECT id FROM businesses WHERE slug=$1 AND is_public AND status='active'", [String(req.params.slug)]);
  if (!rows[0]) throw notFound();
  const q = parse(pageQuery, req.query);
  res.json(await reviews.listPublic({ type: "business", id: rows[0].id }, q.limit, q.offset));
});

publicRouter.get("/categories", async (req, res) => res.json({ categories: await admin.listCategories(parse(z.object({ kind: z.enum(["business", "product"]).optional() }), req.query).kind) }));
publicRouter.get("/ads", async (req, res) => {
  const q = parse(z.object({ placement: z.enum(["discover", "business_profile", "product_discovery"]), businessId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(10).default(3) }), req.query);
  res.json({ ads: await ads.serve(q) });
});
publicRouter.post("/ads/:id/click", publicLimiter(30), async (req, res) => { await ads.recordClick(parse(z.string().uuid(), req.params.id)); res.json({ ok: true }); });
