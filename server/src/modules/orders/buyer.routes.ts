import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { STATE_CODES } from "../../lib/gst.js";
import { isTest } from "../../config.js";
import { pageQuery } from "../../lib/pagination.js";
import { body, parse } from "../../middleware/validate.js";
import * as svc from "./buyer.service.js";

const uuid = z.string().uuid();
const placeLimiter = rateLimit({ windowMs: 60 * 60_000, max: 20, skip: () => isTest, standardHeaders: true, legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "Too many orders. Please try again later." } } });
const me = (req: any) => req.user.id as string;

// Mounted at /api/me/orders behind requireAuth + individual-accounts-only (see me.routes.ts).
export const buyerOrderRouter = Router();

buyerOrderRouter.post("/", placeLimiter, body(z.object({
  businessId: uuid,
  items: z.array(z.object({ productId: uuid, quantity: z.number().positive().max(10_000) }).strict()).min(1).max(50),
  deliveryAddress: z.string().trim().min(8, "Enter your full delivery address").max(500),
  phone: z.string().trim().regex(/^[+\d][\d\s-]{6,18}$/, "Enter a valid phone number"),
  notes: z.string().trim().max(500).optional(), stateCode: z.enum(STATE_CODES).optional(),
}).strict()), async (req, res) => res.status(201).json({ order: await svc.placeOrder(me(req), req.body, req.ip) }));

buyerOrderRouter.get("/", async (req, res) => { const q = parse(pageQuery, req.query); res.json(await svc.listMine(req.user!.id, q.limit, q.offset)); });
buyerOrderRouter.get("/:id", async (req, res) => res.json({ order: await svc.getMine(req.user!.id, parse(uuid, req.params.id)) }));
buyerOrderRouter.get("/:id/invoice", async (req, res) => res.json({ invoice: await svc.invoiceFor(req.user!.id, parse(uuid, req.params.id)) }));
buyerOrderRouter.post("/:id/cancel", async (req, res) => res.json({ order: await svc.cancelMine(me(req), parse(uuid, req.params.id), req.ip) }));
