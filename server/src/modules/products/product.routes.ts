import { Router } from "express";
import { z } from "zod";
import { pageQuery } from "../../lib/pagination.js";
import { requireAuth, requireBusinessAccess } from "../../middleware/auth.js";
import { body, parse } from "../../middleware/validate.js";
import * as svc from "./product.service.js";

const uuid = z.string().uuid();
const money = z.number().min(0).max(100_000_000);
const qty = z.number().min(0).max(1_000_000_000);
const image = z.string().regex(/^\/uploads\/[0-9a-f-]{36}\.(png|jpg|webp)$/, "Upload the image first, then use its URL");
const fields = {
  hsnCode: z.union([z.literal(""), z.string().trim().regex(/^\d{4,8}$/, "HSN/SAC must be 4 to 8 digits")]).nullable().optional(),
  name: z.string().trim().min(1).max(200), sku: z.string().trim().max(64).optional(), barcode: z.string().trim().max(64).nullable().optional(),
  description: z.string().trim().max(5000).nullable().optional(), categoryId: uuid.nullable().optional(), supplierId: uuid.nullable().optional(),
  images: z.array(image).max(8).optional(), costPrice: money.optional(), sellingPrice: money.optional(), taxRate: z.number().min(0).max(100).optional(),
  unit: z.string().trim().min(1).max(20).optional(), minStock: qty.optional(), isListed: z.boolean().optional(),
};
const bid = (r: any) => String(r.params.businessId);

export const productRouter = Router({ mergeParams: true });
productRouter.use(requireAuth);
// Cost prices are only visible to users who can manage products.
const cost = (r: any) => r.permissions.has("products.manage");

productRouter.post("/", requireBusinessAccess("products.manage"),
  body(z.object({ ...fields, openingStock: qty.optional() })),
  async (req, res) => res.status(201).json({ product: await svc.createProduct(bid(req), req.user!.id, req.body, cost(req), req.ip) }));

productRouter.get("/", requireBusinessAccess("products.view"), async (req, res) => {
  const q = parse(pageQuery.extend({
    q: z.string().trim().max(100).optional(), categoryId: uuid.optional(), supplierId: uuid.optional(), status: z.enum(["active", "inactive"]).optional(),
    lowStock: z.enum(["true", "false"]).optional().transform((v) => v === "true"),
    sort: z.enum(["name", "sku", "stock", "price", "created"]).optional(), dir: z.enum(["asc", "desc"]).optional(),
  }), req.query);
  res.json(await svc.listProducts(bid(req), q, cost(req)));
});

productRouter.get("/:productId", requireBusinessAccess("products.view"), async (req, res) =>
  res.json({ product: await svc.getProduct(bid(req), parse(uuid, req.params.productId), cost(req)) }));

productRouter.patch("/:productId", requireBusinessAccess("products.manage"),
  body(z.object({ ...fields, status: z.enum(["active", "inactive"]).optional() }).partial()),
  async (req, res) => res.json({ product: await svc.updateProduct(bid(req), parse(uuid, req.params.productId), req.user!.id, req.body, cost(req), req.ip) }));

productRouter.delete("/:productId", requireBusinessAccess("products.manage"), async (req, res) => {
  await svc.deactivateProduct(bid(req), parse(uuid, req.params.productId), req.user!.id, req.ip);
  res.json({ ok: true });
});

export const categoryRouter = Router({ mergeParams: true });
categoryRouter.use(requireAuth);
const catName = z.object({ name: z.string().trim().min(1).max(80) });
categoryRouter.get("/", requireBusinessAccess("products.view"), async (req, res) => res.json({ categories: await svc.listCategories(bid(req)) }));
categoryRouter.post("/", requireBusinessAccess("products.manage"), body(catName),
  async (req, res) => res.status(201).json({ category: await svc.createCategory(bid(req), req.user!.id, req.body.name, req.ip) }));
categoryRouter.patch("/:id", requireBusinessAccess("products.manage"), body(catName),
  async (req, res) => res.json({ category: await svc.renameCategory(bid(req), parse(uuid, req.params.id), req.body.name) }));
categoryRouter.delete("/:id", requireBusinessAccess("products.manage"), async (req, res) => {
  await svc.deleteCategory(bid(req), parse(uuid, req.params.id), req.user!.id, req.ip);
  res.json({ ok: true });
});
