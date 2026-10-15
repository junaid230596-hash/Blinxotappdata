import { pool, tx } from "../../db.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { experienceMonths } from "../../lib/experience.js";
import { cleanSkills } from "../../lib/skills.js";
import { buildSets, escapeLike } from "../../lib/sql.js";
import { audit } from "../audit/audit.service.js";
import { notify, notifyMembersWith } from "../notifications/notification.service.js";
import { resume } from "../profiles/profile.service.js";


const pubJob = (r: any) => ({
  id: r.id, code: r.code, businessId: r.business_id, title: r.title, description: r.description, requirements: r.requirements, skills: r.skills,
  payMin: r.pay_min == null ? null : Number(r.pay_min), payMax: r.pay_max == null ? null : Number(r.pay_max), payPeriod: r.pay_period, currency: r.currency,
  location: r.location, isRemote: r.is_remote, workType: r.work_type, deadline: r.deadline_text ?? null, status: r.status, publishedAt: r.published_at, createdAt: r.created_at,
  ...(r.applicant_count !== undefined ? { applicantCount: r.applicant_count } : {}),
  ...(r.business_name ? { business: { id: r.business_id, name: r.business_name, slug: r.business_slug, logoUrl: r.logo_url } } : {}),
  ...(r.applied !== undefined ? { applied: r.applied } : {}),
});
const BSEL = `SELECT j.*, j.deadline::text AS deadline_text, (SELECT count(*)::int FROM applications a WHERE a.job_id=j.id) AS applicant_count FROM jobs j`;
const PSEL = `SELECT j.*, j.deadline::text AS deadline_text, b.name AS business_name, b.slug AS business_slug, b.logo_url FROM jobs j
                JOIN businesses b ON b.id=j.business_id AND b.is_public AND b.status='active'
               WHERE j.status='open' AND (j.deadline IS NULL OR j.deadline >= CURRENT_DATE)`;

function checkPay(i: any, cur?: any) {
  const min = i.payMin !== undefined ? i.payMin : cur?.pay_min == null ? null : Number(cur.pay_min);
  const max = i.payMax !== undefined ? i.payMax : cur?.pay_max == null ? null : Number(cur.pay_max);
  if (min != null && max != null && max < min) throw badRequest("Maximum pay cannot be lower than minimum pay");
}
const today = () => new Date().toISOString().slice(0, 10);
const COLS = { title: "title", description: "description", requirements: "requirements", skills: "skills", payMin: "pay_min", payMax: "pay_max", payPeriod: "pay_period",
  currency: "currency", location: "location", isRemote: "is_remote", workType: "work_type", deadline: "deadline" };

export async function createJob(businessId: string, actorId: string, i: any, ip?: string) {
  checkPay(i);
  if (i.deadline && i.deadline < today()) throw badRequest("The deadline cannot be in the past");
  const cols = ["business_id", "created_by"]; const vals: any[] = [businessId, actorId];
  const d = { ...i, skills: cleanSkills(i.skills) };
  for (const [k, col] of Object.entries(COLS)) if (d[k] !== undefined) { cols.push(col); vals.push(d[k]); }
  const { rows } = await pool.query(`INSERT INTO jobs (${cols.join(",")}) VALUES (${cols.map((_, n) => `$${n + 1}`).join(",")}) RETURNING id`, vals);
  await audit({ actorId, businessId, action: "job.create", entity: "job", entityId: rows[0].id, ip });
  return getJob(businessId, rows[0].id);
}

export async function listJobs(businessId: string, f: { status?: string; q?: string; limit: number; offset: number }) {
  const where = ["j.business_id=$1"]; const v: any[] = [businessId];
  if (f.status) { v.push(f.status); where.push(`j.status=$${v.length}`); }
  if (f.q) { v.push(`%${escapeLike(f.q)}%`); where.push(`(j.title ILIKE $${v.length} OR j.code ILIKE $${v.length})`); }
  const w = where.join(" AND ");
  const { rows: t } = await pool.query(`SELECT count(*)::int AS n FROM jobs j WHERE ${w}`, v);
  v.push(f.limit, f.offset);
  const { rows } = await pool.query(`${BSEL} WHERE ${w} ORDER BY j.created_at DESC, j.id LIMIT $${v.length - 1} OFFSET $${v.length}`, v);
  return { jobs: rows.map(pubJob), total: t[0].n };
}

export async function getJob(businessId: string, id: string) {
  const { rows } = await pool.query(`${BSEL} WHERE j.id=$1 AND j.business_id=$2`, [id, businessId]);
  if (!rows[0]) throw notFound();
  return pubJob(rows[0]);
}

export async function updateJob(businessId: string, id: string, actorId: string, patch: any, ip?: string) {
  const { status, ...rest } = patch;
  await tx(async (c) => {
    const { rows } = await c.query("SELECT * FROM jobs WHERE id=$1 AND business_id=$2 FOR UPDATE", [id, businessId]);
    const cur = rows[0];
    if (!cur) throw notFound();
    checkPay(rest, cur);
    if (rest.deadline && rest.deadline < today()) throw badRequest("The deadline cannot be in the past");
    const d = { ...rest }; if (d.skills) d.skills = cleanSkills(d.skills);
    const { sets, vals } = buildSets(COLS, d);
    if (status && status !== cur.status) {
      const ok = (cur.status === "draft" && status === "open") || (cur.status === "open" && status === "closed") || (cur.status === "closed" && status === "open");
      if (!ok) throw conflict(`A ${cur.status} job cannot become ${status}`);
      const deadline = "deadline" in d ? d.deadline : cur.deadline && cur.deadline.toISOString().slice(0, 10);
      if (status === "open" && deadline && deadline < today()) throw badRequest("Set a future deadline before opening this job");
      vals.push(status); sets.push(`status=$${vals.length}`);
      if (status === "open" && !cur.published_at) sets.push("published_at=now()");
    }
    if (!sets.length) throw badRequest("Nothing to update");
    vals.push(id);
    await c.query(`UPDATE jobs SET ${sets.join(", ")}, updated_at=now() WHERE id=$${vals.length}`, vals);
    await audit({ actorId, businessId, action: status && status !== cur.status ? `job.${status}` : "job.update", entity: "job", entityId: id, metadata: { fields: Object.keys(patch) }, ip }, c);
  });
  return getJob(businessId, id);
}

export async function deleteJob(businessId: string, id: string, actorId: string, ip?: string) {
  const { rows } = await pool.query("SELECT status, (SELECT count(*)::int FROM applications WHERE job_id=jobs.id) AS n FROM jobs WHERE id=$1 AND business_id=$2", [id, businessId]);
  if (!rows[0]) throw notFound();
  if (rows[0].n > 0) throw conflict("This job has applications. Close it instead of deleting it.");
  await pool.query("DELETE FROM jobs WHERE id=$1", [id]);
  await audit({ actorId, businessId, action: "job.delete", entity: "job", entityId: id, ip });
}

// ---------- public discovery ----------
export async function searchPublic(f: any, userId?: string) {
  const v: any[] = []; const where: string[] = [];
  if (f.q) { v.push(`%${escapeLike(f.q)}%`); where.push(`(j.title ILIKE $${v.length} OR j.description ILIKE $${v.length})`); }
  if (f.location) { v.push(`%${escapeLike(f.location)}%`); where.push(`j.location ILIKE $${v.length}`); }
  if (f.workType) { v.push(f.workType); where.push(`j.work_type=$${v.length}`); }
  if (f.skill) { v.push(f.skill); where.push(`EXISTS (SELECT 1 FROM unnest(j.skills) s WHERE lower(s)=lower($${v.length}))`); }
  if (f.remote) where.push("j.is_remote");
  if (f.businessId) { v.push(f.businessId); where.push(`j.business_id=$${v.length}`); }
  const extra = where.length ? ` AND ${where.join(" AND ")}` : "";
  const { rows: t } = await pool.query(`SELECT count(*)::int AS n FROM (${PSEL}${extra}) x`, v);
  let applied = "";
  if (userId) { v.push(userId); applied = `, EXISTS (SELECT 1 FROM applications a WHERE a.job_id=j.id AND a.user_id=$${v.length}) AS applied`; }
  v.push(f.limit, f.offset);
  const order = f.sort === "deadline" ? "j.deadline NULLS LAST, j.id" : "j.published_at DESC, j.id";
  const sql = PSEL.replace("SELECT j.*,", `SELECT j.*${applied},`) + extra + ` ORDER BY ${order} LIMIT $${v.length - 1} OFFSET $${v.length}`;
  const { rows } = await pool.query(sql, v);
  return { jobs: rows.map(pubJob), total: t[0].n };
}

export async function getPublic(id: string, userId?: string) {
  const v: any[] = [id]; let applied = "";
  if (userId) { v.push(userId); applied = `, EXISTS (SELECT 1 FROM applications a WHERE a.job_id=j.id AND a.user_id=$2) AS applied`; }
  const { rows } = await pool.query(PSEL.replace("SELECT j.*,", `SELECT j.*${applied},`) + " AND j.id=$1", v);
  if (!rows[0]) throw notFound();
  return pubJob(rows[0]);
}

// ---------- applications ----------
const TRANSITIONS: Record<string, string[]> = { applied: ["shortlisted", "rejected"], shortlisted: ["interview", "selected", "rejected"], interview: ["selected", "rejected"], selected: [], rejected: [], withdrawn: [] };
const WITHDRAWABLE = ["applied", "shortlisted", "interview"];

const event = (c: any, applicationId: string, status: string, actorId: string, note?: string | null) =>
  c.query("INSERT INTO application_events (application_id, status, actor_id, note) VALUES ($1,$2,$3,$4)", [applicationId, status, actorId, note ?? null]);

export async function apply(user: { id: string; accountType: string }, jobId: string, coverLetter: string | undefined, ip?: string) {
  if (!["individual", "employee"].includes(user.accountType)) throw forbidden("Only individuals and employees can apply for jobs");
  const { rows } = await pool.query(
    `SELECT j.id, j.title, j.business_id FROM jobs j JOIN businesses b ON b.id=j.business_id AND b.status='active'
      WHERE j.id=$1 AND j.status='open' AND (j.deadline IS NULL OR j.deadline >= CURRENT_DATE)`, [jobId]);
  const job = rows[0];
  if (!job) throw notFound("This job is not open for applications");
  const { rows: mem } = await pool.query("SELECT 1 FROM business_members WHERE business_id=$1 AND user_id=$2 AND status='active'", [job.business_id, user.id]);
  if (mem[0]) throw forbidden("You cannot apply to a job at your own business");
  let id: string;
  try {
    id = await tx(async (c) => {
      const r = await c.query("INSERT INTO applications (job_id, user_id, cover_letter) VALUES ($1,$2,$3) RETURNING id", [jobId, user.id, coverLetter ?? null]);
      await event(c, r.rows[0].id, "applied", user.id);
      await audit({ actorId: user.id, businessId: job.business_id, action: "application.create", entity: "application", entityId: r.rows[0].id, ip }, c);
      return r.rows[0].id as string;
    });
  } catch (e: any) { if (e.code === "23505") throw conflict("You have already applied to this job"); throw e; }
  await notifyMembersWith(job.business_id, "jobs.manage", { type: "application.new", title: "New job application", body: job.title, data: { applicationId: id, jobId, businessId: job.business_id } });
  return myApplication(user.id, id);
}

const pubApp = (r: any) => ({
  id: r.id, jobId: r.job_id, jobTitle: r.job_title, businessId: r.business_id, businessName: r.business_name, businessSlug: r.business_slug, status: r.status,
  coverLetter: r.cover_letter, interviewAt: r.interview_at, appliedAt: r.created_at, updatedAt: r.updated_at,
});
const ASEL = `SELECT a.*, j.title AS job_title, j.business_id, b.name AS business_name, b.slug AS business_slug FROM applications a JOIN jobs j ON j.id=a.job_id JOIN businesses b ON b.id=j.business_id`;

async function history(applicationId: string) {
  const { rows } = await pool.query(`SELECT e.status, e.note, e.created_at, u.full_name AS actor FROM application_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.application_id=$1 ORDER BY e.id`, [applicationId]);
  return rows.map((r) => ({ status: r.status, note: r.note, actorName: r.actor, createdAt: r.created_at }));
}

export async function myApplication(userId: string, id: string) {
  const { rows } = await pool.query(`${ASEL} WHERE a.id=$1 AND a.user_id=$2`, [id, userId]);
  if (!rows[0]) throw notFound();
  return { ...pubApp(rows[0]), history: await history(id) };
}

export async function myApplications(userId: string, f: { status?: string; limit: number; offset: number }) {
  const v: any[] = [userId]; let w = "a.user_id=$1";
  if (f.status) { v.push(f.status); w += ` AND a.status=$${v.length}`; }
  const { rows: t } = await pool.query(`SELECT count(*)::int AS n FROM applications a WHERE ${w}`, v);
  v.push(f.limit, f.offset);
  const { rows } = await pool.query(`${ASEL} WHERE ${w} ORDER BY a.created_at DESC LIMIT $${v.length - 1} OFFSET $${v.length}`, v);
  return { applications: rows.map(pubApp), total: t[0].n };
}

export async function withdraw(userId: string, id: string, ip?: string) {
  let job: any;
  await tx(async (c) => {
    const { rows } = await c.query("SELECT a.*, j.title, j.business_id FROM applications a JOIN jobs j ON j.id=a.job_id WHERE a.id=$1 AND a.user_id=$2 FOR UPDATE OF a", [id, userId]);
    if (!rows[0]) throw notFound();
    if (!WITHDRAWABLE.includes(rows[0].status)) throw conflict(`An application that is ${rows[0].status} cannot be withdrawn`);
    job = rows[0];
    await c.query("UPDATE applications SET status='withdrawn', updated_at=now() WHERE id=$1", [id]);
    await event(c, id, "withdrawn", userId);
    await audit({ actorId: userId, businessId: job.business_id, action: "application.withdraw", entity: "application", entityId: id, ip }, c);
  });
  await notifyMembersWith(job.business_id, "jobs.manage", { type: "application.withdrawn", title: "An applicant withdrew", body: job.title, data: { applicationId: id, businessId: job.business_id } });
  return myApplication(userId, id);
}

// ----- business side -----
export async function listApplications(businessId: string, f: { jobId?: string; status?: string; limit: number; offset: number }) {
  const v: any[] = [businessId]; const where = ["j.business_id=$1"];
  if (f.jobId) { v.push(f.jobId); where.push(`a.job_id=$${v.length}`); }
  if (f.status) { v.push(f.status); where.push(`a.status=$${v.length}`); }
  const w = where.join(" AND ");
  const { rows: t } = await pool.query(`SELECT count(*)::int AS n FROM applications a JOIN jobs j ON j.id=a.job_id WHERE ${w}`, v);
  v.push(f.limit, f.offset);
  const { rows } = await pool.query(
    `${ASEL.replace("SELECT a.*,", "SELECT a.*, u.full_name AS applicant_name, p.headline, p.city,")} JOIN users u ON u.id=a.user_id JOIN profiles p ON p.user_id=a.user_id
      WHERE ${w} ORDER BY a.created_at DESC, a.id LIMIT $${v.length - 1} OFFSET $${v.length}`, v);
  const ids = [...new Set(rows.map((r) => r.user_id))];
  const [sk, ex] = ids.length ? await Promise.all([
    pool.query("SELECT user_id, name::text AS name FROM user_skills WHERE user_id = ANY($1::uuid[]) ORDER BY lower(name::text)", [ids]),
    pool.query("SELECT user_id, start_date::text AS s, end_date::text AS e FROM work_experience WHERE user_id = ANY($1::uuid[])", [ids]),
  ]) : [{ rows: [] }, { rows: [] }];
  return { total: t[0].n, applications: rows.map((r) => ({
    ...pubApp(r), reviewerView: true,
    applicant: { userId: r.user_id, name: r.applicant_name, headline: r.headline, city: r.city,
      skills: sk.rows.filter((s: any) => s.user_id === r.user_id).map((s: any) => s.name).slice(0, 10),
      experienceMonths: experienceMonths(ex.rows.filter((e: any) => e.user_id === r.user_id).map((e: any) => ({ start: e.s, end: e.e }))) },
  })) };
}

export async function getApplication(businessId: string, id: string) {
  const { rows } = await pool.query(`${ASEL} WHERE a.id=$1 AND j.business_id=$2`, [id, businessId]);
  if (!rows[0]) throw notFound();
  // Applying shares the full profile, including contact details, with the business that owns the job.
  return { ...pubApp(rows[0]), applicant: await resume(rows[0].user_id, true), history: await history(id) };
}

export async function setApplicationStatus(businessId: string, id: string, actorId: string, i: { status: string; note?: string; interviewAt?: Date }, ip?: string) {
  let app: any;
  await tx(async (c) => {
    const { rows } = await c.query(
      `SELECT a.*, j.title, j.business_id FROM applications a JOIN jobs j ON j.id=a.job_id WHERE a.id=$1 AND j.business_id=$2 FOR UPDATE OF a`, [id, businessId]);
    if (!rows[0]) throw notFound();
    app = rows[0];
    if (!TRANSITIONS[app.status]?.includes(i.status)) throw conflict(`An application that is ${app.status} cannot become ${i.status}`);
    if (i.interviewAt && i.status !== "interview") throw badRequest("An interview time only applies when moving to the interview stage");
    await c.query("UPDATE applications SET status=$2, interview_at=$3, updated_at=now() WHERE id=$1", [id, i.status, i.interviewAt ?? null]);
    await event(c, id, i.status, actorId, i.note);
    await audit({ actorId, businessId, action: "application.status", entity: "application", entityId: id, metadata: { from: app.status, to: i.status }, ip }, c);
  });
  await notify(app.user_id, { type: "application.status", title: `Your application is now ${i.status}`, body: app.title, data: { applicationId: id, status: i.status } });
  return getApplication(businessId, id);
}
