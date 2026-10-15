import { Router } from "express";
import { z } from "zod";
import { pageQuery } from "../../lib/pagination.js";
import { requireAccountType, requireAuth } from "../../middleware/auth.js";
import { body, parse } from "../../middleware/validate.js";
import * as ads from "../ads/ad.service.js";
import * as plans from "../plans/plan.service.js";
import * as reviews from "../reviews/review.service.js";
import * as settings from "../settings/settings.service.js";
import * as svc from "./admin.service.js";

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const id = (r: any) => parse(uuid, r.params.id);
const reason = z.object({ reason: z.string().trim().max(300).optional() });

// Super-admin only. Everything here is audited with the acting admin.
export const adminRouter = Router();
adminRouter.use(requireAuth, requireAccountType("super_admin"));

adminRouter.get("/overview", async (_req, res) => res.json(await svc.overview()));

// users & suspended accounts
adminRouter.get("/users", async (req, res) => {
  const q = parse(pageQuery.extend({ q: z.string().trim().max(100).optional(), status: z.enum(["active", "suspended"]).optional(),
    accountType: z.enum(["individual", "business_owner", "employee", "supplier", "super_admin"]).optional() }), req.query);
  res.json(await svc.listUsers(q));
});
adminRouter.get("/users/:id", async (req, res) => res.json({ user: await svc.getUser(id(req)) }));
adminRouter.post("/users/:id/suspend", body(reason), async (req, res) => res.json({ user: await svc.setUserStatus(req.user!.id, id(req), "suspended", req.body.reason, req.ip) }));
adminRouter.post("/users/:id/reactivate", body(reason), async (req, res) => res.json({ user: await svc.setUserStatus(req.user!.id, id(req), "active", req.body.reason, req.ip) }));

// businesses & subscriptions
adminRouter.get("/businesses", async (req, res) => {
  const q = parse(pageQuery.extend({ q: z.string().trim().max(100).optional(), status: z.enum(["active", "suspended"]).optional() }), req.query);
  res.json(await svc.listBusinesses(q));
});
adminRouter.post("/businesses/:id/suspend", body(reason), async (req, res) => res.json(await svc.setBusinessStatus(req.user!.id, id(req), "suspended", req.body.reason, req.ip)));
adminRouter.post("/businesses/:id/reactivate", body(reason), async (req, res) => res.json(await svc.setBusinessStatus(req.user!.id, id(req), "active", req.body.reason, req.ip)));
adminRouter.get("/businesses/:id/subscription", async (req, res) => res.json({ subscription: await plans.subscriptionView(id(req)) }));
adminRouter.put("/businesses/:id/subscription", body(z.object({ planKey: z.string().min(1).max(40), provider: z.string().max(40).optional(), providerRef: z.string().max(200).optional(), periodEnd: z.coerce.date().optional() })),
  async (req, res) => res.json({ subscription: await plans.setPlan(id(req), req.body.planKey, req.user!.id, req.body, req.ip) }));

// platform-wide read access: employees, products, orders
adminRouter.get("/employees", async (req, res) => res.json(await svc.listEmployees(parse(pageQuery.extend({ q: z.string().trim().max(100).optional(), businessId: uuid.optional() }), req.query))));
adminRouter.get("/products", async (req, res) => res.json(await svc.listProducts(parse(pageQuery.extend({ q: z.string().trim().max(100).optional(), businessId: uuid.optional() }), req.query))));
adminRouter.patch("/products/:id", body(z.object({ status: z.enum(["active", "inactive"]), isListed: z.boolean() }).partial()),
  async (req, res) => { await svc.setProductStatus(req.user!.id, id(req), req.body, req.ip); res.json({ ok: true }); });
adminRouter.get("/orders", async (req, res) => res.json(await svc.listOrders(parse(pageQuery.extend({ q: z.string().trim().max(50).optional(),
  status: z.enum(["pending", "accepted", "processing", "ready", "dispatched", "delivered", "cancelled", "returned"]).optional(), businessId: uuid.optional() }), req.query))));

// audit log viewer
adminRouter.get("/audit", async (req, res) => res.json(await svc.listAudit(parse(pageQuery.extend({
  actorId: uuid.optional(), businessId: uuid.optional(), action: z.string().trim().max(60).optional(), from: date.optional(), to: date.optional() }), req.query))));

// platform categories
adminRouter.get("/categories", async (req, res) => res.json({ categories: await svc.listCategories(parse(z.object({ kind: z.enum(["business", "product"]).optional() }), req.query).kind) }));
adminRouter.post("/categories", body(z.object({ kind: z.enum(["business", "product"]), name: z.string().trim().min(1).max(80) })), async (req, res) => res.status(201).json({ category: await svc.createCategory(req.user!.id, req.body.kind, req.body.name) }));
adminRouter.patch("/categories/:id", body(z.object({ name: z.string().trim().min(1).max(80) })), async (req, res) => res.json({ category: await svc.renameCategory(req.user!.id, id(req), req.body.name) }));
adminRouter.delete("/categories/:id", async (req, res) => { await svc.deleteCategory(req.user!.id, id(req)); res.json({ ok: true }); });

// system settings
adminRouter.get("/settings", async (_req, res) => res.json({ settings: await settings.allSettings() }));
adminRouter.put("/settings/:key", body(z.object({ value: z.unknown() })), async (req, res) =>
  res.json({ settings: await settings.setSetting(req.user!.id, String(req.params.key), req.body.value, req.ip) }));

// reported content: reviews and ads
adminRouter.get("/reviews", async (req, res) => {
  const q = parse(pageQuery.extend({ status: z.enum(["published", "hidden"]).optional(), reported: z.enum(["true", "false"]).optional().transform((v) => v === "true") }), req.query);
  res.json(await reviews.adminList(q));
});
adminRouter.post("/reviews/:id/hide", body(z.object({ reason: z.string().trim().min(3).max(300) })), async (req, res) => { await reviews.adminHide(req.user!.id, id(req), req.body.reason); res.json({ ok: true }); });
adminRouter.post("/reviews/:id/restore", async (req, res) => { await reviews.adminRestore(req.user!.id, id(req)); res.json({ ok: true }); });
adminRouter.get("/ads", async (req, res) => {
  const q = parse(pageQuery.extend({ moderation: z.enum(["approved", "rejected"]).optional() }), req.query);
  res.json(await ads.adminList(q));
});
adminRouter.post("/ads/:id/approve", async (req, res) => { await ads.adminModerate(req.user!.id, id(req), "approved"); res.json({ ok: true }); });
adminRouter.post("/ads/:id/reject", body(z.object({ note: z.string().trim().min(3).max(300) })), async (req, res) => { await ads.adminModerate(req.user!.id, id(req), "rejected", req.body.note); res.json({ ok: true }); });
