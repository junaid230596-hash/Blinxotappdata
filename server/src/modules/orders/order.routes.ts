import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { STATE_CODES } from "../../lib/gst.js";
import { isTest } from "../../config.js";
import { pageQuery } from "../../lib/pagination.js";
import { requireAuth, requireBusinessAccess } from "../../middleware/auth.js";
import { body, parse } from "../../middleware/validate.js";
import * as svc from "./order.service.js";

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const status = z.enum(["pending", "accepted", "processing", "ready", "dispatched", "delivered", "cancelled", "returned"]);
const bid = (r: any) => String(r.params.businessId);
const oid = (r: any) => parse(uuid, r.params.orderId);
const otpLimiter = rateLimit({ windowMs: 15 * 60_000, max: 30, skip: () => isTest, standardHeaders: true, legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "Too many attempts. Try again later." } } });

export const orderRouter = Router({ mergeParams: true });
orderRouter.use(requireAuth);

orderRouter.post("/", requireBusinessAccess("orders.create"), body(z.object({
  customerId: uuid.nullable().optional(), notes: z.string().trim().max(1000).optional(), deliveryAddress: z.string().trim().max(500).optional(),
  requireOtp: z.boolean().optional(), placeOfSupply: z.enum(STATE_CODES).optional(),
  items: z.array(z.object({ productId: uuid, quantity: z.number().positive().max(1_000_000), unitPrice: z.number().min(0).max(100_000_000).optional() })).min(1).max(100),
})), async (req, res) => res.status(201).json({ order: await svc.createOrder(bid(req), req.user!.id, req.permissions!.has("orders.manage"), req.body, req.ip) }));

orderRouter.get("/", requireBusinessAccess("orders.view"), async (req, res) => {
  const q = parse(pageQuery.extend({ status: status.optional(), customerId: uuid.optional(), q: z.string().trim().max(50).optional(),
    source: z.enum(["marketplace", "direct"]).optional(), from: date.optional(), to: date.optional() }), req.query);
  res.json(await svc.listOrders(bid(req), q));
});
orderRouter.get("/:orderId", requireBusinessAccess("orders.view"), async (req, res) => res.json({ order: await svc.getOrder(bid(req), oid(req)) }));

orderRouter.patch("/:orderId/status", requireBusinessAccess("orders.manage"), body(z.object({ status })),
  async (req, res) => res.json({ order: await svc.transition(bid(req), oid(req), req.body.status, req.user!.id, req.ip) }));

orderRouter.post("/:orderId/otp/verify", requireBusinessAccess("orders.manage"), otpLimiter, body(z.object({ otp: z.string().regex(/^\d{6}$/, "Enter the 6-digit code") })),
  async (req, res) => res.json({ order: await svc.verifyOtp(bid(req), oid(req), req.body.otp, req.user!.id, req.ip) }));
orderRouter.post("/:orderId/otp/regenerate", requireBusinessAccess("orders.manage"), otpLimiter,
  async (req, res) => { await svc.regenerateOtp(bid(req), oid(req), req.user!.id, req.ip); res.json({ ok: true, message: "A new code was sent to the buyer." }); });

orderRouter.post("/:orderId/returns", requireBusinessAccess("orders.manage"), body(z.object({
  reason: z.string().trim().max(500).optional(),
  items: z.array(z.object({ orderItemId: uuid, quantity: z.number().positive().max(1_000_000), condition: z.enum(["resellable", "damaged"]) })).min(1).max(100),
})), async (req, res) => res.status(201).json({ order: await svc.createReturn(bid(req), oid(req), req.user!.id, req.body, req.ip) }));

export const returnsRouter = Router({ mergeParams: true });
returnsRouter.use(requireAuth);
returnsRouter.get("/", requireBusinessAccess("orders.view"), async (req, res) => {
  const q = parse(pageQuery, req.query);
  res.json(await svc.listReturns(bid(req), q.limit, q.offset));
});
