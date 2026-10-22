import fs from "node:fs";
import path from "node:path";
import { pool, tx } from "../../db.js";
import { AppError, badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { detectFileType } from "../../lib/upload.js";
import { openFile, removeFile, storeFile } from "../../lib/storage.js";
import { buildSets } from "../../lib/sql.js";
import { audit } from "../audit/audit.service.js";
import { notify, notifyMembersWith } from "../notifications/notification.service.js";
import { assertWithin, recordFile } from "../plans/plan.service.js";

const today = () => new Date().toISOString().slice(0, 10);
const dayDiff = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

// =============================== LEAVE ===============================
const pubLeave = (r: any) => ({
  id: r.id, employeeId: r.employee_id, employeeName: r.employee_name, type: r.type, startDate: r.start_text, endDate: r.end_text, days: r.days, reason: r.reason,
  status: r.status, decisionNote: r.decision_note, decidedAt: r.decided_at, createdAt: r.created_at,
});
const LSEL = `SELECT l.*, l.start_date::text AS start_text, l.end_date::text AS end_text, u.full_name AS employee_name
                FROM leave_requests l JOIN employees e ON e.id=l.employee_id JOIN users u ON u.id=e.user_id`;

export async function requestLeave(businessId: string, employeeId: string, userId: string, i: { type: string; startDate: string; endDate: string; reason?: string }, ip?: string) {
  const days = dayDiff(i.startDate, i.endDate) + 1;
  if (days < 1) throw badRequest("The end date cannot be before the start date");
  if (days > 90) throw badRequest("A single request can cover at most 90 days");
  if (dayDiff(i.startDate, today()) > 30) throw badRequest("Leave cannot start more than 30 days in the past");
  let id: string;
  try {
    const { rows } = await pool.query(
      `INSERT INTO leave_requests (business_id, employee_id, type, start_date, end_date, days, reason) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [businessId, employeeId, i.type, i.startDate, i.endDate, days, i.reason ?? null]);
    id = rows[0].id;
  } catch (e: any) {
    if (e.code === "23P01") throw conflict("You already have a pending or approved leave covering some of these days");   // exclusion constraint
    throw e;
  }
  await audit({ actorId: userId, businessId, action: "leave.request", entity: "leave", entityId: id, metadata: { days, type: i.type }, ip });
  await notifyMembersWith(businessId, "leave.manage", { type: "leave.requested", title: "New leave request", body: `${days} day${days === 1 ? "" : "s"} (${i.type})`, data: { leaveId: id, businessId } });
  return getLeave(businessId, id);
}

export async function getLeave(businessId: string, id: string) {
  const { rows } = await pool.query(`${LSEL} WHERE l.id=$1 AND l.business_id=$2`, [id, businessId]);
  if (!rows[0]) throw notFound();
  return pubLeave(rows[0]);
}

export async function myLeave(employeeId: string, year: number) {
  const { rows } = await pool.query(`${LSEL} WHERE l.employee_id=$1 ORDER BY l.start_date DESC`, [employeeId]);
  const used: Record<string, number> = {};
  for (const r of rows) if (r.status === "approved" && new Date(r.start_text).getUTCFullYear() === year) used[r.type] = (used[r.type] ?? 0) + r.days;
  return { leave: rows.map(pubLeave), approvedDaysThisYear: used };
}

export async function cancelOwn(businessId: string, employeeId: string, userId: string, id: string, ip?: string) {
  const { rows } = await pool.query("SELECT * FROM leave_requests WHERE id=$1 AND employee_id=$2 AND business_id=$3", [id, employeeId, businessId]);
  const l = rows[0];
  if (!l) throw notFound();
  const started = l.start_date.toISOString().slice(0, 10) <= today();
  if (!(l.status === "pending" || (l.status === "approved" && !started))) throw conflict(`A ${l.status} leave${started ? " that has already started" : ""} cannot be cancelled`);
  await pool.query("UPDATE leave_requests SET status='cancelled' WHERE id=$1", [id]);
  await audit({ actorId: userId, businessId, action: "leave.cancel", entity: "leave", entityId: id, ip });
  if (l.status === "approved") await notifyMembersWith(businessId, "leave.manage", { type: "leave.cancelled", title: "Approved leave was cancelled", data: { leaveId: id, businessId } });
  return getLeave(businessId, id);
}

export async function listLeave(businessId: string, f: { status?: string; employeeId?: string; from?: string; to?: string; limit: number; offset: number }) {
  const where = ["l.business_id=$1"]; const v: any[] = [businessId];
  if (f.status) { v.push(f.status); where.push(`l.status=$${v.length}`); }
  if (f.employeeId) { v.push(f.employeeId); where.push(`l.employee_id=$${v.length}`); }
  if (f.from) { v.push(f.from); where.push(`l.end_date >= $${v.length}::date`); }
  if (f.to) { v.push(f.to); where.push(`l.start_date <= $${v.length}::date`); }
  const w = where.join(" AND ");
  const { rows: t } = await pool.query(`SELECT count(*)::int AS n FROM leave_requests l WHERE ${w}`, v);
  v.push(f.limit, f.offset);
  const { rows } = await pool.query(`${LSEL} WHERE ${w} ORDER BY l.start_date DESC, l.id LIMIT $${v.length - 1} OFFSET $${v.length}`, v);
  return { total: t[0].n, leave: rows.map(pubLeave) };
}

export async function decideLeave(businessId: string, id: string, actorId: string, i: { decision: "approved" | "rejected"; note?: string }, ip?: string) {
  let userId = "";
  await tx(async (c) => {
    const { rows } = await c.query("SELECT l.*, e.user_id FROM leave_requests l JOIN employees e ON e.id=l.employee_id WHERE l.id=$1 AND l.business_id=$2 FOR UPDATE OF l", [id, businessId]);
    if (!rows[0]) throw notFound();
    if (rows[0].status !== "pending") throw conflict(`A ${rows[0].status} request cannot be decided`);
    if (rows[0].user_id === actorId) throw forbidden("You cannot decide your own leave request");
    userId = rows[0].user_id;
    await c.query("UPDATE leave_requests SET status=$2, decided_by=$3, decision_note=$4, decided_at=now() WHERE id=$1", [id, i.decision, actorId, i.note ?? null]);
    await audit({ actorId, businessId, action: `leave.${i.decision}`, entity: "leave", entityId: id, ip }, c);
  });
  await notify(userId, { type: "leave.decision", title: `Your leave was ${i.decision}`, body: i.note, data: { leaveId: id, status: i.decision } });
  return getLeave(businessId, id);
}

// ========================== PERFORMANCE REVIEWS ==========================
const pubPerf = (r: any) => ({
  id: r.id, employeeId: r.employee_id, employeeName: r.employee_name, reviewerName: r.reviewer_name, periodStart: r.ps, periodEnd: r.pe, rating: r.rating,
  strengths: r.strengths, improvements: r.improvements, goals: r.goals, status: r.status, sharedAt: r.shared_at, acknowledgedAt: r.acknowledged_at, createdAt: r.created_at,
});
const PSEL = `SELECT p.*, p.period_start::text AS ps, p.period_end::text AS pe, u.full_name AS employee_name, rv.full_name AS reviewer_name
                FROM performance_reviews p JOIN employees e ON e.id=p.employee_id JOIN users u ON u.id=e.user_id LEFT JOIN users rv ON rv.id=p.reviewer_id`;

export async function createReview(businessId: string, actorId: string, i: any, ip?: string) {
  const { rows } = await pool.query("SELECT user_id FROM employees WHERE id=$1 AND business_id=$2", [i.employeeId, businessId]);
  if (!rows[0]) throw notFound("Employee not found");
  if (rows[0].user_id === actorId) throw forbidden("You cannot write your own performance review");
  if (i.periodEnd < i.periodStart) throw badRequest("The period end cannot be before the start");
  const r = await pool.query(
    `INSERT INTO performance_reviews (business_id, employee_id, reviewer_id, period_start, period_end, rating, strengths, improvements, goals) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [businessId, i.employeeId, actorId, i.periodStart, i.periodEnd, i.rating, i.strengths ?? null, i.improvements ?? null, i.goals ?? null]);
  await audit({ actorId, businessId, action: "performance.create", entity: "performance_review", entityId: r.rows[0].id, ip });
  return getReview(businessId, r.rows[0].id);
}
export async function getReview(businessId: string, id: string) {
  const { rows } = await pool.query(`${PSEL} WHERE p.id=$1 AND p.business_id=$2`, [id, businessId]);
  if (!rows[0]) throw notFound();
  return pubPerf(rows[0]);
}
export async function listReviews(businessId: string, f: { employeeId?: string; status?: string; limit: number; offset: number }) {
  const where = ["p.business_id=$1"]; const v: any[] = [businessId];
  if (f.employeeId) { v.push(f.employeeId); where.push(`p.employee_id=$${v.length}`); }
  if (f.status) { v.push(f.status); where.push(`p.status=$${v.length}`); }
  const w = where.join(" AND ");
  const { rows: t } = await pool.query(`SELECT count(*)::int AS n FROM performance_reviews p WHERE ${w}`, v);
  v.push(f.limit, f.offset);
  const { rows } = await pool.query(`${PSEL} WHERE ${w} ORDER BY p.period_end DESC, p.id LIMIT $${v.length - 1} OFFSET $${v.length}`, v);
  return { total: t[0].n, reviews: rows.map(pubPerf) };
}
export async function updateReview(businessId: string, id: string, actorId: string, patch: any, ip?: string) {
  const { rows } = await pool.query("SELECT status FROM performance_reviews WHERE id=$1 AND business_id=$2", [id, businessId]);
  if (!rows[0]) throw notFound();
  if (rows[0].status === "shared") throw conflict("A shared review can no longer be edited");
  const { sets, vals } = buildSets({ periodStart: "period_start", periodEnd: "period_end", rating: "rating", strengths: "strengths", improvements: "improvements", goals: "goals" }, patch);
  if (!sets.length) throw badRequest("Nothing to update");
  vals.push(id);
  try { await pool.query(`UPDATE performance_reviews SET ${sets.join(", ")}, updated_at=now() WHERE id=$${vals.length}`, vals); }
  catch (e: any) { if (e.code === "23514") throw badRequest("The period end cannot be before the start"); throw e; }
  await audit({ actorId, businessId, action: "performance.update", entity: "performance_review", entityId: id, ip });
  return getReview(businessId, id);
}
export async function shareReview(businessId: string, id: string, actorId: string, ip?: string) {
  const { rows } = await pool.query(
    `UPDATE performance_reviews p SET status='shared', shared_at=now(), updated_at=now() FROM employees e WHERE p.id=$1 AND p.business_id=$2 AND p.status='draft' AND e.id=p.employee_id RETURNING e.user_id`, [id, businessId]);
  if (!rows[0]) { await getReview(businessId, id); throw conflict("This review has already been shared"); }
  await audit({ actorId, businessId, action: "performance.share", entity: "performance_review", entityId: id, ip });
  await notify(rows[0].user_id, { type: "performance.shared", title: "A performance review was shared with you", data: { reviewId: id, businessId } });
  return getReview(businessId, id);
}
export async function deleteReview(businessId: string, id: string, actorId: string, ip?: string) {
  const { rows } = await pool.query("SELECT status FROM performance_reviews WHERE id=$1 AND business_id=$2", [id, businessId]);
  if (!rows[0]) throw notFound();
  if (rows[0].status === "shared") throw conflict("A shared review is part of the employee's record and cannot be deleted");
  await pool.query("DELETE FROM performance_reviews WHERE id=$1", [id]);
  await audit({ actorId, businessId, action: "performance.delete", entity: "performance_review", entityId: id, ip });
}
export async function myReviews(employeeId: string) {
  const { rows } = await pool.query(`${PSEL} WHERE p.employee_id=$1 AND p.status='shared' ORDER BY p.period_end DESC`, [employeeId]);
  return rows.map(pubPerf);
}
export async function acknowledge(employeeId: string, id: string) {
  const { rows } = await pool.query("UPDATE performance_reviews SET acknowledged_at=COALESCE(acknowledged_at, now()) WHERE id=$1 AND employee_id=$2 AND status='shared' RETURNING business_id", [id, employeeId]);
  if (!rows[0]) throw notFound();
  return getReview(rows[0].business_id, id);
}

// ============================ DOCUMENTS ============================
const pubDoc = (r: any) => ({
  id: r.id, employeeId: r.employee_id, name: r.name, category: r.category, mime: r.mime, bytes: Number(r.bytes), originalName: r.original_name,
  expiryDate: r.expiry_text, visibleToEmployee: r.visible_to_employee, expiringSoon: r.expiry_text ? dayDiff(today(), r.expiry_text) <= 30 : false, createdAt: r.created_at,
});
const DSEL = "SELECT d.*, d.expiry_date::text AS expiry_text FROM employee_documents d";
const KEY_RE = /^[0-9a-f-]{36}\.(png|jpg|webp|pdf)$/;
const safeName = (s: string) => s.replace(/[^\w.\- ]+/g, "_").slice(0, 100) || "document";

async function assertEmployee(businessId: string, employeeId: string) {
  const { rows } = await pool.query("SELECT 1 FROM employees WHERE id=$1 AND business_id=$2", [employeeId, businessId]);
  if (!rows[0]) throw notFound("Employee not found");
}

export async function addDocument(businessId: string, employeeId: string, actorId: string, file: { buffer: Buffer; size: number; originalname: string },
  meta: { name: string; category: string; expiryDate?: string; visibleToEmployee?: boolean }, ip?: string) {
  await assertEmployee(businessId, employeeId);
  const type = detectFileType(file.buffer);
  if (!type) throw badRequest("Unsupported file type. Allowed: PNG, JPEG, WebP, PDF");
  await assertWithin(businessId, "storageMb", file.size / 1048576);
  const key = await storeFile("private", file.buffer, type.ext);
  try {
    const id = await tx(async (c) => {
      const sf = await recordFile(businessId, actorId, key, file.size, true, c);
      const { rows } = await c.query(
        `INSERT INTO employee_documents (business_id, employee_id, name, category, file_key, original_name, mime, bytes, expiry_date, visible_to_employee, stored_file_id, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [businessId, employeeId, meta.name, meta.category, key, safeName(file.originalname), type.mime, file.size, meta.expiryDate ?? null, meta.visibleToEmployee ?? false, sf, actorId]);
      await audit({ actorId, businessId, action: "document.upload", entity: "employee_document", entityId: rows[0].id, metadata: { category: meta.category }, ip }, c);
      return rows[0].id as string;
    });
    return getDocument(businessId, employeeId, id);
  } catch (e) { await removeFile("private", key); throw e; }   // no orphaned files if the insert fails
}
export async function getDocument(businessId: string, employeeId: string, id: string) {
  const { rows } = await pool.query(`${DSEL} WHERE d.id=$1 AND d.employee_id=$2 AND d.business_id=$3`, [id, employeeId, businessId]);
  if (!rows[0]) throw notFound();
  return pubDoc(rows[0]);
}
export async function listDocuments(businessId: string, employeeId: string, onlyVisible = false) {
  const { rows } = await pool.query(`${DSEL} WHERE d.employee_id=$1 AND d.business_id=$2 ${onlyVisible ? "AND d.visible_to_employee" : ""} ORDER BY d.created_at DESC`, [employeeId, businessId]);
  return rows.map(pubDoc);
}
export async function updateDocument(businessId: string, employeeId: string, id: string, actorId: string, patch: any, ip?: string) {
  const { sets, vals } = buildSets({ name: "name", category: "category", expiryDate: "expiry_date", visibleToEmployee: "visible_to_employee" }, patch);
  if (!sets.length) throw badRequest("Nothing to update");
  vals.push(id, employeeId, businessId);
  const r = await pool.query(`UPDATE employee_documents SET ${sets.join(", ")} WHERE id=$${vals.length - 2} AND employee_id=$${vals.length - 1} AND business_id=$${vals.length}`, vals);
  if (!r.rowCount) throw notFound();
  await audit({ actorId, businessId, action: "document.update", entity: "employee_document", entityId: id, metadata: { fields: Object.keys(patch) }, ip });
  return getDocument(businessId, employeeId, id);
}
export async function deleteDocument(businessId: string, employeeId: string, id: string, actorId: string, ip?: string) {
  const { rows } = await pool.query("DELETE FROM employee_documents WHERE id=$1 AND employee_id=$2 AND business_id=$3 RETURNING file_key, stored_file_id", [id, employeeId, businessId]);
  if (!rows[0]) throw notFound();
  if (rows[0].stored_file_id) await pool.query("DELETE FROM stored_files WHERE id=$1", [rows[0].stored_file_id]);
  await removeFile("private", rows[0].file_key);
  await audit({ actorId, businessId, action: "document.delete", entity: "employee_document", entityId: id, ip });
}
export async function expiringDocuments(businessId: string, days: number) {
  const { rows } = await pool.query(
    `${DSEL.replace("SELECT d.*,", "SELECT d.*, u.full_name AS employee_name,")} JOIN employees e ON e.id=d.employee_id JOIN users u ON u.id=e.user_id
      WHERE d.business_id=$1 AND d.expiry_date IS NOT NULL AND d.expiry_date <= CURRENT_DATE + $2::int ORDER BY d.expiry_date`, [businessId, days]);
  return rows.map((r) => ({ ...pubDoc(r), employeeName: r.employee_name }));
}

/** Resolves a stored private file for streaming. `onlyVisible` is used for employees reading their own files. */
export async function openDocument(businessId: string, employeeId: string, id: string, onlyVisible: boolean) {
  const { rows } = await pool.query(`${DSEL} WHERE d.id=$1 AND d.employee_id=$2 AND d.business_id=$3 ${onlyVisible ? "AND d.visible_to_employee" : ""}`, [id, employeeId, businessId]);
  const d = rows[0];
  if (!d || !KEY_RE.test(d.file_key)) throw notFound();
  const file = await openFile("private", d.file_key).catch(() => { throw new AppError(502, "STORAGE_UNAVAILABLE", "File storage is temporarily unavailable. Please try again."); });
  if (!file) throw new AppError(410, "FILE_MISSING", "This file is no longer available");
  return { file, mime: d.mime as string, filename: `${safeName(d.name)}${path.extname(d.file_key)}` };
}
