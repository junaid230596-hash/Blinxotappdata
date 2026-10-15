import { pool, tx } from "../../db.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { audit } from "../audit/audit.service.js";
import { notify } from "../notifications/notification.service.js";

export interface Actor { id: string; canManage: boolean }

const pub = (t: any) => ({
  id: t.id, code: t.code, title: t.title, description: t.description, assignedTo: t.assigned_to, assigneeName: t.assignee_name,
  createdBy: t.created_by, priority: t.priority, status: t.status, dueDate: t.due_date_text ?? t.due_date,
  completedAt: t.completed_at, createdAt: t.created_at, updatedAt: t.updated_at,
});
const SEL = `SELECT t.*, t.due_date::text AS due_date_text, a.full_name AS assignee_name
               FROM tasks t LEFT JOIN users a ON a.id=t.assigned_to`;
const ASSIGNEE_ALLOWED = ["todo", "in_progress", "review"];

async function assertMember(businessId: string, userId: string) {
  const { rows } = await pool.query("SELECT 1 FROM business_members WHERE business_id=$1 AND user_id=$2 AND status='active'", [businessId, userId]);
  if (!rows[0]) throw badRequest("Assignee must be an active member of this business");
}

const log = (c: any, taskId: string, actorId: string, action: string, metadata: object = {}) =>
  c.query("INSERT INTO task_activity (task_id, actor_id, action, metadata) VALUES ($1,$2,$3,$4)", [taskId, actorId, action, metadata]);

export async function createTask(businessId: string, actor: Actor, input: any, ip?: string) {
  if (input.assignedTo) await assertMember(businessId, input.assignedTo);
  const id = await tx(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO tasks (business_id, title, description, assigned_to, created_by, priority, due_date) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [businessId, input.title, input.description ?? null, input.assignedTo ?? null, actor.id, input.priority ?? "medium", input.dueDate ?? null]);
    await log(c, rows[0].id, actor.id, "created", { assignedTo: input.assignedTo ?? null });
    await audit({ actorId: actor.id, businessId, action: "task.create", entity: "task", entityId: rows[0].id, ip }, c);
    return rows[0].id as string;
  });
  if (input.assignedTo && input.assignedTo !== actor.id) {
    await notify(input.assignedTo, { type: "task.assigned", title: "New task assigned", body: input.title, data: { taskId: id, businessId } });
  }
  return getTask(businessId, id, actor);
}

export async function listTasks(businessId: string, actor: Actor, f: any) {
  const where = ["t.business_id=$1"]; const v: any[] = [businessId];
  // Non-managers can only ever see tasks assigned to them.
  if (!actor.canManage) { v.push(actor.id); where.push(`t.assigned_to=$${v.length}`); }
  else if (f.assignedTo) { v.push(f.assignedTo); where.push(`t.assigned_to=$${v.length}`); }
  if (f.status) { v.push(f.status); where.push(`t.status=$${v.length}`); }
  if (f.priority) { v.push(f.priority); where.push(`t.priority=$${v.length}`); }
  if (f.q) { v.push(`%${f.q}%`); where.push(`(t.title ILIKE $${v.length} OR t.code ILIKE $${v.length})`); }
  if (f.overdue) where.push("t.due_date < CURRENT_DATE AND t.status NOT IN ('completed','cancelled')");
  const w = where.join(" AND ");
  const { rows: t } = await pool.query(`SELECT count(*)::int AS n FROM tasks t WHERE ${w}`, v);
  v.push(f.limit, f.offset);
  const { rows } = await pool.query(`${SEL} WHERE ${w} ORDER BY t.due_date NULLS LAST, t.created_at DESC LIMIT $${v.length - 1} OFFSET $${v.length}`, v);
  return { tasks: rows.map(pub), total: t[0].n };
}

async function loadVisible(businessId: string, taskId: string, actor: Actor, db: any = pool) {
  const { rows } = await db.query(`${SEL} WHERE t.id=$1 AND t.business_id=$2`, [taskId, businessId]);
  const t = rows[0];
  if (!t || (!actor.canManage && t.assigned_to !== actor.id)) throw notFound();
  return t;
}

export async function getTask(businessId: string, taskId: string, actor: Actor) {
  const t = await loadVisible(businessId, taskId, actor);
  const [c, a, h] = await Promise.all([
    pool.query(`SELECT c.id, c.body, c.created_at, u.full_name, c.user_id FROM task_comments c JOIN users u ON u.id=c.user_id WHERE c.task_id=$1 ORDER BY c.created_at`, [taskId]),
    pool.query("SELECT id, url, name, uploaded_by, created_at FROM task_attachments WHERE task_id=$1 ORDER BY created_at", [taskId]),
    pool.query(`SELECT h.id, h.action, h.metadata, h.created_at, u.full_name AS actor FROM task_activity h LEFT JOIN users u ON u.id=h.actor_id WHERE h.task_id=$1 ORDER BY h.id`, [taskId]),
  ]);
  return {
    ...pub(t),
    comments: c.rows.map((r) => ({ id: r.id, body: r.body, userId: r.user_id, authorName: r.full_name, createdAt: r.created_at })),
    attachments: a.rows.map((r) => ({ id: r.id, url: r.url, name: r.name, uploadedBy: r.uploaded_by, createdAt: r.created_at })),
    activity: h.rows.map((r) => ({ id: r.id, action: r.action, metadata: r.metadata, actorName: r.actor, createdAt: r.created_at })),
  };
}

export async function updateTask(businessId: string, taskId: string, actor: Actor, patch: any, ip?: string) {
  const keys = Object.keys(patch);
  if (!keys.length) throw badRequest("Nothing to update");
  const notifyQueue: (() => Promise<void>)[] = [];
  await tx(async (c) => {
    const { rows } = await c.query("SELECT * FROM tasks WHERE id=$1 AND business_id=$2 FOR UPDATE", [taskId, businessId]);
    const cur = rows[0];
    if (!cur || (!actor.canManage && cur.assigned_to !== actor.id)) throw notFound();
    if (!actor.canManage) {
      if (keys.some((k) => k !== "status")) throw forbidden("You can only update the status of tasks assigned to you");
      if (!ASSIGNEE_ALLOWED.includes(patch.status)) throw forbidden("Only a manager can complete or cancel a task");
    }
    if (patch.assignedTo) await assertMember(businessId, patch.assignedTo);
    const map: Record<string, string> = { title: "title", description: "description", assignedTo: "assigned_to", priority: "priority", status: "status", dueDate: "due_date" };
    const sets: string[] = []; const vals: any[] = [];
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const [k, col] of Object.entries(map)) {
      if (!(k in patch)) continue;
      const old = cur[col];
      if (String(old ?? "") === String(patch[k] ?? "") ) continue;
      vals.push(patch[k] ?? null); sets.push(`${col}=$${vals.length}`);
      changes[k] = { from: old, to: patch[k] ?? null };
    }
    if (!sets.length) return;
    if (changes.status) sets.push(patch.status === "completed" ? "completed_at=now()" : "completed_at=NULL");
    vals.push(taskId);
    await c.query(`UPDATE tasks SET ${sets.join(", ")}, updated_at=now() WHERE id=$${vals.length}`, vals);
    for (const [k, ch] of Object.entries(changes)) await log(c, taskId, actor.id, `${k}_changed`, ch);
    await audit({ actorId: actor.id, businessId, action: "task.update", entity: "task", entityId: taskId, metadata: { fields: Object.keys(changes) }, ip }, c);
    const title = patch.title ?? cur.title;
    if (changes.assignedTo && patch.assignedTo && patch.assignedTo !== actor.id)
      notifyQueue.push(() => notify(patch.assignedTo, { type: "task.assigned", title: "Task assigned to you", body: title, data: { taskId, businessId } }));
    if (changes.status && patch.status === "review" && cur.created_by !== actor.id)
      notifyQueue.push(() => notify(cur.created_by, { type: "task.review", title: "Task ready for review", body: title, data: { taskId, businessId } }));
    if (changes.status && ["completed", "cancelled"].includes(patch.status) && cur.assigned_to && cur.assigned_to !== actor.id)
      notifyQueue.push(() => notify(cur.assigned_to, { type: "task.status", title: `Task ${patch.status}`, body: title, data: { taskId, businessId } }));
  });
  for (const n of notifyQueue) await n();
  return getTask(businessId, taskId, actor);
}

export async function addComment(businessId: string, taskId: string, actor: Actor, text: string) {
  const t = await loadVisible(businessId, taskId, actor);
  await tx(async (c) => {
    await c.query("INSERT INTO task_comments (task_id, user_id, body) VALUES ($1,$2,$3)", [taskId, actor.id, text]);
    await log(c, taskId, actor.id, "commented");
  });
  const others = new Set([t.assigned_to, t.created_by].filter((u) => u && u !== actor.id));
  for (const u of others) await notify(u as string, { type: "task.comment", title: "New comment on a task", body: t.title, data: { taskId, businessId } });
  return getTask(businessId, taskId, actor);
}

export async function addAttachment(businessId: string, taskId: string, actor: Actor, a: { url: string; name: string }) {
  await loadVisible(businessId, taskId, actor);
  await tx(async (c) => {
    await c.query("INSERT INTO task_attachments (task_id, url, name, uploaded_by) VALUES ($1,$2,$3,$4)", [taskId, a.url, a.name, actor.id]);
    await log(c, taskId, actor.id, "attachment_added", { name: a.name });
  });
  return getTask(businessId, taskId, actor);
}
