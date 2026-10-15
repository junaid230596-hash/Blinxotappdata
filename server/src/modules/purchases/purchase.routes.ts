import { Router } from "express";
import { z } from "zod";
import { pageQuery } from "../../lib/pagination.js";
import { requireAuth, requireBusinessAccess } from "../../middleware/auth.js";
import { body, parse } from "../../middleware/validate.js";
import * as sup from "../suppliers/supplier.service.js";
import * as svc from "./purchase.service.js";

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const bid = (r: any) => String(r.params.businessId);
const pid = (r: any) => parse(uuid, r.params.purchaseId);
const item = z.object({
  productId: uuid.optional(), supplierProductId: uuid.optional(), name: z.string().trim().min(1).max(200).optional(), sku: z.string().trim().max(64).optional(),
  quantity: z.number().positive().max(1_000_000), unitCost: z.number().min(0).max(100_000_000).optional(),
});

export const purchaseRouter = Router({ mergeParams: true });
purchaseRouter.use(requireAuth);

purchaseRouter.post("/", requireBusinessAccess("purchases.manage"), body(z.object({
  supplierId: uuid, items: z.array(item).min(1).max(200), notes: z.string().trim().max(1000).optional(), expectedDate: date.optional(),
})), async (req, res) => res.status(201).json({ purchase: await svc.createPurchase(bid(req), req.user!.id, req.body, req.ip) }));

purchaseRouter.get("/", requireBusinessAccess("purchases.view"), async (req, res) => {
  const q = parse(pageQuery.extend({
    status: z.enum(["draft", "sent", "accepted", "partially_received", "received", "cancelled"]).optional(), supplierId: uuid.optional(),
    q: z.string().trim().max(50).optional(), from: date.optional(), to: date.optional(),
    pending: z.enum(["true", "false"]).optional().transform((v) => v === "true"),
  }), req.query);
  res.json(await svc.listPurchases(bid(req), q));
});
purchaseRouter.get("/:purchaseId", requireBusinessAccess("purchases.view"), async (req, res) => res.json({ purchase: await svc.getPurchase(bid(req), pid(req)) }));
purchaseRouter.patch("/:purchaseId", requireBusinessAccess("purchases.manage"),
  body(z.object({ items: z.array(item).min(1).max(200), notes: z.string().trim().max(1000).nullable(), expectedDate: date.nullable() }).partial()),
  async (req, res) => res.json({ purchase: await svc.updatePurchase(bid(req), pid(req), req.user!.id, req.body, req.ip) }));
purchaseRouter.post("/:purchaseId/send", requireBusinessAccess("purchases.manage"), async (req, res) => res.json({ purchase: await svc.sendPurchase(bid(req), pid(req), req.user!.id, req.ip) }));
purchaseRouter.post("/:purchaseId/accept", requireBusinessAccess("purchases.manage"), async (req, res) => res.json({ purchase: await svc.acceptPurchase(bid(req), pid(req), req.user!.id, req.ip) }));
purchaseRouter.post("/:purchaseId/cancel", requireBusinessAccess("purchases.manage"), async (req, res) => res.json({ purchase: await svc.cancelPurchase(bid(req), pid(req), req.user!.id, req.ip) }));
purchaseRouter.post("/:purchaseId/receive", requireBusinessAccess("purchases.manage"), body(z.object({
  items: z.array(z.object({ itemId: uuid, quantity: z.number().positive().max(1_000_000), unitCost: z.number().min(0).max(100_000_000).optional(), productId: uuid.optional() })).min(1).max(200),
})), async (req, res) => res.json({ purchase: await svc.receivePurchase(bid(req), pid(req), req.user!.id, req.body.items, req.ip) }));

export const supplierRouter = Router({ mergeParams: true });
supplierRouter.use(requireAuth);
const sFields = {
  name: z.string().trim().min(1).max(160), contactName: z.string().trim().max(120).optional(), email: z.string().trim().email().max(254).optional(),
  phone: z.string().trim().max(30).optional(), address: z.string().trim().max(300).optional(), notes: z.string().trim().max(1000).optional(),
  linkedBusinessId: uuid.nullable().optional(),
};
supplierRouter.post("/", requireBusinessAccess("purchases.manage"), body(z.object(sFields)),
  async (req, res) => res.status(201).json({ supplier: await sup.createSupplier(bid(req), req.user!.id, req.body, req.ip) }));
supplierRouter.get("/", requireBusinessAccess("purchases.view"), async (req, res) => {
  const q = parse(pageQuery.extend({ q: z.string().trim().max(100).optional(), status: z.enum(["active", "inactive"]).optional() }), req.query);
  res.json(await sup.listSuppliers(bid(req), q));
});
supplierRouter.get("/:supplierId", requireBusinessAccess("purchases.view"), async (req, res) => res.json({ supplier: await sup.getSupplier(bid(req), parse(uuid, req.params.supplierId)) }));
supplierRouter.get("/:supplierId/products", requireBusinessAccess("purchases.view"), async (req, res) =>
  res.json(await sup.supplierProducts(bid(req), parse(uuid, req.params.supplierId), parse(z.object({ q: z.string().trim().max(100).optional() }), req.query).q)));
supplierRouter.patch("/:supplierId", requireBusinessAccess("purchases.manage"), body(z.object({ ...sFields, status: z.enum(["active", "inactive"]).optional() }).partial()),
  async (req, res) => res.json({ supplier: await sup.updateSupplier(bid(req), parse(uuid, req.params.supplierId), req.user!.id, req.body, req.ip) }));
