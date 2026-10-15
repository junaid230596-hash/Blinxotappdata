import { Router } from "express";
import { z } from "zod";
import { pageQuery } from "../../lib/pagination.js";
import { requireAuth, requireBusinessAccess } from "../../middleware/auth.js";
import { body, parse } from "../../middleware/validate.js";
import * as svc from "./inventory.service.js";

const uuid = z.string().uuid();
const posQty = z.number().positive().max(1_000_000_000);
const note = z.string().trim().max(500).optional();
const bid = (r: any) => String(r.params.businessId);
const ctx = (r: any) => ({ businessId: bid(r), actorId: r.user.id as string, ip: r.ip });

export const inventoryRouter = Router({ mergeParams: true });
inventoryRouter.use(requireAuth);

inventoryRouter.post("/stock-in", requireBusinessAccess("inventory.manage"),
  body(z.object({ productId: uuid, quantity: posQty, unitCost: z.number().min(0).max(100_000_000).optional(), note })),
  async (req, res) => res.status(201).json({ result: await svc.stockIn(ctx(req), req.body) }));
inventoryRouter.post("/stock-out", requireBusinessAccess("inventory.manage"),
  body(z.object({ productId: uuid, quantity: posQty, note })),
  async (req, res) => res.status(201).json({ result: await svc.stockOut(ctx(req), req.body) }));
inventoryRouter.post("/damaged", requireBusinessAccess("inventory.manage"),
  body(z.object({ productId: uuid, quantity: posQty, note })),
  async (req, res) => res.status(201).json({ result: await svc.writeOffDamaged(ctx(req), req.body) }));
inventoryRouter.post("/adjust", requireBusinessAccess("inventory.manage"),
  body(z.object({ productId: uuid, newQuantity: z.number().min(0).max(1_000_000_000), reason: z.string().trim().min(3).max(500) })),
  async (req, res) => res.json({ result: await svc.adjust(ctx(req), req.body) }));

inventoryRouter.get("/movements", requireBusinessAccess("inventory.view"), async (req, res) => {
  const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
  const q = parse(pageQuery.extend({
    productId: uuid.optional(), from: date.optional(), to: date.optional(),
    type: z.enum(["opening", "stock_in", "stock_out", "adjustment", "purchase_receipt", "sale", "sale_cancel", "sale_return", "damaged"]).optional(),
  }), req.query);
  res.json(await svc.listMovements(bid(req), q));
});
inventoryRouter.get("/low-stock", requireBusinessAccess("inventory.view"), async (req, res) => res.json({ products: await svc.lowStock(bid(req)) }));
// Valuation exposes cost data, so it needs the reports permission.
inventoryRouter.get("/valuation", requireBusinessAccess("reports.view"), async (req, res) => res.json(await svc.valuation(bid(req))));
