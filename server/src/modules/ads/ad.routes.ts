import { Router } from "express";
import { z } from "zod";
import { httpUrlRe, uploadedImageRe } from "../../lib/limits.js";
import { pageQuery } from "../../lib/pagination.js";
import { requireAuth, requireBusinessAccess } from "../../middleware/auth.js";
import { body, parse } from "../../middleware/validate.js";
import * as svc from "./ad.service.js";

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const bid = (r: any) => String(r.params.businessId);
const fields = {
  title: z.string().trim().min(1).max(120), description: z.string().trim().max(500).optional(),
  imageUrl: z.string().regex(uploadedImageRe, "Upload the image first, then use its URL").optional(),
  ctaLabel: z.string().trim().max(30).optional(), ctaUrl: z.string().trim().regex(httpUrlRe, "Use a full http(s) link").max(500).optional(),
  placements: z.array(z.enum(["discover", "business_profile", "product_discovery"])).min(1).max(3), startDate: date, endDate: date,
};

export const adRouter = Router({ mergeParams: true });
adRouter.use(requireAuth);
adRouter.post("/", requireBusinessAccess("ads.manage"), body(z.object(fields)), async (req, res) => res.status(201).json({ ad: await svc.createAd(bid(req), req.user!.id, req.body, req.ip) }));
adRouter.get("/", requireBusinessAccess("ads.manage"), async (req, res) => {
  const q = parse(pageQuery.extend({ status: z.enum(["draft", "active", "paused"]).optional() }), req.query);
  res.json(await svc.listAds(bid(req), q));
});
adRouter.get("/:id", requireBusinessAccess("ads.manage"), async (req, res) => res.json({ ad: await svc.getAd(bid(req), parse(uuid, req.params.id)) }));
adRouter.patch("/:id", requireBusinessAccess("ads.manage"), body(z.object({ ...fields, status: z.enum(["draft", "active", "paused"]) }).partial()),
  async (req, res) => res.json({ ad: await svc.updateAd(bid(req), parse(uuid, req.params.id), req.user!.id, req.body, req.ip) }));
adRouter.delete("/:id", requireBusinessAccess("ads.manage"), async (req, res) => { await svc.deleteAd(bid(req), parse(uuid, req.params.id), req.user!.id, req.ip); res.json({ ok: true }); });
