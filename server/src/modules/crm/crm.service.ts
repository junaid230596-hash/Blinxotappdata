import type { PoolClient } from "pg";
import { pool, tx } from "../../db.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { buildSets, escapeLike } from "../../lib/sql.js";
import { audit } from "../audit/audit.service.js";
import { notify } from "../notifications/notification.service.js";

export type Kind = "companies" | "contacts" | "leads" | "deals";
const iso = (d: any) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);
export const normTags = (t?: string[]) => [...new Set((t ?? []).map((x) => x.trim().toLowerCase()).filter(Boolean))].slice(0, 10);

const DEFAULT_STAGES: [string, "open" | "won" | "lost"][] = [
  ["Lead", "open"], ["Contacted", "open"], ["Qualified", "open"], ["Proposal", "open"], ["Negotiation", "open"], ["Won", "won"], ["Lost", "lost"],
];

interface Cfg {
  table: string; select: string; map: Record<string, string>; search: string[]; sorts: Record<string, string>; defaultSort: string;
  out: (r: any) => any;
}
const CFG: Record<Kind, Cfg> = {
  companies: {
    table: "crm_companies", select: "SELECT t.* FROM crm_companies t",
    map: { name: "name", website: "website", industry: "industry", phone: "phone", address: "address", notes: "notes", tags: "tags" },
    search: ["t.name", "t.industry", "t.website"], sorts: { name: "lower(t.name)", created: "t.created_at" }, defaultSort: "name",
    out: (r) => ({ id: r.id, name: r.name, website: r.website, industry: r.industry, phone: r.phone, address: r.address, notes: r.notes, tags: r.tags, createdAt: r.created_at }),
  },
  contacts: {
    table: "crm_contacts", select: "SELECT t.*, co.name AS company_name FROM crm_contacts t LEFT JOIN crm_companies co ON co.id=t.company_id",
    map: { name: "name", email: "email", phone: "phone", jobTitle: "job_title", notes: "notes", tags: "tags", companyId: "company_id" },
    search: ["t.name", "t.email", "t.phone"], sorts: { name: "lower(t.name)", created: "t.created_at" }, defaultSort: "name",
    out: (r) => ({ id: r.id, name: r.name, email: r.email, phone: r.phone, jobTitle: r.job_title, notes: r.notes, tags: r.tags, companyId: r.company_id, companyName: r.company_name, createdAt: r.created_at }),
  },
  leads: {
    table: "crm_leads", select: "SELECT t.*, u.full_name AS owner_name FROM crm_leads t LEFT JOIN users u ON u.id=t.owner_id",
    map: { name: "name", email: "email", phone: "phone", companyName: "company_name", source: "source", notes: "notes", status: "status", ownerId: "owner_id", tags: "tags" },
    search: ["t.name", "t.email", "t.company_name", "t.code"], sorts: { name: "lower(t.name)", created: "t.created_at", status: "t.status" }, defaultSort: "created",
    out: (r) => ({ id: r.id, code: r.code, name: r.name, email: r.email, phone: r.phone, companyName: r.company_name, source: r.source, notes: r.notes, status: r.status,
      ownerId: r.owner_id, ownerName: r.owner_name, tags: r.tags, convertedDealId: r.converted_deal_id, createdAt: r.created_at }),
  },
  deals: {
    table: "crm_deals",
    select: `SELECT t.*, t.expected_close::text AS expected_close_text, s.name AS stage_name, s.kind AS stage_kind, c.name AS contact_name, co.name AS company_name, u.full_name AS owner_name
               FROM crm_deals t JOIN crm_pipeline_stages s ON s.id=t.stage_id LEFT JOIN crm_contacts c ON c.id=t.contact_id
               LEFT JOIN crm_companies co ON co.id=t.company_id LEFT JOIN users u ON u.id=t.owner_id`,
    map: { title: "title", value: "value", stageId: "stage_id", contactId: "contact_id", companyId: "company_id", ownerId: "owner_id", expectedClose: "expected_close", lostReason: "lost_reason", tags: "tags" },
    search: ["t.title", "c.name", "co.name", "t.code"], sorts: { title: "lower(t.title)", value: "t.value", created: "t.created_at", close: "t.expected_close" }, defaultSort: "created",
    out: (r) => ({ id: r.id, code: r.code, title: r.title, value: Number(r.value), stageId: r.stage_id, stageName: r.stage_name, status: r.stage_kind, contactId: r.contact_id, contactName: r.contact_name,
      companyId: r.company_id, companyName: r.company_name, ownerId: r.owner_id, ownerName: r.owner_name, expectedClose: r.expected_close_text, lostReason: r.lost_reason,
      closedAt: r.closed_at, tags: r.tags, createdAt: r.created_at }),
  },
};

async function exists(c: PoolClient | typeof pool, table: string, id: string | null | undefined, businessId: string, label: string) {
  if (!id) return;
  const { rows } = await c.query(`SELECT 1 FROM ${table} WHERE id=$1 AND business_id=$2`, [id, businessId]);
  if (!rows[0]) throw badRequest(`Unknown ${label}`);
}
export async function assertMember(c: PoolClient | typeof pool, businessId: string, userId?: string | null) {
  if (!userId) return;
  const { rows } = await c.query("SELECT 1 FROM business_members WHERE business_id=$1 AND user_id=$2 AND status='active'", [businessId, userId]);
  if (!rows[0]) throw badRequest("That user is not a member of this business");
}
async function checkRefs(c: PoolClient | typeof pool, businessId: string, d: any) {
  if ("companyId" in d) await exists(c, "crm_companies", d.companyId, businessId, "company");
  if ("contactId" in d) await exists(c, "crm_contacts", d.contactId, businessId, "contact");
  if ("stageId" in d) await exists(c, "crm_pipeline_stages", d.stageId, businessId, "pipeline stage");
  if ("ownerId" in d) await assertMember(c, businessId, d.ownerId);
}

// ---------- pipeline stages ----------
export async function ensureStages(businessId: string) {
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM crm_pipeline_stages WHERE business_id=$1", [businessId]);
  if (rows[0].n > 0) return;
  for (let i = 0; i < DEFAULT_STAGES.length; i++) {
    await pool.query("INSERT INTO crm_pipeline_stages (business_id, name, position, kind) VALUES ($1,$2,$3,$4) ON CONFLICT (business_id, name) DO NOTHING",
      [businessId, DEFAULT_STAGES[i][0], i + 1, DEFAULT_STAGES[i][1]]);
  }
}
const pubStage = (r: any) => ({ id: r.id, name: r.name, position: r.position, kind: r.kind, dealCount: r.deal_count ?? 0, dealValue: Number(r.deal_value ?? 0) });

export async function listStages(businessId: string) {
  await ensureStages(businessId);
  const { rows } = await pool.query(
    `SELECT s.*, count(d.id)::int AS deal_count, COALESCE(sum(d.value),0) AS deal_value FROM crm_pipeline_stages s
       LEFT JOIN crm_deals d ON d.stage_id=s.id WHERE s.business_id=$1 GROUP BY s.id ORDER BY s.position`, [businessId]);
  return rows.map(pubStage);
}

export async function createStage(businessId: string, actorId: string, i: { name: string; kind?: "open" | "won" | "lost" }) {
  await ensureStages(businessId);
  const kind = i.kind ?? "open";
  return tx(async (c) => {
    // New open stages slot in before the first won/lost stage; others go to the end.
    const { rows } = await c.query(
      `SELECT COALESCE((SELECT min(position) FROM crm_pipeline_stages WHERE business_id=$1 AND kind<>'open'), 0) AS term,
              COALESCE((SELECT max(position) FROM crm_pipeline_stages WHERE business_id=$1), 0) AS mx`, [businessId]);
    const pos = kind === "open" && rows[0].term > 0 ? rows[0].term : rows[0].mx + 1;
    await c.query("UPDATE crm_pipeline_stages SET position = position + 1 WHERE business_id=$1 AND position >= $2", [businessId, pos]);
    try {
      const r = await c.query("INSERT INTO crm_pipeline_stages (business_id, name, position, kind) VALUES ($1,$2,$3,$4) RETURNING *", [businessId, i.name, pos, kind]);
      await audit({ actorId, businessId, action: "crm.stage.create", entity: "crm_stage", entityId: r.rows[0].id }, c);
      return pubStage(r.rows[0]);
    } catch (e: any) { if (e.code === "23505") throw conflict("A stage with this name already exists"); throw e; }
  });
}

export async function updateStage(businessId: string, id: string, actorId: string, patch: { name?: string; kind?: "open" | "won" | "lost" }) {
  return tx(async (c) => {
    const { rows } = await c.query("SELECT * FROM crm_pipeline_stages WHERE id=$1 AND business_id=$2 FOR UPDATE", [id, businessId]);
    if (!rows[0]) throw notFound();
    if (patch.kind && patch.kind !== "open" && rows[0].kind === "open") {
      const { rows: o } = await c.query("SELECT count(*)::int AS n FROM crm_pipeline_stages WHERE business_id=$1 AND kind='open' AND id<>$2", [businessId, id]);
      if (o[0].n === 0) throw conflict("The pipeline needs at least one open stage");
    }
    const { sets, vals } = buildSets({ name: "name", kind: "kind" }, patch);
    if (!sets.length) throw badRequest("Nothing to update");
    vals.push(id);
    try {
      const r = await c.query(`UPDATE crm_pipeline_stages SET ${sets.join(", ")} WHERE id=$${vals.length} RETURNING *`, vals);
      await audit({ actorId, businessId, action: "crm.stage.update", entity: "crm_stage", entityId: id }, c);
      return pubStage(r.rows[0]);
    } catch (e: any) { if (e.code === "23505") throw conflict("A stage with this name already exists"); throw e; }
  });
}

export async function reorderStages(businessId: string, ids: string[]) {
  await tx(async (c) => {
    const { rows } = await c.query("SELECT id FROM crm_pipeline_stages WHERE business_id=$1 FOR UPDATE", [businessId]);
    const have = new Set(rows.map((r) => r.id));
    if (ids.length !== have.size || new Set(ids).size !== ids.length || !ids.every((x) => have.has(x))) throw badRequest("Provide every stage id exactly once");
    for (let i = 0; i < ids.length; i++) await c.query("UPDATE crm_pipeline_stages SET position=$2 WHERE id=$1", [ids[i], i + 1]);
  });
  return listStages(businessId);
}

export async function deleteStage(businessId: string, id: string, actorId: string) {
  await tx(async (c) => {
    const { rows } = await c.query("SELECT * FROM crm_pipeline_stages WHERE id=$1 AND business_id=$2 FOR UPDATE", [id, businessId]);
    if (!rows[0]) throw notFound();
    const { rows: d } = await c.query("SELECT 1 FROM crm_deals WHERE stage_id=$1 LIMIT 1", [id]);
    if (d[0]) throw conflict("Move this stage's deals elsewhere before deleting it");
    if (rows[0].kind === "open") {
      const { rows: o } = await c.query("SELECT count(*)::int AS n FROM crm_pipeline_stages WHERE business_id=$1 AND kind='open' AND id<>$2", [businessId, id]);
      if (o[0].n === 0) throw conflict("The pipeline needs at least one open stage");
    }
    await c.query("DELETE FROM crm_pipeline_stages WHERE id=$1", [id]);
    await audit({ actorId, businessId, action: "crm.stage.delete", entity: "crm_stage", entityId: id }, c);
  });
}

// ---------- generic entity CRUD ----------
export async function list(kind: Kind, businessId: string, f: any) {
  const cfg = CFG[kind];
  if (kind === "deals") await ensureStages(businessId);
  const where = ["t.business_id=$1"]; const v: any[] = [businessId];
  if (f.q) { v.push(`%${escapeLike(f.q)}%`); where.push(`(${cfg.search.map((s) => `${s} ILIKE $${v.length}`).join(" OR ")})`); }
  if (f.tag) { v.push(String(f.tag).toLowerCase()); where.push(`$${v.length} = ANY(t.tags)`); }
  if (f.ownerId) { v.push(f.ownerId); where.push(`t.owner_id=$${v.length}`); }
  if (f.companyId) { v.push(f.companyId); where.push(`t.company_id=$${v.length}`); }
  if (f.stageId) { v.push(f.stageId); where.push(`t.stage_id=$${v.length}`); }
  if (f.status) { v.push(f.status); where.push(kind === "deals" ? `s.kind=$${v.length}` : `t.status=$${v.length}`); }
  const w = where.join(" AND ");
  const { rows: t } = await pool.query(`SELECT count(*)::int AS n FROM (${cfg.select} WHERE ${w}) x`, v);
  v.push(f.limit, f.offset);
  const sortKey = f.sort ?? cfg.defaultSort;
  const direction = f.dir ? f.dir.toUpperCase() : sortKey === "created" ? "DESC" : "ASC";   // newest first by default
  const order = `${cfg.sorts[sortKey]} ${direction} NULLS LAST`;
  const { rows } = await pool.query(`${cfg.select} WHERE ${w} ORDER BY ${order}, t.id LIMIT $${v.length - 1} OFFSET $${v.length}`, v);
  return { [kind]: rows.map(cfg.out), total: t[0].n };
}

export async function get(kind: Kind, businessId: string, id: string) {
  const { rows } = await pool.query(`${CFG[kind].select} WHERE t.id=$1 AND t.business_id=$2`, [id, businessId]);
  if (!rows[0]) throw notFound();
  return CFG[kind].out(rows[0]);
}

export async function create(kind: Kind, businessId: string, actorId: string, input: any, ip?: string) {
  const cfg = CFG[kind];
  const d = { ...input }; if (d.tags) d.tags = normTags(d.tags);
  if (kind === "deals") {
    await ensureStages(businessId);
    if (!d.stageId) {
      const { rows } = await pool.query("SELECT id FROM crm_pipeline_stages WHERE business_id=$1 AND kind='open' ORDER BY position LIMIT 1", [businessId]);
      d.stageId = rows[0].id;
    }
  }
  await checkRefs(pool, businessId, d);
  const cols = ["business_id", "created_by"]; const vals: any[] = [businessId, actorId];
  for (const [k, col] of Object.entries(cfg.map)) if (k in d && d[k] !== undefined) { cols.push(col); vals.push(d[k] === "" ? null : d[k]); }
  const id = await tx(async (c) => {
    const r = await c.query(`INSERT INTO ${cfg.table} (${cols.join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")}) RETURNING id`, vals);
    if (kind === "deals") {
      const { rows } = await c.query("SELECT kind FROM crm_pipeline_stages WHERE id=$1", [d.stageId]);
      if (rows[0].kind !== "open") await c.query("UPDATE crm_deals SET closed_at=now() WHERE id=$1", [r.rows[0].id]);
    }
    await audit({ actorId, businessId, action: `crm.${kind}.create`, entity: `crm_${kind}`, entityId: r.rows[0].id, ip }, c);
    return r.rows[0].id as string;
  });
  if (d.ownerId && d.ownerId !== actorId) await notify(d.ownerId, { type: "crm.assigned", title: `You were assigned a ${kind === "leads" ? "lead" : "deal"}`, body: d.name ?? d.title, data: { businessId, id } });
  return get(kind, businessId, id);
}

export async function update(kind: Kind, businessId: string, id: string, actorId: string, patch: any, ip?: string) {
  const cfg = CFG[kind];
  const d = { ...patch }; if (d.tags) d.tags = normTags(d.tags);
  if (kind === "leads" && d.status === "converted") throw badRequest("Use the convert action to convert a lead");
  await checkRefs(pool, businessId, d);
  const { sets, vals } = buildSets(cfg.map, d);
  if (!sets.length) throw badRequest("Nothing to update");
  let prev: any;
  await tx(async (c) => {
    const { rows } = await c.query(`SELECT * FROM ${cfg.table} WHERE id=$1 AND business_id=$2 FOR UPDATE`, [id, businessId]);
    if (!rows[0]) throw notFound();
    prev = rows[0];
    if (kind === "leads" && prev.status === "converted" && "status" in d) throw conflict("This lead has already been converted");
    const extra: [string, string][] = [];   // [column, assignment]
    if (kind === "deals" && d.stageId && d.stageId !== prev.stage_id) {
      const { rows: s } = await c.query("SELECT kind FROM crm_pipeline_stages WHERE id=$1", [d.stageId]);
      if (s[0].kind === "open") extra.push(["closed_at", "closed_at=NULL"], ["lost_reason", "lost_reason=NULL"]);
      else {
        extra.push(["closed_at", "closed_at=now()"]);
        if (s[0].kind !== "lost") extra.push(["lost_reason", "lost_reason=NULL"]);
      }
    }
    const assigned = new Set(sets.map((x) => x.split("=")[0]));
    const all = [...sets, ...extra.filter(([col]) => !assigned.has(col)).map(([, sql]) => sql)];
    vals.push(id);
    await c.query(`UPDATE ${cfg.table} SET ${all.join(", ")}, updated_at=now() WHERE id=$${vals.length}`, vals);
    await audit({ actorId, businessId, action: `crm.${kind}.update`, entity: `crm_${kind}`, entityId: id,
      metadata: { fields: Object.keys(patch), ...(d.stageId && d.stageId !== prev.stage_id ? { stageFrom: prev.stage_id, stageTo: d.stageId } : {}) }, ip }, c);
  });
  if (d.ownerId && d.ownerId !== prev.owner_id && d.ownerId !== actorId) {
    await notify(d.ownerId, { type: "crm.assigned", title: `You were assigned a ${kind === "leads" ? "lead" : "deal"}`, body: prev.name ?? prev.title, data: { businessId, id } });
  }
  return get(kind, businessId, id);
}

export async function remove(kind: Kind, businessId: string, id: string, actorId: string, ip?: string) {
  await tx(async (c) => {
    const r = await c.query(`DELETE FROM ${CFG[kind].table} WHERE id=$1 AND business_id=$2`, [id, businessId]);
    if (!r.rowCount) throw notFound();
    // Activities attach polymorphically (no FK), so clean them up explicitly.
    await c.query("DELETE FROM crm_activities WHERE business_id=$1 AND entity_id=$2", [businessId, id]);
    await audit({ actorId, businessId, action: `crm.${kind}.delete`, entity: `crm_${kind}`, entityId: id, ip }, c);
  });
}

export async function convertLead(businessId: string, id: string, actorId: string, i: { dealTitle?: string; value?: number }, ip?: string) {
  const dealId = await tx(async (c) => {
    const { rows } = await c.query("SELECT * FROM crm_leads WHERE id=$1 AND business_id=$2 FOR UPDATE", [id, businessId]);
    const lead = rows[0];
    if (!lead) throw notFound();
    if (lead.status === "converted") throw conflict("This lead has already been converted");
    await ensureStages(businessId);
    let companyId: string | null = null;
    if (lead.company_name) {
      const { rows: ex } = await c.query("SELECT id FROM crm_companies WHERE business_id=$1 AND lower(name)=lower($2) LIMIT 1", [businessId, lead.company_name]);
      companyId = ex[0]?.id ?? (await c.query("INSERT INTO crm_companies (business_id, name, created_by) VALUES ($1,$2,$3) RETURNING id", [businessId, lead.company_name, actorId])).rows[0].id;
    }
    const contact = await c.query("INSERT INTO crm_contacts (business_id, company_id, name, email, phone, tags, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
      [businessId, companyId, lead.name, lead.email, lead.phone, lead.tags, actorId]);
    const { rows: st } = await c.query("SELECT id FROM crm_pipeline_stages WHERE business_id=$1 AND kind='open' ORDER BY position LIMIT 1", [businessId]);
    const deal = await c.query("INSERT INTO crm_deals (business_id, title, value, stage_id, contact_id, company_id, owner_id, tags, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id",
      [businessId, i.dealTitle ?? `${lead.company_name ?? lead.name} deal`, i.value ?? 0, st[0].id, contact.rows[0].id, companyId, lead.owner_id, lead.tags, actorId]);
    await c.query("UPDATE crm_leads SET status='converted', converted_deal_id=$2, updated_at=now() WHERE id=$1", [id, deal.rows[0].id]);
    // Carry the lead's open activities over to the new deal so follow-ups are not lost.
    await c.query("UPDATE crm_activities SET entity_type='deal', entity_id=$3 WHERE business_id=$1 AND entity_type='lead' AND entity_id=$2", [businessId, id, deal.rows[0].id]);
    await audit({ actorId, businessId, action: "crm.lead.convert", entity: "crm_leads", entityId: id, metadata: { dealId: deal.rows[0].id }, ip }, c);
    return deal.rows[0].id as string;
  });
  return { lead: await get("leads", businessId, id), deal: await get("deals", businessId, dealId) };
}

// ---------- activities (notes, calls, meetings, tasks, follow-ups) ----------
const ENTITY_TABLE: Record<string, string> = { lead: "crm_leads", contact: "crm_contacts", company: "crm_companies", deal: "crm_deals" };
const pubAct = (r: any) => ({
  id: r.id, entityType: r.entity_type, entityId: r.entity_id, type: r.type, subject: r.subject, body: r.body, dueAt: r.due_at, doneAt: r.done_at,
  assignedTo: r.assigned_to, assigneeName: r.assignee_name, createdByName: r.creator_name, createdAt: r.created_at, entityName: r.entity_name ?? null,
});
const ASEL = `SELECT a.*, u.full_name AS assignee_name, cu.full_name AS creator_name,
                     CASE a.entity_type WHEN 'lead' THEN (SELECT name FROM crm_leads WHERE id=a.entity_id) WHEN 'contact' THEN (SELECT name FROM crm_contacts WHERE id=a.entity_id)
                       WHEN 'company' THEN (SELECT name FROM crm_companies WHERE id=a.entity_id) WHEN 'deal' THEN (SELECT title FROM crm_deals WHERE id=a.entity_id) END AS entity_name
                FROM crm_activities a
                LEFT JOIN users u ON u.id=a.assigned_to LEFT JOIN users cu ON cu.id=a.created_by`;

export async function createActivity(businessId: string, actorId: string, i: any, ip?: string) {
  if (i.type === "follow_up" && !i.dueAt) throw badRequest("A follow-up needs a due date");
  await exists(pool, ENTITY_TABLE[i.entityType], i.entityId, businessId, i.entityType);
  await assertMember(pool, businessId, i.assignedTo);
  const { rows } = await pool.query(
    `INSERT INTO crm_activities (business_id, entity_type, entity_id, type, subject, body, due_at, assigned_to, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [businessId, i.entityType, i.entityId, i.type, i.subject, i.body ?? null, i.dueAt ?? null, i.assignedTo ?? (i.dueAt ? actorId : null), actorId]);
  await audit({ actorId, businessId, action: "crm.activity.create", entity: "crm_activity", entityId: rows[0].id, ip });
  if (i.assignedTo && i.assignedTo !== actorId) await notify(i.assignedTo, { type: "crm.task_assigned", title: "New CRM task for you", body: i.subject, data: { businessId, activityId: rows[0].id } });
  return getActivity(businessId, rows[0].id);
}
export async function getActivity(businessId: string, id: string) {
  const { rows } = await pool.query(`${ASEL} WHERE a.id=$1 AND a.business_id=$2`, [id, businessId]);
  if (!rows[0]) throw notFound();
  return pubAct(rows[0]);
}
export async function listActivities(businessId: string, f: any) {
  const where = ["a.business_id=$1"]; const v: any[] = [businessId];
  if (f.entityType) { v.push(f.entityType); where.push(`a.entity_type=$${v.length}`); }
  if (f.entityId) { v.push(f.entityId); where.push(`a.entity_id=$${v.length}`); }
  if (f.assignedTo) { v.push(f.assignedTo); where.push(`a.assigned_to=$${v.length}`); }
  if (f.type) { v.push(f.type); where.push(`a.type=$${v.length}`); }
  if (f.done === "true") where.push("a.done_at IS NOT NULL"); if (f.done === "false") where.push("a.done_at IS NULL");
  if (f.due === "overdue") where.push("a.due_at < now() AND a.done_at IS NULL");
  if (f.due === "today") where.push("a.due_at >= date_trunc('day', now()) AND a.due_at < date_trunc('day', now()) + interval '1 day' AND a.done_at IS NULL");
  if (f.due === "upcoming") where.push("a.due_at >= now() AND a.done_at IS NULL");
  const w = where.join(" AND ");
  const { rows: t } = await pool.query(`SELECT count(*)::int AS n FROM crm_activities a WHERE ${w}`, v);
  v.push(f.limit, f.offset);
  const { rows } = await pool.query(`${ASEL} WHERE ${w} ORDER BY (a.done_at IS NOT NULL), a.due_at NULLS LAST, a.created_at DESC LIMIT $${v.length - 1} OFFSET $${v.length}`, v);
  return { activities: rows.map(pubAct), total: t[0].n };
}
export async function updateActivity(businessId: string, id: string, actorId: string, patch: any) {
  if ("assignedTo" in patch) await assertMember(pool, businessId, patch.assignedTo);
  const { sets, vals } = buildSets({ subject: "subject", body: "body", dueAt: "due_at", assignedTo: "assigned_to" }, patch);
  if (!sets.length) throw badRequest("Nothing to update");
  if ("dueAt" in patch) sets.push("reminder_sent_at=NULL");   // a new due date earns a fresh reminder
  vals.push(id, businessId);
  const r = await pool.query(`UPDATE crm_activities SET ${sets.join(", ")} WHERE id=$${vals.length - 1} AND business_id=$${vals.length}`, vals);
  if (!r.rowCount) throw notFound();
  return getActivity(businessId, id);
}
export async function setDone(businessId: string, id: string, done: boolean) {
  const r = await pool.query("UPDATE crm_activities SET done_at = CASE WHEN $3 THEN COALESCE(done_at, now()) ELSE NULL END WHERE id=$1 AND business_id=$2", [id, businessId, done]);
  if (!r.rowCount) throw notFound();
  return getActivity(businessId, id);
}
export async function deleteActivity(businessId: string, id: string) {
  const r = await pool.query("DELETE FROM crm_activities WHERE id=$1 AND business_id=$2", [id, businessId]);
  if (!r.rowCount) throw notFound();
}

// Claims due activities atomically (so overlapping runs cannot double-notify) and notifies their assignees.
export async function sendDueReminders(now: Date = new Date()) {
  const { rows } = await pool.query(
    `UPDATE crm_activities SET reminder_sent_at=$1
      WHERE due_at <= $1 AND done_at IS NULL AND reminder_sent_at IS NULL AND assigned_to IS NOT NULL
      RETURNING id, business_id, assigned_to, subject, type, due_at`, [now]);
  for (const r of rows) {
    await notify(r.assigned_to, { type: "crm.reminder", title: `Reminder: ${r.subject}`, body: `Due ${new Date(r.due_at).toISOString()}`, data: { businessId: r.business_id, activityId: r.id } });
  }
  return rows.length;
}

export async function dashboard(businessId: string) {
  await ensureStages(businessId);
  const [leads, stages, deals, acts, recent] = await Promise.all([
    pool.query("SELECT status, count(*)::int AS n FROM crm_leads WHERE business_id=$1 GROUP BY status", [businessId]),
    listStages(businessId),
    pool.query(
      `SELECT s.kind, count(*)::int AS n, COALESCE(sum(d.value),0) AS v,
              count(*) FILTER (WHERE d.closed_at >= now() - interval '30 days')::int AS n30,
              COALESCE(sum(d.value) FILTER (WHERE d.closed_at >= now() - interval '30 days'),0) AS v30
         FROM crm_deals d JOIN crm_pipeline_stages s ON s.id=d.stage_id WHERE d.business_id=$1 GROUP BY s.kind`, [businessId]),
    pool.query(`SELECT count(*) FILTER (WHERE due_at < now() AND done_at IS NULL)::int AS overdue,
                       count(*) FILTER (WHERE due_at >= date_trunc('day', now()) AND due_at < date_trunc('day', now()) + interval '1 day' AND done_at IS NULL)::int AS today
                  FROM crm_activities WHERE business_id=$1`, [businessId]),
    pool.query(`${ASEL} WHERE a.business_id=$1 ORDER BY a.created_at DESC LIMIT 10`, [businessId]),
  ]);
  const byKind = Object.fromEntries(deals.rows.map((r) => [r.kind, r]));
  const won = byKind.won?.n ?? 0, lost = byKind.lost?.n ?? 0;
  return {
    leadsByStatus: Object.fromEntries(leads.rows.map((r) => [r.status, r.n])),
    pipeline: stages.map((s) => ({ stageId: s.id, name: s.name, kind: s.kind, deals: s.dealCount, value: s.dealValue })),
    openDeals: byKind.open?.n ?? 0, openPipelineValue: Number(byKind.open?.v ?? 0),
    wonDeals: won, wonValue: Number(byKind.won?.v ?? 0), lostDeals: lost,
    wonLast30Days: { deals: byKind.won?.n30 ?? 0, value: Number(byKind.won?.v30 ?? 0) },
    winRate: won + lost ? Math.round((won / (won + lost)) * 1000) / 10 : null,
    activities: { overdue: acts.rows[0].overdue, dueToday: acts.rows[0].today },
    recentActivity: recent.rows.map(pubAct),
  };
}
void iso;
