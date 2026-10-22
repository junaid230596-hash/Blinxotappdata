import { Router, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { config } from "../../config.js";
import { badRequest } from "../../lib/errors.js";
import { pageQuery } from "../../lib/pagination.js";
import { requireAuth, requireBusinessAccess } from "../../middleware/auth.js";
import { body, parse } from "../../middleware/validate.js";
import * as svc from "./hr.service.js";

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const bid = (r: any) => String(r.params.businessId);
const rid = (r: any, k = "id") => parse(uuid, r.params[k]);
const text = (n: number) => z.string().trim().max(n);

// ---------- leave (manager side) ----------
export const leaveRouter = Router({ mergeParams: true });
leaveRouter.use(requireAuth);
leaveRouter.get("/", requireBusinessAccess("leave.view"), async (req, res) => {
  const q = parse(pageQuery.extend({ status: z.enum(["pending", "approved", "rejected", "cancelled"]).optional(), employeeId: uuid.optional(), from: date.optional(), to: date.optional() }), req.query);
  res.json(await svc.listLeave(bid(req), q));
});
leaveRouter.patch("/:id/decision", requireBusinessAccess("leave.manage"), body(z.object({ decision: z.enum(["approved", "rejected"]), note: text(500).optional() })),
  async (req, res) => res.json({ leave: await svc.decideLeave(bid(req), rid(req), req.user!.id, req.body, req.ip) }));

// ---------- performance reviews (manager side) ----------
const perfFields = { periodStart: date, periodEnd: date, rating: z.number().int().min(1).max(5), strengths: text(3000).optional(), improvements: text(3000).optional(), goals: text(3000).optional() };
export const performanceRouter = Router({ mergeParams: true });
performanceRouter.use(requireAuth);
performanceRouter.post("/", requireBusinessAccess("performance.manage"), body(z.object({ employeeId: uuid, ...perfFields })),
  async (req, res) => res.status(201).json({ review: await svc.createReview(bid(req), req.user!.id, req.body, req.ip) }));
performanceRouter.get("/", requireBusinessAccess("performance.view"), async (req, res) => {
  const q = parse(pageQuery.extend({ employeeId: uuid.optional(), status: z.enum(["draft", "shared"]).optional() }), req.query);
  res.json(await svc.listReviews(bid(req), q));
});
performanceRouter.get("/:id", requireBusinessAccess("performance.view"), async (req, res) => res.json({ review: await svc.getReview(bid(req), rid(req)) }));
performanceRouter.patch("/:id", requireBusinessAccess("performance.manage"), body(z.object(perfFields).partial()),
  async (req, res) => res.json({ review: await svc.updateReview(bid(req), rid(req), req.user!.id, req.body, req.ip) }));
performanceRouter.post("/:id/share", requireBusinessAccess("performance.manage"), async (req, res) => res.json({ review: await svc.shareReview(bid(req), rid(req), req.user!.id, req.ip) }));
performanceRouter.delete("/:id", requireBusinessAccess("performance.manage"), async (req, res) => { await svc.deleteReview(bid(req), rid(req), req.user!.id, req.ip); res.json({ ok: true }); });

// ---------- employee documents (private files) ----------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 1 } });
const category = z.enum(["contract", "id_proof", "certificate", "payslip", "other"]);
const eid = (r: any) => rid(r, "employeeId");

function sendPrivateFile(res: Response, f: { file: { stream: NodeJS.ReadableStream; size?: number }; mime: string; filename: string }) {
  res.setHeader("Content-Type", f.mime);
  res.setHeader("Content-Disposition", `attachment; filename="${f.filename}"`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, no-store");
  if (f.file.size != null) res.setHeader("Content-Length", String(f.file.size));
  f.file.stream.on("error", () => res.destroy());
  f.file.stream.pipe(res);
}

export const documentRouter = Router({ mergeParams: true });
documentRouter.use(requireAuth);
documentRouter.post("/", requireBusinessAccess("documents.manage"), upload.single("file"), async (req, res) => {
  if (!req.file) throw badRequest("No file uploaded (field name: file)");
  const meta = parse(z.object({
    name: text(160).min(1), category, expiryDate: date.optional(),
    visibleToEmployee: z.enum(["true", "false"]).optional().transform((v) => v === "true"),
  }), req.body);
  res.status(201).json({ document: await svc.addDocument(bid(req), eid(req), req.user!.id, req.file, meta, req.ip) });
});
documentRouter.get("/", requireBusinessAccess("documents.view"), async (req, res) => res.json({ documents: await svc.listDocuments(bid(req), eid(req)) }));
documentRouter.get("/:id/file", requireBusinessAccess("documents.view"), async (req, res) => sendPrivateFile(res, await svc.openDocument(bid(req), eid(req), rid(req), false)));
documentRouter.patch("/:id", requireBusinessAccess("documents.manage"), body(z.object({ name: text(160).min(1), category, expiryDate: date.nullable(), visibleToEmployee: z.boolean() }).partial()),
  async (req, res) => res.json({ document: await svc.updateDocument(bid(req), eid(req), rid(req), req.user!.id, req.body, req.ip) }));
documentRouter.delete("/:id", requireBusinessAccess("documents.manage"), async (req, res) => { await svc.deleteDocument(bid(req), eid(req), rid(req), req.user!.id, req.ip); res.json({ ok: true }); });

export const expiringRouter = Router({ mergeParams: true });
expiringRouter.use(requireAuth);
expiringRouter.get("/expiring", requireBusinessAccess("documents.view"), async (req, res) => {
  const q = parse(z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }), req.query);
  res.json({ documents: await svc.expiringDocuments(bid(req), q.days) });
});

// ---------- employee self-service, registered onto the existing /me router ----------
export function registerSelfHr(self: Router) {
  const emp = (req: any) => req.employee;
  self.get("/leave", async (req, res) => res.json(await svc.myLeave(emp(req).id, parse(z.object({ year: z.coerce.number().int().min(2000).max(2100).default(new Date().getUTCFullYear()) }), req.query).year)));
  self.post("/leave", body(z.object({ type: z.enum(["casual", "sick", "paid", "unpaid", "other"]), startDate: date, endDate: date, reason: text(1000).optional() })),
    async (req, res) => res.status(201).json({ leave: await svc.requestLeave(bid(req), emp(req).id, req.user!.id, req.body, req.ip) }));
  self.post("/leave/:id/cancel", async (req, res) => res.json({ leave: await svc.cancelOwn(bid(req), emp(req).id, req.user!.id, rid(req), req.ip) }));
  self.get("/performance", async (req, res) => res.json({ reviews: await svc.myReviews(emp(req).id) }));
  self.post("/performance/:id/acknowledge", async (req, res) => res.json({ review: await svc.acknowledge(emp(req).id, rid(req)) }));
  // Employees only ever see documents HR chose to share with them.
  self.get("/documents", async (req, res) => res.json({ documents: await svc.listDocuments(bid(req), emp(req).id, true) }));
  self.get("/documents/:id/file", async (req, res) => sendPrivateFile(res, await svc.openDocument(bid(req), emp(req).id, rid(req), true)));
}
