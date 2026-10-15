import { pool, tx } from "../../db.js";
import { AppError, badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { audit } from "../audit/audit.service.js";
import { notify, notifyMembersWith } from "../notifications/notification.service.js";

export interface Subject { type: "business" | "individual"; id: string }
const DAILY_LIMIT = 10;          // reviews one account may write per 24h
const AUTO_HIDE_AT = 3;          // distinct open reports that hide a review pending moderation
const URL_RE = /(https?:\/\/|www\.)/i;

const subjectCol = (s: Subject) => (s.type === "business" ? "subject_business_id" : "subject_user_id");

export async function ratingSummary(s: Subject) {
  const { rows } = await pool.query(`SELECT rating, count(*)::int AS n FROM reviews WHERE ${subjectCol(s)}=$1 AND status='published' GROUP BY rating`, [s.id]);
  const dist: Record<string, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let total = 0, sum = 0;
  for (const r of rows) { dist[String(r.rating)] = r.n; total += r.n; sum += r.rating * r.n; }
  return { average: total ? Math.round((sum / total) * 10) / 10 : null, count: total, distribution: dist };
}

/** Works out how (if at all) the reviewer legitimately dealt with the subject. Throws if they did not. */
export async function eligibility(reviewerId: string, s: Subject): Promise<{ relationship: string; contextBusinessId: string | null }> {
  if (s.type === "business") {
    const { rows: b } = await pool.query("SELECT 1 FROM businesses WHERE id=$1 AND status='active'", [s.id]);
    if (!b[0]) throw notFound("Business not found");
    // Employees are business members too, so employment is checked first; owners/managers may not review their own business.
    const emp = await pool.query("SELECT 1 FROM employees WHERE business_id=$1 AND user_id=$2", [s.id, reviewerId]);
    if (emp.rows[0]) return { relationship: "employee", contextBusinessId: null };
    const { rows: mem } = await pool.query("SELECT 1 FROM business_members WHERE business_id=$1 AND user_id=$2 AND status='active'", [s.id, reviewerId]);
    if (mem[0]) throw forbidden("You cannot review your own business");
    const app = await pool.query(
      `SELECT 1 FROM applications a JOIN jobs j ON j.id=a.job_id WHERE j.business_id=$1 AND a.user_id=$2 AND a.status IN ('interview','selected')`, [s.id, reviewerId]);
    if (app.rows[0]) return { relationship: "applicant", contextBusinessId: null };
    const buy = await pool.query(
      `SELECT m.business_id FROM orders o
         JOIN business_members m ON m.business_id=o.buyer_business_id AND m.user_id=$2 AND m.status='active'
         JOIN role_permissions rp ON rp.role_id=m.role_id AND rp.permission_key='purchases.manage'
        WHERE o.business_id=$1 AND o.status='delivered' LIMIT 1`, [s.id, reviewerId]);
    if (buy.rows[0]) return { relationship: "buyer", contextBusinessId: buy.rows[0].business_id };
    const bought = await pool.query("SELECT 1 FROM orders WHERE business_id=$1 AND buyer_user_id=$2 AND status='delivered' LIMIT 1", [s.id, reviewerId]);
    if (bought.rows[0]) return { relationship: "buyer", contextBusinessId: null };
    throw forbidden("You can review a business after working with it, interviewing with it, or receiving a delivered order from it");
  }
  if (s.id === reviewerId) throw forbidden("You cannot review yourself");
  const { rows: u } = await pool.query("SELECT 1 FROM users WHERE id=$1 AND status='active'", [s.id]);
  if (!u[0]) throw notFound("Person not found");
  const employer = await pool.query(
    `SELECT e.business_id FROM employees e
       JOIN business_members m ON m.business_id=e.business_id AND m.user_id=$2 AND m.status='active'
       JOIN role_permissions rp ON rp.role_id=m.role_id AND rp.permission_key='employees.view'
      WHERE e.user_id=$1 LIMIT 1`, [s.id, reviewerId]);
  if (employer.rows[0]) return { relationship: "employer", contextBusinessId: employer.rows[0].business_id };
  const hirer = await pool.query(
    `SELECT j.business_id FROM applications a JOIN jobs j ON j.id=a.job_id
       JOIN business_members m ON m.business_id=j.business_id AND m.user_id=$2 AND m.status='active'
       JOIN role_permissions rp ON rp.role_id=m.role_id AND rp.permission_key='jobs.manage'
      WHERE a.user_id=$1 AND a.status IN ('interview','selected') LIMIT 1`, [s.id, reviewerId]);
  if (hirer.rows[0]) return { relationship: "hirer", contextBusinessId: hirer.rows[0].business_id };
  throw forbidden("You can review a person after employing them or interviewing them");
}

export async function canReview(reviewerId: string, s: Subject) {
  try {
    const e = await eligibility(reviewerId, s);
    const { rows } = await pool.query(`SELECT id FROM reviews WHERE reviewer_id=$1 AND ${subjectCol(s)}=$2`, [reviewerId, s.id]);
    return { eligible: true, relationship: e.relationship, existingReviewId: rows[0]?.id ?? null };
  } catch (e) {
    if (e instanceof AppError && (e.status === 403 || e.status === 404)) return { eligible: false, reason: e.message };
    throw e;
  }
}

function checkBody(body?: string | null) {
  if (body && URL_RE.test(body)) throw badRequest("Links are not allowed in reviews");
}

export async function createReview(reviewerId: string, i: { subjectType: "business" | "individual"; subjectId: string; rating: number; body?: string }, ip?: string) {
  const subject: Subject = { type: i.subjectType, id: i.subjectId };
  const elig = await eligibility(reviewerId, subject);
  checkBody(i.body);
  const { rows: recent } = await pool.query("SELECT count(*)::int AS n FROM reviews WHERE reviewer_id=$1 AND created_at > now() - interval '24 hours'", [reviewerId]);
  if (recent[0].n >= DAILY_LIMIT) throw new AppError(429, "RATE_LIMITED", "You have reached the daily review limit");
  let id: string;
  try {
    const { rows } = await pool.query(
      `INSERT INTO reviews (reviewer_id, subject_type, subject_business_id, subject_user_id, relationship, context_business_id, rating, body)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [reviewerId, i.subjectType, i.subjectType === "business" ? i.subjectId : null, i.subjectType === "individual" ? i.subjectId : null,
       elig.relationship, elig.contextBusinessId, i.rating, i.body?.trim() || null]);
    id = rows[0].id;
  } catch (e: any) { if (e.code === "23505") throw conflict("You have already reviewed this. Edit your existing review instead."); throw e; }
  await audit({ actorId: reviewerId, action: "review.create", entity: "review", entityId: id, metadata: { subjectType: i.subjectType, rating: i.rating }, ip });
  const n = { type: "review.received", title: "You received a new review", body: `${i.rating} star${i.rating === 1 ? "" : "s"}`, data: { reviewId: id } };
  if (i.subjectType === "business") await notifyMembersWith(i.subjectId, "business.manage", n); else await notify(i.subjectId, n);
  return getOwn(reviewerId, id);
}

async function getOwn(reviewerId: string, id: string) {
  const { rows } = await pool.query("SELECT * FROM reviews WHERE id=$1 AND reviewer_id=$2", [id, reviewerId]);
  if (!rows[0]) throw notFound();
  return pubOwn(rows[0]);
}
const pubOwn = (r: any) => ({ id: r.id, subjectType: r.subject_type, subjectId: r.subject_business_id ?? r.subject_user_id, relationship: r.relationship,
  rating: r.rating, body: r.body, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at });

export async function updateReview(reviewerId: string, id: string, patch: { rating?: number; body?: string | null }) {
  checkBody(patch.body);
  const { rows } = await pool.query("SELECT status FROM reviews WHERE id=$1 AND reviewer_id=$2", [id, reviewerId]);
  if (!rows[0]) throw notFound();
  if (rows[0].status === "hidden") throw conflict("This review is under moderation and cannot be edited");   // blocks editing to dodge a report
  const sets: string[] = []; const v: any[] = [];
  if (patch.rating !== undefined) { v.push(patch.rating); sets.push(`rating=$${v.length}`); }
  if (patch.body !== undefined) { v.push(patch.body?.trim() || null); sets.push(`body=$${v.length}`); }
  if (!sets.length) throw badRequest("Nothing to update");
  v.push(id);
  await pool.query(`UPDATE reviews SET ${sets.join(", ")}, updated_at=now() WHERE id=$${v.length}`, v);
  return getOwn(reviewerId, id);
}

export async function deleteReview(reviewerId: string, id: string) {
  const r = await pool.query("DELETE FROM reviews WHERE id=$1 AND reviewer_id=$2", [id, reviewerId]);
  if (!r.rowCount) throw notFound();
}

// Reviewer shown as "First L." only; ids and contact details never leave the server.
const display = (full: string) => { const p = full.trim().split(/\s+/); return p.length > 1 ? `${p[0]} ${p[p.length - 1][0].toUpperCase()}.` : p[0]; };
const RELLABEL: Record<string, string> = { employee: "Former or current employee", applicant: "Interviewed candidate", buyer: "Verified buyer", employer: "Employer", hirer: "Hiring manager" };

export async function listPublic(s: Subject, limit: number, offset: number) {
  const { rows } = await pool.query(
    `SELECT r.id, r.rating, r.body, r.relationship, r.created_at, u.full_name FROM reviews r JOIN users u ON u.id=r.reviewer_id
      WHERE r.${subjectCol(s)}=$1 AND r.status='published' ORDER BY r.created_at DESC LIMIT $2 OFFSET $3`, [s.id, limit, offset]);
  return { summary: await ratingSummary(s),
    reviews: rows.map((r) => ({ id: r.id, rating: r.rating, body: r.body, reviewer: display(r.full_name), badge: RELLABEL[r.relationship], createdAt: r.created_at })) };
}

export async function received(userId: string, limit: number, offset: number) {
  return listPublic({ type: "individual", id: userId }, limit, offset);
}

export async function reportReview(reporterId: string, reviewId: string, reason: string, ip?: string) {
  let hidden = false; let reviewerId = "";
  await tx(async (c) => {
    const { rows } = await c.query("SELECT * FROM reviews WHERE id=$1 FOR UPDATE", [reviewId]);
    const r = rows[0];
    if (!r || r.status !== "published") throw notFound();
    if (r.reviewer_id === reporterId) throw forbidden("You cannot report your own review");
    try { await c.query("INSERT INTO review_reports (review_id, reporter_id, reason) VALUES ($1,$2,$3)", [reviewId, reporterId, reason]); }
    catch (e: any) { if (e.code === "23505") throw conflict("You have already reported this review"); throw e; }
    const { rows: cnt } = await c.query("SELECT count(*)::int AS n FROM review_reports WHERE review_id=$1 AND status='open'", [reviewId]);
    if (cnt[0].n >= AUTO_HIDE_AT) {
      await c.query("UPDATE reviews SET status='hidden', hidden_reason='Hidden automatically after multiple reports', updated_at=now() WHERE id=$1", [reviewId]);
      hidden = true; reviewerId = r.reviewer_id;
    }
    await audit({ actorId: reporterId, action: "review.report", entity: "review", entityId: reviewId, metadata: { autoHidden: hidden }, ip }, c);
  });
  if (hidden) await notify(reviewerId, { type: "review.hidden", title: "Your review is under moderation", body: "It was reported several times and is hidden until reviewed.", data: { reviewId } });
  return { ok: true, hidden };
}

// ---------- admin moderation ----------
export async function adminList(f: { status?: string; reported?: boolean; limit: number; offset: number }) {
  const where: string[] = ["true"]; const v: any[] = [];
  if (f.status) { v.push(f.status); where.push(`r.status=$${v.length}`); }
  if (f.reported) where.push("EXISTS (SELECT 1 FROM review_reports x WHERE x.review_id=r.id AND x.status='open')");
  const w = where.join(" AND ");
  const { rows: t } = await pool.query(`SELECT count(*)::int AS n FROM reviews r WHERE ${w}`, v);
  v.push(f.limit, f.offset);
  const { rows } = await pool.query(
    `SELECT r.*, u.full_name AS reviewer_name,
            (SELECT count(*)::int FROM review_reports x WHERE x.review_id=r.id AND x.status='open') AS open_reports,
            (SELECT json_agg(json_build_object('reason', x.reason, 'createdAt', x.created_at)) FROM review_reports x WHERE x.review_id=r.id AND x.status='open') AS reports
       FROM reviews r JOIN users u ON u.id=r.reviewer_id WHERE ${w} ORDER BY r.created_at DESC LIMIT $${v.length - 1} OFFSET $${v.length}`, v);
  return { total: t[0].n, reviews: rows.map((r) => ({ ...pubOwn(r), reviewerName: r.reviewer_name, openReports: r.open_reports, reports: r.reports ?? [], hiddenReason: r.hidden_reason })) };
}

export async function adminHide(adminId: string, id: string, reason: string) {
  const r = await pool.query("UPDATE reviews SET status='hidden', hidden_reason=$2, updated_at=now() WHERE id=$1 RETURNING reviewer_id", [id, reason]);
  if (!r.rowCount) throw notFound();
  await pool.query("UPDATE review_reports SET status='actioned' WHERE review_id=$1 AND status='open'", [id]);
  await audit({ actorId: adminId, action: "admin.review_hide", entity: "review", entityId: id, metadata: { reason } });
  await notify(r.rows[0].reviewer_id, { type: "review.hidden", title: "Your review was removed by moderators", body: reason, data: { reviewId: id } });
}

export async function adminRestore(adminId: string, id: string) {
  const r = await pool.query("UPDATE reviews SET status='published', hidden_reason=NULL, updated_at=now() WHERE id=$1", [id]);
  if (!r.rowCount) throw notFound();
  await pool.query("UPDATE review_reports SET status='dismissed' WHERE review_id=$1 AND status='open'", [id]);
  await audit({ actorId: adminId, action: "admin.review_restore", entity: "review", entityId: id });
}
