import crypto from "node:crypto";
import { pool, tx } from "../../db.js";
import { AppError, badRequest, forbidden, notFound } from "../../lib/errors.js";
import { experienceMonths } from "../../lib/experience.js";
import { cleanSkills } from "../../lib/skills.js";
import { buildSets } from "../../lib/sql.js";
import { audit } from "../audit/audit.service.js";
import { ratingSummary } from "../reviews/review.service.js";

export const camel = (r: Record<string, any>) =>
  Object.fromEntries(Object.entries(r).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), v]));

// ---------- generic profile entries (experience, education, certifications, projects) ----------
export type EntryKind = "experience" | "education" | "certifications" | "projects";
const ENTRY: Record<EntryKind, { table: string; select: string; cols: Record<string, string>; order: string }> = {
  experience: { table: "work_experience", order: "start_date DESC, created_at DESC",
    select: "id, company, role, start_date::text AS start_date, end_date::text AS end_date, responsibilities, achievements, skills",
    cols: { company: "company", role: "role", startDate: "start_date", endDate: "end_date", responsibilities: "responsibilities", achievements: "achievements", skills: "skills" } },
  education: { table: "education", order: "end_year DESC NULLS FIRST, start_year DESC NULLS LAST, created_at DESC",
    select: "id, institution, degree, field_of_study, start_year, end_year",
    cols: { institution: "institution", degree: "degree", fieldOfStudy: "field_of_study", startYear: "start_year", endYear: "end_year" } },
  certifications: { table: "certifications", order: "issued_on DESC NULLS LAST, created_at DESC",
    select: "id, name, issuer, issued_on::text AS issued_on, expires_on::text AS expires_on, url",
    cols: { name: "name", issuer: "issuer", issuedOn: "issued_on", expiresOn: "expires_on", url: "url" } },
  projects: { table: "projects", order: "created_at DESC",
    select: "id, title, description, url, skills", cols: { title: "title", description: "description", url: "url", skills: "skills" } },
};
const MAX_ENTRIES = 50;

export async function listEntries(kind: EntryKind, userId: string) {
  const e = ENTRY[kind];
  const { rows } = await pool.query(`SELECT ${e.select} FROM ${e.table} WHERE user_id=$1 ORDER BY ${e.order}`, [userId]);
  return rows.map(camel);
}

export async function createEntry(kind: EntryKind, userId: string, input: any) {
  const e = ENTRY[kind];
  const d = { ...input }; if (d.skills) d.skills = cleanSkills(d.skills);
  const { rows: n } = await pool.query(`SELECT count(*)::int AS n FROM ${e.table} WHERE user_id=$1`, [userId]);
  if (n[0].n >= MAX_ENTRIES) throw badRequest(`You can keep up to ${MAX_ENTRIES} entries in this section`);
  const cols = ["user_id"]; const vals: any[] = [userId];
  for (const [k, col] of Object.entries(e.cols)) if (d[k] !== undefined) { cols.push(col); vals.push(d[k] === "" ? null : d[k]); }
  try {
    const { rows } = await pool.query(`INSERT INTO ${e.table} (${cols.join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")}) RETURNING id`, vals);
    return getEntry(kind, userId, rows[0].id);
  } catch (err: any) { if (err.code === "23514") throw badRequest("Dates are inconsistent (the end cannot be before the start)"); throw err; }
}

async function getEntry(kind: EntryKind, userId: string, id: string) {
  const e = ENTRY[kind];
  const { rows } = await pool.query(`SELECT ${e.select} FROM ${e.table} WHERE id=$1 AND user_id=$2`, [id, userId]);
  if (!rows[0]) throw notFound();
  return camel(rows[0]);
}

export async function updateEntry(kind: EntryKind, userId: string, id: string, patch: any) {
  const e = ENTRY[kind];
  const d = { ...patch }; if (d.skills) d.skills = cleanSkills(d.skills);
  const { sets, vals } = buildSets(e.cols, d);
  if (!sets.length) throw badRequest("Nothing to update");
  vals.push(id, userId);
  try {
    const r = await pool.query(`UPDATE ${e.table} SET ${sets.join(", ")} WHERE id=$${vals.length - 1} AND user_id=$${vals.length}`, vals);
    if (!r.rowCount) throw notFound();
  } catch (err: any) { if (err.code === "23514") throw badRequest("Dates are inconsistent (the end cannot be before the start)"); throw err; }
  return getEntry(kind, userId, id);
}

export async function deleteEntry(kind: EntryKind, userId: string, id: string) {
  const r = await pool.query(`DELETE FROM ${ENTRY[kind].table} WHERE id=$1 AND user_id=$2`, [id, userId]);
  if (!r.rowCount) throw notFound();
}

// ---------- profile ----------
export async function getSkills(userId: string): Promise<string[]> {
  const { rows } = await pool.query("SELECT name::text AS name FROM user_skills WHERE user_id=$1 ORDER BY lower(name::text)", [userId]);
  return rows.map((r) => r.name);
}

export async function setSkills(userId: string, names: string[]) {
  const list = cleanSkills(names, 50);
  await tx(async (c) => {
    await c.query("DELETE FROM user_skills WHERE user_id=$1", [userId]);
    for (const s of list) await c.query("INSERT INTO user_skills (user_id, name) VALUES ($1,$2) ON CONFLICT DO NOTHING", [userId, s]);
  });
  return getSkills(userId);
}

export async function completion(userId: string, p?: any, skills?: string[]) {
  const prof = p ?? (await pool.query("SELECT * FROM profiles WHERE user_id=$1", [userId])).rows[0];
  const sk = skills ?? (await getSkills(userId));
  const count = async (t: string) => (await pool.query(`SELECT count(*)::int AS n FROM ${t} WHERE user_id=$1`, [userId])).rows[0].n as number;
  const [exp, edu, cert, proj] = await Promise.all([count("work_experience"), count("education"), count("certifications"), count("projects")]);
  const checks: [string, number, boolean][] = [
    ["Add a headline", 10, !!prof.headline], ["Write a short bio", 15, !!prof.bio], ["Add your city", 5, !!prof.city], ["Upload a profile photo", 10, !!prof.avatar_url],
    ["Add at least 3 skills", 15, sk.length >= 3], ["Add work experience", 20, exp >= 1], ["Add education", 10, edu >= 1],
    ["Add a resume, certification or project", 15, !!prof.resume_url || cert + proj >= 1],
  ];
  return { percent: checks.reduce((n, [, w, ok]) => n + (ok ? w : 0), 0), missing: checks.filter(([, , ok]) => !ok).map(([l]) => l) };
}

export async function getProfile(userId: string) {
  const { rows } = await pool.query(
    `SELECT u.full_name, u.email, u.account_type, u.email_verified_at, p.* FROM users u JOIN profiles p ON p.user_id=u.id WHERE u.id=$1`, [userId]);
  const r = rows[0];
  if (!r) throw notFound();
  const skills = await getSkills(userId);
  return {
    userId, fullName: r.full_name, email: r.email, phone: r.phone, headline: r.headline, bio: r.bio, city: r.city, avatarUrl: r.avatar_url, resumeUrl: r.resume_url,
    availability: r.availability, isPublic: r.is_public, slug: r.slug, skills, completion: await completion(userId, r, skills),
  };
}

async function uniqueSlug(name: string) {
  const base = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "member";
  for (let i = 0; i < 5; i++) {
    const slug = `${base}-${crypto.randomBytes(3).toString("hex")}`;
    const { rows } = await pool.query("SELECT 1 FROM profiles WHERE slug=$1", [slug]);
    if (!rows[0]) return slug;
  }
  throw new AppError(500, "INTERNAL", "Could not allocate a profile URL");
}

export async function updateProfile(user: { id: string; emailVerified: boolean }, patch: any, ip?: string) {
  if (patch.isPublic === true && !user.emailVerified) throw forbidden("Verify your email before making your profile public");
  const { sets, vals } = buildSets({ headline: "headline", bio: "bio", city: "city", phone: "phone", avatarUrl: "avatar_url", resumeUrl: "resume_url", availability: "availability", isPublic: "is_public" }, patch);
  if (!sets.length) throw badRequest("Nothing to update");
  if (patch.isPublic === true) {
    const { rows } = await pool.query("SELECT p.slug, u.full_name FROM profiles p JOIN users u ON u.id=p.user_id WHERE p.user_id=$1", [user.id]);
    if (!rows[0].slug) { vals.push(await uniqueSlug(rows[0].full_name)); sets.push(`slug=$${vals.length}`); }
  }
  vals.push(user.id);
  await pool.query(`UPDATE profiles SET ${sets.join(", ")}, updated_at=now() WHERE user_id=$${vals.length}`, vals);
  await audit({ actorId: user.id, action: "profile.update", entity: "profile", entityId: user.id, metadata: { fields: Object.keys(patch) }, ip });
  return getProfile(user.id);
}

// ---------- resume ----------
export async function resume(userId: string, includeContact: boolean) {
  const [p, skills, experience, education, certifications, projects] = await Promise.all([
    getProfile(userId), getSkills(userId), listEntries("experience", userId), listEntries("education", userId),
    listEntries("certifications", userId), listEntries("projects", userId),
  ]);
  const months = experienceMonths(experience.map((e: any) => ({ start: e.startDate, end: e.endDate })));
  return {
    name: p.fullName, headline: p.headline, bio: p.bio, city: p.city, avatarUrl: p.avatarUrl, availability: p.availability,
    ...(includeContact ? { email: p.email, phone: p.phone, resumeUrl: p.resumeUrl } : {}),
    skills, experience, education, certifications, projects,
    totalExperienceMonths: months, totalExperience: `${Math.floor(months / 12)} yrs ${months % 12} mos`,
  };
}

export async function publicPerson(slug: string) {
  const { rows } = await pool.query("SELECT user_id FROM profiles WHERE slug=$1 AND is_public", [slug]);
  if (!rows[0]) throw notFound();
  const r = await resume(rows[0].user_id, false);
  return { ...r, slug, rating: await ratingSummary({ type: "individual", id: rows[0].user_id }) };
}

export async function dashboard(userId: string) {
  const [prof, apps, exp, notif, recs, rating] = await Promise.all([
    getProfile(userId),
    pool.query("SELECT status, count(*)::int AS n FROM applications WHERE user_id=$1 GROUP BY status", [userId]),
    pool.query("SELECT count(*)::int AS n FROM work_experience WHERE user_id=$1", [userId]),
    pool.query("SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND read_at IS NULL", [userId]),
    pool.query(
      `SELECT j.id, j.title, j.location, j.work_type, b.name AS business_name FROM jobs j JOIN businesses b ON b.id=j.business_id AND b.is_public AND b.status='active'
        WHERE j.status='open' AND (j.deadline IS NULL OR j.deadline >= CURRENT_DATE)
          AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.job_id=j.id AND a.user_id=$1)
          AND EXISTS (SELECT 1 FROM unnest(j.skills) js JOIN user_skills us ON lower(js)=lower(us.name::text) AND us.user_id=$1)
        ORDER BY j.published_at DESC LIMIT 5`, [userId]),
    ratingSummary({ type: "individual", id: userId }),
  ]);
  const byStatus = Object.fromEntries(apps.rows.map((r) => [r.status, r.n]));
  return {
    completion: prof.completion, skillsCount: prof.skills.length, experienceCount: exp.rows[0].n,
    applications: { total: Object.values(byStatus).reduce((a: number, b: any) => a + b, 0), byStatus },
    rating, unreadNotifications: notif.rows[0].n,
    recommendedJobs: recs.rows.map((r) => ({ id: r.id, title: r.title, location: r.location, workType: r.work_type, businessName: r.business_name })),
  };
}
