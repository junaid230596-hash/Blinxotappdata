import { Router } from "express";
import { z } from "zod";
import { httpUrlRe, uploadedImageRe } from "../../lib/limits.js";
import { requireAccountType, requireAuth, requireBusinessAccess } from "../../middleware/auth.js";
import { body, parse } from "../../middleware/validate.js";
import { attendanceRouter, selfRouter, settingsRouter } from "../attendance/attendance.routes.js";
import { employeeRouter } from "../employees/employee.routes.js";
import { salaryRouter } from "../salary/salary.routes.js";
import { taskRouter } from "../tasks/task.routes.js";
import { inventoryRouter } from "../inventory/inventory.routes.js";
import { categoryRouter, productRouter } from "../products/product.routes.js";
import { adRouter } from "../ads/ad.routes.js";
import { applicationRouter, jobRouter } from "../jobs/job.routes.js";
import { crmRouter } from "../crm/crm.routes.js";
import { documentRouter, expiringRouter, leaveRouter, performanceRouter } from "../hr/hr.routes.js";
import { subscriptionRouter } from "../plans/plan.routes.js";
import { reportRouter } from "../reports/report.routes.js";
import { customerRouter } from "../customers/customer.routes.js";
import { orderRouter, returnsRouter } from "../orders/order.routes.js";
import { purchaseRouter, supplierRouter } from "../purchases/purchase.routes.js";
import { businessDashboard } from "../dashboard/dashboard.service.js";
import { STATE_CODES, validGstin } from "../../lib/gst.js";
import { invoiceRouter } from "../invoices/invoice.routes.js";
import { aiRouter } from "../ai/ai.routes.js";
import * as svc from "./business.service.js";

const uuid = z.string().uuid();
const optStr = (n: number) => z.string().trim().max(n).optional().or(z.literal("").transform(() => undefined));
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM");
const dayHours = z.union([z.object({ closed: z.literal(true) }).strict(), z.object({ open: hhmm, close: hhmm }).strict().refine((d) => d.open < d.close, "Closing time must be after opening time")]);
const businessHours = z.object(Object.fromEntries(DAYS.map((d) => [d, dayHours.optional()])) as Record<(typeof DAYS)[number], z.ZodOptional<typeof dayHours>>).strict();
const SOCIALS = ["facebook", "instagram", "x", "linkedin", "youtube", "whatsapp"] as const;
const socialUrl = z.string().trim().max(300).regex(httpUrlRe, "Must be an http(s) link");
const socialLinks = z.object(Object.fromEntries(SOCIALS.map((k) => [k, socialUrl.optional()])) as Record<(typeof SOCIALS)[number], z.ZodOptional<typeof socialUrl>>).strict();
const gstinField = z.union([z.literal(""), z.string().trim().toUpperCase().refine(validGstin, "Enter a valid 15-character GSTIN")]);
const fields = {
  legalName: optStr(160), gstin: gstinField.optional(), stateCode: z.union([z.literal(""), z.enum(STATE_CODES)]).optional(),
  description: optStr(2000), category: optStr(80), email: z.string().trim().email().max(254).optional(),
  phone: optStr(30), website: z.string().trim().max(300).regex(httpUrlRe, "Use a full http(s) link").optional(), address: optStr(300),
};

export const businessRouter = Router();
businessRouter.use(requireAuth);

businessRouter.post("/", requireAccountType("business_owner", "supplier"),
  body(z.object({ name: z.string().trim().min(1).max(160), ...fields })),
  async (req, res) => res.status(201).json({ business: await svc.createBusiness(req.user!, req.body, req.ip) }));

businessRouter.get("/mine", async (req, res) => res.json({ businesses: await svc.listMine(req.user!.id) }));

// Param guard: reject malformed IDs before they reach the database.
businessRouter.param("businessId", (req, _res, next, v) => { try { parse(uuid, v); next(); } catch (e) { next(e); } });

businessRouter.use("/:businessId/employees", employeeRouter);
businessRouter.use("/:businessId/attendance", attendanceRouter);
businessRouter.use("/:businessId/attendance-settings", settingsRouter);
businessRouter.use("/:businessId/me", selfRouter);
businessRouter.use("/:businessId/salary", salaryRouter);
businessRouter.use("/:businessId/tasks", taskRouter);
businessRouter.use("/:businessId/products", productRouter);
businessRouter.use("/:businessId/categories", categoryRouter);
businessRouter.use("/:businessId/inventory", inventoryRouter);
businessRouter.use("/:businessId/suppliers", supplierRouter);
businessRouter.use("/:businessId/purchases", purchaseRouter);
businessRouter.use("/:businessId/orders", orderRouter);
businessRouter.use("/:businessId/returns", returnsRouter);
businessRouter.use("/:businessId/customers", customerRouter);
businessRouter.use("/:businessId/crm", crmRouter);
businessRouter.use("/:businessId/reports", reportRouter);
businessRouter.use("/:businessId/subscription", subscriptionRouter);
businessRouter.use("/:businessId/leave", leaveRouter);
businessRouter.use("/:businessId/performance", performanceRouter);
businessRouter.use("/:businessId/documents", expiringRouter);
businessRouter.use("/:businessId/employees/:employeeId/documents", documentRouter);
businessRouter.use("/:businessId/jobs", jobRouter);
businessRouter.use("/:businessId/applications", applicationRouter);
businessRouter.use("/:businessId/ads", adRouter);
businessRouter.use("/:businessId/ai", aiRouter);
businessRouter.use("/:businessId/invoices", invoiceRouter);

businessRouter.get("/:businessId", requireBusinessAccess(), async (req, res) =>
  res.json({ business: await svc.getBusiness(req.params.businessId as string), permissions: [...req.permissions!] }));

businessRouter.patch("/:businessId", requireBusinessAccess("business.manage"),
  body(z.object({ name: z.string().trim().min(1).max(160), ...fields, logoUrl: z.string().max(300).refine((v) => uploadedImageRe.test(v) || httpUrlRe.test(v), "Use an uploaded image or an http(s) link").optional(), isPublic: z.boolean().optional(), businessHours, socialLinks }).partial()),
  async (req, res) => res.json({ business: await svc.updateBusiness(req.params.businessId as string, req.user!.id, req.body, req.ip) }));

businessRouter.get("/:businessId/dashboard", requireBusinessAccess(),
  async (req, res) => res.json(await businessDashboard(String(req.params.businessId), req.user!.id, req.permissions!)));

businessRouter.get("/:businessId/members", requireBusinessAccess("members.view"),
  async (req, res) => res.json({ members: await svc.listMembers(req.params.businessId as string) }));

businessRouter.get("/:businessId/roles", requireBusinessAccess("members.view"),
  async (req, res) => res.json({ roles: await svc.listRoles(req.params.businessId as string) }));

businessRouter.patch("/:businessId/members/:memberId", requireBusinessAccess("members.manage"),
  body(z.object({ roleId: uuid })),
  async (req, res) => {
    await svc.changeMemberRole(req.params.businessId as string, parse(uuid, req.params.memberId), req.body.roleId, req.user!.id, req.ip);
    res.json({ ok: true });
  });

businessRouter.get("/:businessId/audit", requireBusinessAccess("audit.view"), async (req, res) => {
  const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(100).default(25), offset: z.coerce.number().int().min(0).default(0) }), req.query);
  res.json({ entries: await svc.listAudit(req.params.businessId as string, q.limit, q.offset) });
});

export const publicBusinessRouter = Router();
publicBusinessRouter.get("/businesses/:slug", async (req, res) =>
  res.json({ business: await svc.getPublicBySlug(String(req.params.slug)) }));
