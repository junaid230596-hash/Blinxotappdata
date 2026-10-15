import { Router } from "express";
import { z } from "zod";
import { pageQuery } from "../../lib/pagination.js";
import { requireAuth, requireBusinessAccess } from "../../middleware/auth.js";
import { body, parse } from "../../middleware/validate.js";
import * as svc from "./task.service.js";

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const fields = {
  title: z.string().trim().min(1).max(200), description: z.string().trim().max(5000).nullable().optional(),
  assignedTo: uuid.nullable().optional(), priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  status: z.enum(["todo", "in_progress", "review", "completed", "cancelled"]).optional(), dueDate: date.nullable().optional(),
};

export const taskRouter = Router({ mergeParams: true });
taskRouter.use(requireAuth);
const bid = (req: any) => String(req.params.businessId);
const tid = (req: any) => parse(uuid, req.params.taskId);
const actor = (req: any): svc.Actor => ({ id: req.user.id, canManage: req.permissions.has("tasks.manage") });

taskRouter.post("/", requireBusinessAccess("tasks.manage"), body(z.object(fields).omit({ status: true })),
  async (req, res) => res.status(201).json({ task: await svc.createTask(bid(req), actor(req), req.body, req.ip) }));

taskRouter.get("/", requireBusinessAccess("tasks.view"), async (req, res) => {
  const q = parse(pageQuery.extend({
    status: fields.status, priority: fields.priority, assignedTo: uuid.optional(), q: z.string().trim().max(100).optional(),
    overdue: z.enum(["true", "false"]).optional().transform((v) => v === "true"),
  }), req.query);
  res.json(await svc.listTasks(bid(req), actor(req), q));
});

taskRouter.get("/:taskId", requireBusinessAccess("tasks.view"), async (req, res) =>
  res.json({ task: await svc.getTask(bid(req), tid(req), actor(req)) }));

taskRouter.patch("/:taskId", requireBusinessAccess("tasks.view"), body(z.object(fields).partial()),
  async (req, res) => res.json({ task: await svc.updateTask(bid(req), tid(req), actor(req), req.body, req.ip) }));

taskRouter.post("/:taskId/comments", requireBusinessAccess("tasks.view"), body(z.object({ body: z.string().trim().min(1).max(2000) })),
  async (req, res) => res.status(201).json({ task: await svc.addComment(bid(req), tid(req), actor(req), req.body.body) }));

taskRouter.post("/:taskId/attachments", requireBusinessAccess("tasks.view"),
  body(z.object({ url: z.string().regex(/^\/uploads\/[0-9a-f-]{36}\.(png|jpg|webp|pdf)$/, "Upload the file first, then attach its URL"), name: z.string().trim().min(1).max(200) })),
  async (req, res) => res.status(201).json({ task: await svc.addAttachment(bid(req), tid(req), actor(req), req.body) }));
