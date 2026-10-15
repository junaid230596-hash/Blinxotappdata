import { pool } from "../../db.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { audit } from "../audit/audit.service.js";
import { dailyRecords } from "../attendance/attendance.service.js";
import { salaryCfg } from "../employees/employee.service.js";
import { notify } from "../notifications/notification.service.js";
import { calculateSalary } from "./salary.calc.js";

export const publicRecord = (r: any) => ({
  id: r.id, code: r.code, employeeId: r.employee_id, employeeName: r.full_name, periodStart: r.period_start_text ?? r.period_start,
  periodEnd: r.period_end_text ?? r.period_end, method: r.method, hoursWorked: Number(r.hours_worked),
  daysWorked: Number(r.days_worked), overtimeHours: Number(r.overtime_hours), lateCount: r.late_count,
  basePay: Number(r.base_pay), overtimePay: Number(r.overtime_pay), bonus: Number(r.bonus), deductions: Number(r.deductions),
  lateDeductions: Number(r.late_deductions), netPay: Number(r.net_pay), status: r.status, notes: r.notes, createdAt: r.created_at,
});
const SEL = `SELECT s.*, s.period_start::text AS period_start_text, s.period_end::text AS period_end_text, u.full_name
               FROM salary_records s JOIN employees e ON e.id=s.employee_id JOIN users u ON u.id=e.user_id`;

export async function generate(businessId: string, actorId: string, input: any, save: boolean, ip?: string) {
  const { rows } = await pool.query(
    `SELECT e.id, s.method, s.rate, s.standard_hours_per_day, s.overtime_multiplier, s.standard_days_per_month, s.late_penalty
       FROM employees e LEFT JOIN salary_configs s ON s.employee_id=e.id WHERE e.id=$1 AND e.business_id=$2`, [input.employeeId, businessId]);
  if (!rows[0]) throw notFound("Employee not found");
  if (!rows[0].method) throw badRequest("Set this employee's salary configuration first");
  const spanDays = (Date.parse(input.periodEnd) - Date.parse(input.periodStart)) / 86_400_000;
  if (spanDays < 0) throw badRequest("Period end must be on or after period start");
  if (spanDays > 366) throw badRequest("Period cannot exceed one year");

  const { days, openSessions } = await dailyRecords(input.employeeId, input.periodStart, input.periodEnd);
  const calc = calculateSalary({ config: salaryCfg(rows[0]), days, bonus: input.bonus ?? 0, deductions: input.deductions ?? 0 });
  if (!save) return { calculation: calc, openSessions, saved: null };

  const { rows: saved } = await pool.query(
    `INSERT INTO salary_records (business_id, employee_id, period_start, period_end, method, hours_worked, days_worked, overtime_hours,
        late_count, base_pay, overtime_pay, bonus, deductions, late_deductions, net_pay, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT (employee_id, period_start, period_end) DO UPDATE SET method=EXCLUDED.method, hours_worked=EXCLUDED.hours_worked,
        days_worked=EXCLUDED.days_worked, overtime_hours=EXCLUDED.overtime_hours, late_count=EXCLUDED.late_count,
        base_pay=EXCLUDED.base_pay, overtime_pay=EXCLUDED.overtime_pay, bonus=EXCLUDED.bonus, deductions=EXCLUDED.deductions,
        late_deductions=EXCLUDED.late_deductions, net_pay=EXCLUDED.net_pay, notes=EXCLUDED.notes, updated_at=now()
      WHERE salary_records.status='draft' RETURNING id`,
    [businessId, input.employeeId, input.periodStart, input.periodEnd, calc.method, calc.hoursWorked, calc.daysWorked, calc.overtimeHours,
     calc.lateCount, calc.basePay, calc.overtimePay, calc.bonus, calc.deductions, calc.lateDeductions, calc.netPay, input.notes ?? null, actorId]);
  if (!saved[0]) throw conflict("A finalized or paid record already exists for this period");
  await audit({ actorId, businessId, action: "salary.generate", entity: "salary_record", entityId: saved[0].id, metadata: { net: calc.netPay }, ip });
  const { rows: full } = await pool.query(`${SEL} WHERE s.id=$1`, [saved[0].id]);
  return { calculation: calc, openSessions, saved: publicRecord(full[0]) };
}

export async function list(businessId: string, f: { employeeId?: string; status?: string; limit: number; offset: number }) {
  const where = ["s.business_id=$1"]; const v: any[] = [businessId];
  if (f.employeeId) { v.push(f.employeeId); where.push(`s.employee_id=$${v.length}`); }
  if (f.status) { v.push(f.status); where.push(`s.status=$${v.length}`); }
  const w = where.join(" AND ");
  const { rows: t } = await pool.query(`SELECT count(*)::int AS n FROM salary_records s WHERE ${w}`, v);
  v.push(f.limit, f.offset);
  const { rows } = await pool.query(`${SEL} WHERE ${w} ORDER BY s.period_start DESC, u.full_name LIMIT $${v.length - 1} OFFSET $${v.length}`, v);
  return { records: rows.map(publicRecord), total: t[0].n };
}

const NEXT: Record<string, string> = { draft: "finalized", finalized: "paid" };

export async function advanceStatus(businessId: string, id: string, to: string, actorId: string, ip?: string) {
  const { rows } = await pool.query("SELECT s.*, e.user_id FROM salary_records s JOIN employees e ON e.id=s.employee_id WHERE s.id=$1 AND s.business_id=$2", [id, businessId]);
  const cur = rows[0];
  if (!cur) throw notFound();
  if (NEXT[cur.status] !== to) throw badRequest(`Cannot move a ${cur.status} record to ${to}`);
  // Compare-and-set guards against concurrent transitions.
  const { rowCount } = await pool.query("UPDATE salary_records SET status=$1, updated_at=now() WHERE id=$2 AND status=$3", [to, id, cur.status]);
  if (!rowCount) throw conflict("Record changed, please refresh");
  await audit({ actorId, businessId, action: `salary.${to}`, entity: "salary_record", entityId: id, ip });
  await notify(cur.user_id, { type: `salary.${to}`, title: to === "paid" ? "Salary marked as paid" : "Salary statement ready",
    body: `Period ${cur.period_start.toISOString().slice(0, 10)} to ${cur.period_end.toISOString().slice(0, 10)}`, data: { salaryRecordId: id } });
  const { rows: full } = await pool.query(`${SEL} WHERE s.id=$1`, [id]);
  return publicRecord(full[0]);
}

// Employees only ever see their own statements, and only once finalized.
export async function mine(employeeId: string) {
  const { rows } = await pool.query(`${SEL} WHERE s.employee_id=$1 AND s.status IN ('finalized','paid') ORDER BY s.period_start DESC`, [employeeId]);
  return rows.map(publicRecord);
}
