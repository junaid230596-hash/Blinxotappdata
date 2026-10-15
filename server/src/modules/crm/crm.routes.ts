import { Router } from "express";
import { z } from "zod";
import { pageQuery } from "../../lib/pagination.js";
import { requireAuth, requireBusinessAccess } from "../../middleware/auth.js";
import { body, parse } from "../../middleware/validate.js";
import * as svc from "./crm.service.js";

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const tags = z.array(z.string().trim().min(1).max(30)).max(10);
const str = (n: number) => z.string().trim().max(n);
const bid = (r: any) => String(r.params.businessId);
const rid = (r: any) => parse(uuid, r.params.id);
const dir = z.enum(["asc", "desc"]).optional();

export const crmRouter = Router({ mergeParams: true });
crmRouter.use(requireAuth);

crmRouter.get("/dashboard", requireBusinessAccess("crm.view"), async (req, res) => res.json(await svc.dashboard(bid(req))));

function crud(path: string, kind: svc.Kind, createSchema: z.ZodObject<any>, extraQuery: z.ZodRawShape, sorts: [string, ...string[]]) {
  const base = pageQuery.extend({ q: str(100).optional(), tag: str(30).optional(), sort: z.enum(sorts).optional(), dir, ...extraQuery });
  crmRouter.get(`/${path}`, requireBusinessAccess("crm.view"), async (req, res) => res.json(await svc.list(kind, bid(req), parse(base, req.query))));
  crmRouter.get(`/${path}/:id`, requireBusinessAccess("crm.view"), async (req, res) => res.json({ [kind.slice(0, -1)]: await svc.get(kind, bid(req), rid(req)) }));
  crmRouter.post(`/${path}`, requireBusinessAccess("crm.manage"), body(createSchema),
    async (req, res) => res.status(201).json({ [kind.slice(0, -1)]: await svc.create(kind, bid(req), req.user!.id, req.body, req.ip) }));
  crmRouter.patch(`/${path}/:id`, requireBusinessAccess("crm.manage"), body(createSchema.partial()),
    async (req, res) => res.json({ [kind.slice(0, -1)]: await svc.update(kind, bid(req), rid(req), req.user!.id, req.body, req.ip) }));
  crmRouter.delete(`/${path}/:id`, requireBusinessAccess("crm.manage"), async (req, res) => {
    await svc.remove(kind, bid(req), rid(req), req.user!.id, req.ip); res.json({ ok: true });
  });
}

crud("companies", "companies", z.object({ name: str(160).min(1), website: str(300).optional(), industry: str(100).optional(), phone: str(30).optional(), address: str(300).optional(), notes: str(2000).optional(), tags: tags.optional() }),
  {}, ["name", "created"]);
crud("contacts", "contacts", z.object({ name: str(160).min(1), email: z.string().trim().email().max(254).optional(), phone: str(30).optional(), jobTitle: str(100).optional(), notes: str(2000).optional(), companyId: uuid.nullable().optional(), tags: tags.optional() }),
  { companyId: uuid.optional() }, ["name", "created"]);
crud("leads", "leads", z.object({ name: str(160).min(1), email: z.string().trim().email().max(254).optional(), phone: str(30).optional(), companyName: str(160).optional(), source: str(80).optional(), notes: str(2000).optional(),
  status: z.enum(["new", "contacted", "qualified", "unqualified"]).optional(), ownerId: uuid.nullable().optional(), tags: tags.optional() }),
  { status: z.enum(["new", "contacted", "qualified", "unqualified", "converted"]).optional(), ownerId: uuid.optional() }, ["name", "created", "status"]);
crud("deals", "deals", z.object({ title: str(200).min(1), value: z.number().min(0).max(100_000_000_000).optional(), stageId: uuid.optional(), contactId: uuid.nullable().optional(), companyId: uuid.nullable().optional(),
  ownerId: uuid.nullable().optional(), expectedClose: date.nullable().optional(), lostReason: str(500).nullable().optional(), tags: tags.optional() }),
  { status: z.enum(["open", "won", "lost"]).optional(), stageId: uuid.optional(), ownerId: uuid.optional(), companyId: uuid.optional() }, ["title", "value", "created", "close"]);

crmRouter.post("/leads/:id/convert", requireBusinessAccess("crm.manage"), body(z.object({ dealTitle: str(200).optional(), value: z.number().min(0).max(100_000_000_000).optional() })),
  async (req, res) => res.status(201).json(await svc.convertLead(bid(req), rid(req), req.user!.id, req.body, req.ip)));

// ---- pipeline stages (configurable) ----
crmRouter.get("/stages", requireBusinessAccess("crm.view"), async (req, res) => res.json({ stages: await svc.listStages(bid(req)) }));
crmRouter.post("/stages", requireBusinessAccess("crm.manage"), body(z.object({ name: str(60).min(1), kind: z.enum(["open", "won", "lost"]).optional() })),
  async (req, res) => res.status(201).json({ stage: await svc.createStage(bid(req), req.user!.id, req.body) }));
crmRouter.put("/stages/order", requireBusinessAccess("crm.manage"), body(z.object({ ids: z.array(uuid).min(1).max(50) })),
  async (req, res) => res.json({ stages: await svc.reorderStages(bid(req), req.body.ids) }));
crmRouter.patch("/stages/:id", requireBusinessAccess("crm.manage"), body(z.object({ name: str(60).min(1), kind: z.enum(["open", "won", "lost"]) }).partial()),
  async (req, res) => res.json({ stage: await svc.updateStage(bid(req), rid(req), req.user!.id, req.body) }));
crmRouter.delete("/stages/:id", requireBusinessAccess("crm.manage"), async (req, res) => { await svc.deleteStage(bid(req), rid(req), req.user!.id); res.json({ ok: true }); });

// ---- activities: notes, calls, meetings, tasks, follow-ups ----
const actBody = z.object({
  entityType: z.enum(["lead", "contact", "company", "deal"]), entityId: uuid, type: z.enum(["note", "call", "email", "meeting", "task", "follow_up"]),
  subject: str(200).min(1), body: str(5000).optional(), dueAt: z.coerce.date().nullable().optional(), assignedTo: uuid.nullable().optional(),
});
crmRouter.get("/activities", requireBusinessAccess("crm.view"), async (req, res) => {
  const q = parse(pageQuery.extend({ entityType: z.enum(["lead", "contact", "company", "deal"]).optional(), entityId: uuid.optional(), assignedTo: uuid.optional(),
    type: z.enum(["note", "call", "email", "meeting", "task", "follow_up"]).optional(), done: z.enum(["true", "false"]).optional(), due: z.enum(["overdue", "today", "upcoming"]).optional() }), req.query);
  res.json(await svc.listActivities(bid(req), q));
});
crmRouter.post("/activities", requireBusinessAccess("crm.manage"), body(actBody),
  async (req, res) => res.status(201).json({ activity: await svc.createActivity(bid(req), req.user!.id, req.body, req.ip) }));
crmRouter.patch("/activities/:id", requireBusinessAccess("crm.manage"), body(actBody.pick({ subject: true, body: true, dueAt: true, assignedTo: true }).partial()),
  async (req, res) => res.json({ activity: await svc.updateActivity(bid(req), rid(req), req.user!.id, req.body) }));
crmRouter.post("/activities/:id/done", requireBusinessAccess("crm.manage"), async (req, res) => res.json({ activity: await svc.setDone(bid(req), rid(req), true) }));
crmRouter.post("/activities/:id/reopen", requireBusinessAccess("crm.manage"), async (req, res) => res.json({ activity: await svc.setDone(bid(req), rid(req), false) }));
crmRouter.delete("/activities/:id", requireBusinessAccess("crm.manage"), async (req, res) => { await svc.deleteActivity(bid(req), rid(req)); res.json({ ok: true }); });
