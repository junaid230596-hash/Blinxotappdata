import { pool, tx } from "../../db.js";
import { AppError, badRequest, forbidden, notFound } from "../../lib/errors.js";
import { audit } from "../audit/audit.service.js";
import { assertCanCreateBusiness } from "../plans/plan.service.js";
import { ratingSummary } from "../reviews/review.service.js";

const slugify = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "business";

export const publicBusiness = (b: any) => ({
  id: b.id, name: b.name, slug: b.slug, description: b.description, category: b.category,
  email: b.email, phone: b.phone, website: b.website, address: b.address, logoUrl: b.logo_url,
  isPublic: b.is_public, createdAt: b.created_at,
  businessHours: b.business_hours ?? {}, socialLinks: b.social_links ?? {},
  legalName: b.legal_name ?? null, gstin: b.gstin ?? null, stateCode: b.state_code ?? null,
});

export async function createBusiness(user: { id: string; accountType: string; emailVerified: boolean }, input: any, ip?: string) {
  if (!user.emailVerified) throw forbidden("Verify your email before creating a business");
  await assertCanCreateBusiness(user.id);
  return tx(async (c) => {
    let slug = slugify(input.name);
    const { rows: taken } = await c.query("SELECT 1 FROM businesses WHERE slug=$1", [slug]);
    if (taken[0]) slug = `${slug}-${Math.random().toString(36).slice(2, 7)}`;

    const { rows } = await c.query(
      `INSERT INTO businesses (owner_id, name, slug, description, category, email, phone, website, address)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [user.id, input.name, slug, input.description ?? null, input.category ?? null, input.email ?? null,
       input.phone ?? null, input.website ?? null, input.address ?? null]);
    const biz = rows[0];
    await c.query("INSERT INTO subscriptions (business_id, plan_key) VALUES ($1,'free')", [biz.id]);

    // Clone the system roles into this business so owners can later customise them.
    await c.query(
      `WITH cloned AS (
         INSERT INTO roles (business_id, name, is_system)
         SELECT $1, name, true FROM roles WHERE business_id IS NULL AND is_system
         RETURNING id, name)
       INSERT INTO role_permissions (role_id, permission_key)
       SELECT cl.id, rp.permission_key
         FROM cloned cl
         JOIN roles sr ON sr.business_id IS NULL AND sr.name = cl.name
         JOIN role_permissions rp ON rp.role_id = sr.id`, [biz.id]);
    const { rows: ownerRole } = await c.query("SELECT id FROM roles WHERE business_id=$1 AND name='Business Owner'", [biz.id]);
    await c.query("INSERT INTO business_members (business_id, user_id, role_id) VALUES ($1,$2,$3)", [biz.id, user.id, ownerRole[0].id]);
    await audit({ actorId: user.id, businessId: biz.id, action: "business.create", entity: "business", entityId: biz.id, ip }, c);
    return publicBusiness(biz);
  });
}

export async function listMine(userId: string) {
  const { rows } = await pool.query(
    `SELECT b.*, r.name AS role_name FROM business_members m
       JOIN businesses b ON b.id = m.business_id
       JOIN roles r ON r.id = m.role_id
      WHERE m.user_id=$1 AND m.status='active' AND b.status='active' ORDER BY b.created_at`, [userId]);
  return rows.map((b) => ({ ...publicBusiness(b), role: b.role_name }));
}

export async function getBusiness(id: string) {
  const { rows } = await pool.query("SELECT * FROM businesses WHERE id=$1", [id]);
  if (!rows[0]) throw notFound();
  return publicBusiness(rows[0]);
}

export async function getPublicBySlug(slug: string) {
  const { rows } = await pool.query("SELECT * FROM businesses WHERE slug=$1 AND is_public AND status='active'", [slug]);
  if (!rows[0]) throw notFound();
  return { ...publicBusiness(rows[0]), rating: await ratingSummary({ type: "business", id: rows[0].id }) };
}

export async function updateBusiness(id: string, actorId: string, patch: Record<string, any>, ip?: string) {
  const map: Record<string, string> = {
    name: "name", description: "description", category: "category", email: "email", phone: "phone",
    website: "website", address: "address", logoUrl: "logo_url", isPublic: "is_public",
    businessHours: "business_hours", socialLinks: "social_links", legalName: "legal_name", gstin: "gstin", stateCode: "state_code",
  };
  if (patch.gstin) {                                              // the first two digits of a GSTIN are the state code
    if (patch.stateCode && patch.stateCode !== patch.gstin.slice(0, 2)) throw badRequest("The first two digits of the GSTIN must match the state");
    patch.stateCode = patch.gstin.slice(0, 2);
  } else if (patch.stateCode) {
    const cur = (await pool.query("SELECT gstin FROM businesses WHERE id=$1", [id])).rows[0]?.gstin;
    if (cur && cur.slice(0, 2) !== patch.stateCode) throw badRequest("The state must match the first two digits of the business GSTIN");
  }
  const sets: string[] = []; const vals: any[] = [];
  for (const [k, col] of Object.entries(map)) {
    if (k in patch) { vals.push(patch[k] === "" && ["legalName", "gstin", "stateCode"].includes(k) ? null : patch[k]); sets.push(`${col}=$${vals.length}`); }
  }
  if (!sets.length) throw badRequest("Nothing to update");
  vals.push(id);
  const { rows } = await pool.query(`UPDATE businesses SET ${sets.join(", ")}, updated_at=now() WHERE id=$${vals.length} RETURNING *`, vals);
  await audit({ actorId, businessId: id, action: "business.update", entity: "business", entityId: id, metadata: { fields: Object.keys(patch) }, ip });
  return publicBusiness(rows[0]);
}

export async function listMembers(businessId: string) {
  const { rows } = await pool.query(
    `SELECT m.id, m.status, m.created_at, u.id AS user_id, u.full_name, u.email, r.id AS role_id, r.name AS role
       FROM business_members m JOIN users u ON u.id=m.user_id JOIN roles r ON r.id=m.role_id
      WHERE m.business_id=$1 AND m.status <> 'removed' ORDER BY m.created_at`, [businessId]);
  return rows.map((r) => ({ id: r.id, userId: r.user_id, fullName: r.full_name, email: r.email, role: r.role, roleId: r.role_id, status: r.status }));
}

export async function listRoles(businessId: string) {
  const { rows } = await pool.query(
    `SELECT r.id, r.name, COALESCE(array_agg(rp.permission_key ORDER BY rp.permission_key) FILTER (WHERE rp.permission_key IS NOT NULL), '{}') AS permissions
       FROM roles r LEFT JOIN role_permissions rp ON rp.role_id=r.id WHERE r.business_id=$1 GROUP BY r.id ORDER BY r.name`, [businessId]);
  return rows;
}

export async function changeMemberRole(businessId: string, memberId: string, roleId: string, actorId: string, ip?: string) {
  return tx(async (c) => {
    const { rows: m } = await c.query(
      `SELECT m.*, r.name AS role_name FROM business_members m JOIN roles r ON r.id=m.role_id
        WHERE m.id=$1 AND m.business_id=$2 FOR UPDATE`, [memberId, businessId]);
    if (!m[0]) throw notFound();
    if (m[0].role_name === "Business Owner") throw forbidden("The owner's role cannot be changed");
    const { rows: role } = await c.query("SELECT id, name FROM roles WHERE id=$1 AND business_id=$2", [roleId, businessId]);
    if (!role[0]) throw badRequest("Unknown role for this business");
    if (role[0].name === "Business Owner") throw forbidden("Ownership cannot be assigned");
    await c.query("UPDATE business_members SET role_id=$1 WHERE id=$2", [roleId, memberId]);
    await audit({ actorId, businessId, action: "member.role_change", entity: "business_member", entityId: memberId,
      metadata: { from: m[0].role_name, to: role[0].name } }, c);
  });
}

export async function listAudit(businessId: string, limit: number, offset: number) {
  const { rows } = await pool.query(
    `SELECT a.id, a.action, a.entity, a.entity_id, a.metadata, a.created_at, u.full_name AS actor
       FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id
      WHERE a.business_id=$1 ORDER BY a.created_at DESC, a.id DESC LIMIT $2 OFFSET $3`, [businessId, limit, offset]);
  return rows;
}
void AppError;
