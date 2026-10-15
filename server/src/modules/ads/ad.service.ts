import { pool } from "../../db.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { buildSets } from "../../lib/sql.js";
import { audit } from "../audit/audit.service.js";
import { notifyMembersWith } from "../notifications/notification.service.js";

const pub = (r: any) => ({
  id: r.id, title: r.title, description: r.description, imageUrl: r.image_url, ctaLabel: r.cta_label, ctaUrl: r.cta_url, placements: r.placements,
  startDate: r.start_text, endDate: r.end_text, status: r.status, moderationStatus: r.moderation_status, moderationNote: r.moderation_note,
  tier: r.tier, impressions: Number(r.impressions), clicks: Number(r.clicks), createdAt: r.created_at,
});
const SEL = "SELECT a.*, a.start_date::text AS start_text, a.end_date::text AS end_text FROM advertisements a";
const COLS = { title: "title", description: "description", imageUrl: "image_url", ctaLabel: "cta_label", ctaUrl: "cta_url", placements: "placements", startDate: "start_date", endDate: "end_date" };

export async function createAd(businessId: string, actorId: string, i: any, ip?: string) {
  if (i.endDate < i.startDate) throw badRequest("The end date cannot be before the start date");
  const cols = ["business_id", "created_by"]; const vals: any[] = [businessId, actorId];
  for (const [k, col] of Object.entries(COLS)) if (i[k] !== undefined) { cols.push(col); vals.push(i[k]); }
  const { rows } = await pool.query(`INSERT INTO advertisements (${cols.join(",")}) VALUES (${cols.map((_, n) => `$${n + 1}`).join(",")}) RETURNING id`, vals);
  await audit({ actorId, businessId, action: "ad.create", entity: "ad", entityId: rows[0].id, ip });
  return getAd(businessId, rows[0].id);
}
export async function listAds(businessId: string, f: { status?: string; limit: number; offset: number }) {
  const v: any[] = [businessId]; let w = "a.business_id=$1";
  if (f.status) { v.push(f.status); w += ` AND a.status=$${v.length}`; }
  const { rows: t } = await pool.query(`SELECT count(*)::int AS n FROM advertisements a WHERE ${w}`, v);
  v.push(f.limit, f.offset);
  const { rows } = await pool.query(`${SEL} WHERE ${w} ORDER BY a.created_at DESC LIMIT $${v.length - 1} OFFSET $${v.length}`, v);
  return { ads: rows.map(pub), total: t[0].n };
}
export async function getAd(businessId: string, id: string) {
  const { rows } = await pool.query(`${SEL} WHERE a.id=$1 AND a.business_id=$2`, [id, businessId]);
  if (!rows[0]) throw notFound();
  return pub(rows[0]);
}
export async function updateAd(businessId: string, id: string, actorId: string, patch: any, ip?: string) {
  const { status, ...rest } = patch;
  const { rows } = await pool.query("SELECT * FROM advertisements WHERE id=$1 AND business_id=$2", [id, businessId]);
  if (!rows[0]) throw notFound();
  const cur = rows[0];
  const s = rest.startDate ?? cur.start_date.toISOString().slice(0, 10), e = rest.endDate ?? cur.end_date.toISOString().slice(0, 10);
  if (e < s) throw badRequest("The end date cannot be before the start date");
  const { sets, vals } = buildSets(COLS, rest);
  if (status) {
    if (status === "active" && cur.moderation_status !== "approved") throw conflict("This ad was rejected by moderators and cannot go live");
    vals.push(status); sets.push(`status=$${vals.length}`);
  }
  if (!sets.length) throw badRequest("Nothing to update");
  // Editing the creative of a live ad is fine; moderators re-check on report.
  vals.push(id);
  await pool.query(`UPDATE advertisements SET ${sets.join(", ")}, updated_at=now() WHERE id=$${vals.length}`, vals);
  await audit({ actorId, businessId, action: status ? `ad.${status}` : "ad.update", entity: "ad", entityId: id, ip });
  return getAd(businessId, id);
}
export async function deleteAd(businessId: string, id: string, actorId: string, ip?: string) {
  const r = await pool.query("DELETE FROM advertisements WHERE id=$1 AND business_id=$2", [id, businessId]);
  if (!r.rowCount) throw notFound();
  await audit({ actorId, businessId, action: "ad.delete", entity: "ad", entityId: id, ip });
}

// ---------- serving ----------
const LIVE = `a.status='active' AND a.moderation_status='approved' AND CURRENT_DATE BETWEEN a.start_date AND a.end_date
              AND EXISTS (SELECT 1 FROM businesses b WHERE b.id=a.business_id AND b.is_public AND b.status='active')`;

export async function serve(f: { placement: string; businessId?: string; limit: number }) {
  const v: any[] = [f.placement]; let extra = "";
  if (f.businessId) { v.push(f.businessId); extra = ` AND a.business_id=$2`; }
  v.push(f.limit);
  const { rows } = await pool.query(
    `SELECT a.*, b.name AS business_name, b.slug AS business_slug FROM advertisements a JOIN businesses b ON b.id=a.business_id
      WHERE ${LIVE} AND $1 = ANY(a.placements)${extra} ORDER BY random() LIMIT $${v.length}`, v);
  if (rows.length) await pool.query("UPDATE advertisements SET impressions = impressions + 1 WHERE id = ANY($1::uuid[])", [rows.map((r) => r.id)]);
  return rows.map((r) => ({ id: r.id, title: r.title, description: r.description, imageUrl: r.image_url, ctaLabel: r.cta_label, ctaUrl: r.cta_url,
    business: { id: r.business_id, name: r.business_name, slug: r.business_slug } }));
}
export async function recordClick(id: string) {
  const r = await pool.query(`UPDATE advertisements a SET clicks = clicks + 1 WHERE a.id=$1 AND ${LIVE}`, [id]);
  if (!r.rowCount) throw notFound();
}

// ---------- admin moderation ----------
export async function adminList(f: { moderation?: string; limit: number; offset: number }) {
  const v: any[] = []; let w = "true";
  if (f.moderation) { v.push(f.moderation); w = `a.moderation_status=$1`; }
  const { rows: t } = await pool.query(`SELECT count(*)::int AS n FROM advertisements a WHERE ${w}`, v);
  v.push(f.limit, f.offset);
  const { rows } = await pool.query(`${SEL.replace("SELECT a.*,", "SELECT a.*, (SELECT name FROM businesses WHERE id=a.business_id) AS business_name,")} WHERE ${w} ORDER BY a.created_at DESC LIMIT $${v.length - 1} OFFSET $${v.length}`, v);
  return { total: t[0].n, ads: rows.map((r) => ({ ...pub(r), businessId: r.business_id, businessName: r.business_name })) };
}
export async function adminModerate(adminId: string, id: string, decision: "approved" | "rejected", note?: string) {
  const { rows } = await pool.query(
    `UPDATE advertisements SET moderation_status=$2, moderation_note=$3, status = CASE WHEN $2='rejected' THEN 'paused' ELSE status END, updated_at=now() WHERE id=$1 RETURNING business_id, title`, [id, decision, note ?? null]);
  if (!rows[0]) throw notFound();
  await audit({ actorId: adminId, businessId: rows[0].business_id, action: `admin.ad_${decision}`, entity: "ad", entityId: id, metadata: { note } });
  if (decision === "rejected") await notifyMembersWith(rows[0].business_id, "ads.manage", { type: "ad.rejected", title: "An advertisement was rejected", body: note ?? rows[0].title, data: { adId: id } });
}
