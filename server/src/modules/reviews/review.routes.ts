import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import { body, parse } from "../../middleware/validate.js";
import * as svc from "./review.service.js";

const uuid = z.string().uuid();
const subject = z.object({ subjectType: z.enum(["business", "individual"]), subjectId: uuid });

export const reviewRouter = Router();
reviewRouter.use(requireAuth);

reviewRouter.get("/can-review", async (req, res) => {
  const q = parse(subject, req.query);
  res.json(await svc.canReview(req.user!.id, { type: q.subjectType, id: q.subjectId }));
});
reviewRouter.post("/", body(subject.extend({ rating: z.number().int().min(1).max(5), body: z.string().trim().max(2000).optional() })),
  async (req, res) => res.status(201).json({ review: await svc.createReview(req.user!.id, req.body, req.ip) }));
reviewRouter.patch("/:id", body(z.object({ rating: z.number().int().min(1).max(5), body: z.string().trim().max(2000).nullable() }).partial()),
  async (req, res) => res.json({ review: await svc.updateReview(req.user!.id, parse(uuid, req.params.id), req.body) }));
reviewRouter.delete("/:id", async (req, res) => { await svc.deleteReview(req.user!.id, parse(uuid, req.params.id)); res.json({ ok: true }); });
reviewRouter.post("/:id/report", body(z.object({ reason: z.string().trim().min(3).max(500) })),
  async (req, res) => res.json(await svc.reportReview(req.user!.id, parse(uuid, req.params.id), req.body.reason, req.ip)));
