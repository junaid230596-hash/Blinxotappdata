import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireBusinessAccess } from "../../middleware/auth.js";
import { body } from "../../middleware/validate.js";
import { listPlans, selfChangePlan, subscriptionView } from "./plan.service.js";

export const plansRouter = Router();
plansRouter.get("/", async (_req, res) => res.json({ plans: await listPlans() }));

export const subscriptionRouter = Router({ mergeParams: true });
subscriptionRouter.use(requireAuth);
subscriptionRouter.get("/", requireBusinessAccess(), async (req, res) => res.json({ subscription: await subscriptionView(String(req.params.businessId)) }));
// Owners can only move to a cheaper plan; upgrades need payment confirmation (admin endpoint / payment webhook).
subscriptionRouter.put("/", requireBusinessAccess("business.manage"), body(z.object({ planKey: z.string().min(1).max(40) })),
  async (req, res) => res.json({ subscription: await selfChangePlan(String(req.params.businessId), req.body.planKey, req.user!.id, req.ip) }));
