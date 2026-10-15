import bcrypt from "bcryptjs";
import { pool, tx } from "../../db.js";
import { randomToken } from "../../lib/crypto.js";
import { mails, sendMail } from "../../lib/email.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { audit } from "../audit/audit.service.js";
import { issueUserToken } from "../auth/auth.service.js";
import { notify } from "../notifications/notification.service.js";
import { assertWithin } from "../plans/plan.service.js";

export const publicEmployee = (r: any, includeSalary = false) => ({
  id: r.id, code: r.code, userId: r.user_id, fullName: r.full_name, email: r.email, position: r.position, department: r.department,
  phone: r.phone, joiningDate: r.joining_date, status: r.status, createdAt: r.created_at,
  ...(includeSalary ? { salaryConfig: r.method ? salaryCfg(r) : null } : {}),
});

export const salaryCfg = (r: any) => ({
  method: r.method, rate: Number(r.rate), standardHoursPerDay: Number(r.standard_hours_per_day),
  overtimeMultiplier: Number(r.overtime_multiplier), standardDaysPerMonth: Number(r.standard_days_per_month),
  latePenalty: Number(r.late_penalty),
});

const SELECT = `SELECT e.*, u.full_name, u.email, s.method, s.rate, s.standard_hours_per_day, s.overtime_multiplier,
                       s.standard_days_per_month, s.late_penalty
                  FROM employees e JOIN users u ON u.id = e.user_id LEFT JOIN salary_configs s ON s.employee_id = e.id`;

export async function createEmployee(businessId: string, actorId: string, input: any, ip?: string) {
  await assertWithin(businessId, "members");
  const { rows: bz } = await pool.query("SELECT name FROM businesses WHERE id=$1", [businessId]);
  const result = await tx(async (c) => {
    // Unusable random password; the employee sets their own through the emailed link.
    const hash = await bcrypt.hash(randomToken(), process.env.NODE_ENV === "test" ? 4 : 12);
    let user: any;
    try {
      const r = await c.query(
        `INSERT INTO users (email, password_hash, full_name, account_type) VALUES ($1,$2,$3,'employee') RETURNING *`,
        [input.email, hash, input.fullName]);
      user = r.rows[0];
    } catch (e: any) {
      if (e.code === "23505") throw conflict("A Blinxot account with this email already exists");
      throw e;
    }
    await c.query("INSERT INTO profiles (user_id, phone) VALUES ($1,$2)", [user.id, input.phone ?? null]);
    const { rows: role } = await c.query("SELECT id FROM roles WHERE business_id=$1 AND name='Employee'", [businessId]);
    await c.query("INSERT INTO business_members (business_id, user_id, role_id) VALUES ($1,$2,$3)", [businessId, user.id, role[0].id]);
    const { rows: emp } = await c.query(
      `INSERT INTO employees (business_id, user_id, position, department, phone, joining_date) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [businessId, user.id, input.position ?? null, input.department ?? null, input.phone ?? null, input.joiningDate ?? null]);
    if (input.salary) await upsertSalaryConfig(emp[0].id, businessId, input.salary, c);
    await audit({ actorId, businessId, action: "employee.create", entity: "employee", entityId: emp[0].id, metadata: { email: input.email } }, c);
    const token = await issueUserToken(user.id, "reset_password", 7 * 24 * 60, c as any);
    return { employeeId: emp[0].id as string, user, token };
  });
  await sendMail(mails.invite(result.user.email, result.user.full_name, bz[0].name, result.token));
  await notify(result.user.id, { type: "employee.invited", title: `Welcome to ${bz[0].name}`, body: "Your employee account is ready." });
  return getEmployee(businessId, result.employeeId, true);
}

export async function listEmployees(businessId: string, q: { limit: number; offset: number; q?: string; status?: string }) {
  const where = ["e.business_id = $1"]; const vals: any[] = [businessId];
  if (q.status) { vals.push(q.status); where.push(`e.status = $${vals.length}`); }
  if (q.q) { vals.push(`%${q.q}%`); where.push(`(e.code ILIKE $${vals.length} OR u.full_name ILIKE $${vals.length} OR u.email ILIKE $${vals.length} OR e.position ILIKE $${vals.length} OR e.department ILIKE $${vals.length})`); }
  const w = where.join(" AND ");
  const { rows: total } = await pool.query(`SELECT count(*)::int AS n FROM employees e JOIN users u ON u.id=e.user_id WHERE ${w}`, vals);
  vals.push(q.limit, q.offset);
  const { rows } = await pool.query(`${SELECT} WHERE ${w} ORDER BY u.full_name LIMIT $${vals.length - 1} OFFSET $${vals.length}`, vals);
  return { employees: rows.map((r) => publicEmployee(r)), total: total[0].n };
}

export async function getEmployee(businessId: string, employeeId: string, includeSalary: boolean) {
  const { rows } = await pool.query(`${SELECT} WHERE e.id=$1 AND e.business_id=$2`, [employeeId, businessId]);
  if (!rows[0]) throw notFound();
  return publicEmployee(rows[0], includeSalary);
}

export async function getEmployeeByUser(businessId: string, userId: string) {
  const { rows } = await pool.query(`${SELECT} WHERE e.user_id=$1 AND e.business_id=$2 AND e.status='active'`, [userId, businessId]);
  return rows[0] ?? null;
}

export async function updateEmployee(businessId: string, employeeId: string, actorId: string, patch: any, ip?: string) {
  const map: Record<string, string> = { position: "position", department: "department", phone: "phone", joiningDate: "joining_date" };
  const sets: string[] = []; const vals: any[] = [];
  for (const [k, col] of Object.entries(map)) if (k in patch) { vals.push(patch[k]); sets.push(`${col}=$${vals.length}`); }
  if (!sets.length) throw badRequest("Nothing to update");
  vals.push(employeeId, businessId);
  const { rowCount } = await pool.query(`UPDATE employees SET ${sets.join(", ")}, updated_at=now() WHERE id=$${vals.length - 1} AND business_id=$${vals.length}`, vals);
  if (!rowCount) throw notFound();
  await audit({ actorId, businessId, action: "employee.update", entity: "employee", entityId: employeeId, metadata: { fields: Object.keys(patch) }, ip });
  return getEmployee(businessId, employeeId, false);
}

// Soft-delete: keeps attendance/salary history, removes access to the business.
export async function deactivateEmployee(businessId: string, employeeId: string, actorId: string, ip?: string) {
  await tx(async (c) => {
    const { rows } = await c.query("UPDATE employees SET status='inactive', updated_at=now() WHERE id=$1 AND business_id=$2 RETURNING user_id", [employeeId, businessId]);
    if (!rows[0]) throw notFound();
    await c.query("UPDATE business_members SET status='removed' WHERE business_id=$1 AND user_id=$2", [businessId, rows[0].user_id]);
    // Close any open punch so hours don't accrue forever.
    await c.query(`UPDATE attendance SET punch_out = now(), minutes_worked = GREATEST(1, floor(extract(epoch FROM (now() - punch_in))/60)::int)
                    WHERE employee_id=$1 AND punch_out IS NULL`, [employeeId]);
    await audit({ actorId, businessId, action: "employee.deactivate", entity: "employee", entityId: employeeId, ip }, c);
  });
}

export async function upsertSalaryConfig(employeeId: string, businessId: string, cfg: any, db: any = pool) {
  await db.query(
    `INSERT INTO salary_configs (employee_id, business_id, method, rate, standard_hours_per_day, overtime_multiplier, standard_days_per_month, late_penalty)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (employee_id) DO UPDATE SET method=EXCLUDED.method, rate=EXCLUDED.rate,
       standard_hours_per_day=EXCLUDED.standard_hours_per_day, overtime_multiplier=EXCLUDED.overtime_multiplier,
       standard_days_per_month=EXCLUDED.standard_days_per_month, late_penalty=EXCLUDED.late_penalty, updated_at=now()`,
    [employeeId, businessId, cfg.method, cfg.rate, cfg.standardHoursPerDay ?? 8, cfg.overtimeMultiplier ?? 1.5, cfg.standardDaysPerMonth ?? 26, cfg.latePenalty ?? 0]);
}

export async function setSalaryConfig(businessId: string, employeeId: string, actorId: string, cfg: any, ip?: string) {
  const { rows } = await pool.query("SELECT 1 FROM employees WHERE id=$1 AND business_id=$2", [employeeId, businessId]);
  if (!rows[0]) throw notFound();
  await upsertSalaryConfig(employeeId, businessId, cfg);
  await audit({ actorId, businessId, action: "salary.config_change", entity: "employee", entityId: employeeId, metadata: { method: cfg.method }, ip });
  return getEmployee(businessId, employeeId, true);
}
