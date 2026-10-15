import { pool, tx } from "../../db.js";
import { AppError, badRequest, conflict, notFound } from "../../lib/errors.js";
import { audit } from "../audit/audit.service.js";

const COOLDOWN_SECONDS = 30; // blocks accidental double-taps right after a punch-out

export interface Settings { timezone: string; workStart: string; workEnd: string; lateGraceMinutes: number }

export async function getSettings(businessId: string): Promise<Settings> {
  const { rows } = await pool.query("SELECT * FROM business_settings WHERE business_id=$1", [businessId]);
  const r = rows[0];
  return {
    timezone: r?.timezone ?? "Asia/Kolkata",
    workStart: (r?.work_start ?? "09:30:00").slice(0, 5),
    workEnd: (r?.work_end ?? "18:00:00").slice(0, 5),
    lateGraceMinutes: r?.late_grace_minutes ?? 10,
  };
}

export async function putSettings(businessId: string, actorId: string, s: Settings, ip?: string) {
  const { rows } = await pool.query("SELECT 1 FROM pg_timezone_names WHERE name=$1", [s.timezone]);
  if (!rows[0]) throw badRequest("Unknown timezone");
  await pool.query(
    `INSERT INTO business_settings (business_id, timezone, work_start, work_end, late_grace_minutes) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (business_id) DO UPDATE SET timezone=$2, work_start=$3, work_end=$4, late_grace_minutes=$5, updated_at=now()`,
    [businessId, s.timezone, s.workStart, s.workEnd, s.lateGraceMinutes]);
  await audit({ actorId, businessId, action: "attendance.settings_change", entity: "business", entityId: businessId, metadata: { ...s }, ip });
  return getSettings(businessId);
}

export const publicRecord = (r: any) => ({
  id: r.id, employeeId: r.employee_id, employeeName: r.full_name, workDate: r.work_date_text ?? r.work_date,
  punchIn: r.punch_in, punchOut: r.punch_out, minutesWorked: r.minutes_worked, isLate: r.is_late, leftEarly: r.left_early,
});
const SEL = `SELECT a.*, a.work_date::text AS work_date_text, u.full_name FROM attendance a
               JOIN employees e ON e.id=a.employee_id JOIN users u ON u.id=e.user_id`;

// `at` exists so tests can control the clock; HTTP handlers never pass it (server time only).
export async function punchIn(businessId: string, employeeId: string, at: Date = new Date()) {
  const s = await getSettings(businessId);
  return tx(async (c) => {
    const { rows: recent } = await c.query(
      "SELECT 1 FROM attendance WHERE employee_id=$1 AND punch_out IS NOT NULL AND punch_out > ($2::timestamptz - ($3 || ' seconds')::interval)",
      [employeeId, at, String(COOLDOWN_SECONDS)]);
    if (recent[0]) throw new AppError(429, "TOO_SOON", "You just punched out. Please wait a moment.");
    try {
      const { rows } = await c.query(
        `WITH t AS (SELECT ($1::timestamptz AT TIME ZONE $2) AS local)
         INSERT INTO attendance (business_id, employee_id, work_date, punch_in, is_late)
         SELECT $3, $4, t.local::date, $1,
                (NOT EXISTS (SELECT 1 FROM attendance WHERE employee_id=$4 AND work_date=t.local::date)
                 AND t.local::time > ($5::time + ($6 || ' minutes')::interval))
           FROM t RETURNING id`,
        [at, s.timezone, businessId, employeeId, s.workStart, String(s.lateGraceMinutes)]);
      const { rows: full } = await c.query(`${SEL} WHERE a.id=$1`, [rows[0].id]);
      return publicRecord(full[0]);
    } catch (e: any) {
      if (e.code === "23505") throw conflict("You are already punched in. If you forgot to punch out earlier, ask a manager to correct it.");
      throw e;
    }
  });
}

export async function punchOut(businessId: string, employeeId: string, at: Date = new Date()) {
  const s = await getSettings(businessId);
  const { rows } = await pool.query(
    `WITH t AS (SELECT ($1::timestamptz AT TIME ZONE $2) AS local)
     UPDATE attendance a SET punch_out=$1,
       minutes_worked = GREATEST(1, floor(extract(epoch FROM ($1::timestamptz - a.punch_in))/60)::int),
       left_early = (t.local::date = a.work_date AND t.local::time < $3::time)
       FROM t WHERE a.employee_id=$4 AND a.business_id=$5 AND a.punch_out IS NULL AND a.punch_in < $1
       RETURNING a.id`, [at, s.timezone, s.workEnd, employeeId, businessId]);
  if (!rows[0]) {
    const { rows: open } = await pool.query("SELECT 1 FROM attendance WHERE employee_id=$1 AND punch_out IS NULL", [employeeId]);
    throw open[0] ? badRequest("Invalid punch-out time") : conflict("You are not punched in");
  }
  const { rows: full } = await pool.query(`${SEL} WHERE a.id=$1`, [rows[0].id]);
  return publicRecord(full[0]);
}

export async function today(businessId: string, employeeId: string, at: Date = new Date()) {
  const s = await getSettings(businessId);
  const { rows } = await pool.query(
    `${SEL} WHERE a.employee_id=$1 AND a.work_date = ($2::timestamptz AT TIME ZONE $3)::date ORDER BY a.punch_in`, [employeeId, at, s.timezone]);
  const records = rows.map(publicRecord);
  const open = records.find((r) => !r.punchOut) ?? null;
  const closedMinutes = records.reduce((n, r) => n + (r.minutesWorked ?? 0), 0);
  const liveMinutes = open ? Math.max(0, Math.floor((at.getTime() - new Date(open.punchIn).getTime()) / 60000)) : 0;
  return { punchedIn: !!open, openSession: open, sessions: records, minutesToday: closedMinutes + liveMinutes };
}

export function monthRange(month: string) {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

export async function listRecords(businessId: string, f: { from?: string; to?: string; employeeId?: string; limit: number; offset: number }) {
  const where = ["a.business_id=$1"]; const v: any[] = [businessId];
  if (f.from) { v.push(f.from); where.push(`a.work_date >= $${v.length}`); }
  if (f.to) { v.push(f.to); where.push(`a.work_date <= $${v.length}`); }
  if (f.employeeId) { v.push(f.employeeId); where.push(`a.employee_id = $${v.length}`); }
  const w = where.join(" AND ");
  const { rows: t } = await pool.query(`SELECT count(*)::int AS n FROM attendance a WHERE ${w}`, v);
  v.push(f.limit, f.offset);
  const { rows } = await pool.query(`${SEL} WHERE ${w} ORDER BY a.punch_in DESC LIMIT $${v.length - 1} OFFSET $${v.length}`, v);
  return { records: rows.map(publicRecord), total: t[0].n };
}

export async function myMonth(employeeId: string, month: string) {
  const { from, to } = monthRange(month);
  const { rows } = await pool.query(`${SEL} WHERE a.employee_id=$1 AND a.work_date BETWEEN $2 AND $3 ORDER BY a.punch_in`, [employeeId, from, to]);
  const days = new Map<string, { minutes: number; late: boolean }>();
  for (const r of rows) {
    const d = days.get(r.work_date_text) ?? { minutes: 0, late: false };
    d.minutes += r.minutes_worked ?? 0; d.late = d.late || r.is_late; days.set(r.work_date_text, d);
  }
  return {
    month, records: rows.map(publicRecord),
    summary: { daysPresent: days.size, hoursWorked: Math.round([...days.values()].reduce((n, d) => n + d.minutes, 0) / 60 * 100) / 100,
               lateDays: [...days.values()].filter((d) => d.late).length },
  };
}

// Per-employee summary for a date range (business-wide report)
export async function report(businessId: string, from: string, to: string) {
  const { rows } = await pool.query(
    `WITH daily AS (
       SELECT employee_id, work_date, sum(COALESCE(minutes_worked,0)) AS minutes, bool_or(is_late) AS late,
              (array_agg(left_early ORDER BY punch_in DESC))[1] AS left_early
         FROM attendance WHERE business_id=$1 AND work_date BETWEEN $2 AND $3 GROUP BY employee_id, work_date)
     SELECT e.id, u.full_name, e.position, e.status,
            count(d.work_date)::int AS days_present,
            COALESCE(round(sum(d.minutes)/60.0, 2), 0) AS hours_worked,
            count(*) FILTER (WHERE d.late)::int AS late_days,
            count(*) FILTER (WHERE d.left_early)::int AS early_departure_days
       FROM employees e JOIN users u ON u.id=e.user_id LEFT JOIN daily d ON d.employee_id=e.id
      WHERE e.business_id=$1 AND (e.status='active' OR d.work_date IS NOT NULL)
      GROUP BY e.id, u.full_name ORDER BY u.full_name`, [businessId, from, to]);
  return rows.map((r) => ({
    employeeId: r.id, fullName: r.full_name, position: r.position, status: r.status, daysPresent: r.days_present,
    hoursWorked: Number(r.hours_worked), lateDays: r.late_days, earlyDepartureDays: r.early_departure_days,
  }));
}

// Manager correction (e.g. forgotten punch-out). Recomputes derived fields and rejects overlaps.
export async function correctRecord(businessId: string, recordId: string, actorId: string, patch: { punchIn?: Date; punchOut?: Date }, ip?: string) {
  const s = await getSettings(businessId);
  return tx(async (c) => {
    const { rows } = await c.query("SELECT * FROM attendance WHERE id=$1 AND business_id=$2 FOR UPDATE", [recordId, businessId]);
    const cur = rows[0];
    if (!cur) throw notFound();
    const pin = patch.punchIn ?? cur.punch_in;
    const pout = patch.punchOut ?? cur.punch_out;
    if (pout && new Date(pout) <= new Date(pin)) throw badRequest("Punch-out must be after punch-in");
    if (new Date(pin).getTime() > Date.now() + 5 * 60_000 || (pout && new Date(pout).getTime() > Date.now() + 5 * 60_000)) throw badRequest("Times cannot be in the future");
    const { rows: overlap } = await c.query(
      `SELECT 1 FROM attendance WHERE employee_id=$1 AND id<>$2
         AND tstzrange(punch_in, COALESCE(punch_out,'infinity'), '[)') && tstzrange($3::timestamptz, COALESCE($4::timestamptz,'infinity'), '[)')`,
      [cur.employee_id, recordId, pin, pout]);
    if (overlap[0]) throw conflict("This overlaps another attendance session");
    await c.query(
      `WITH t AS (SELECT ($1::timestamptz AT TIME ZONE $2) AS lin, (CASE WHEN $3::timestamptz IS NULL THEN NULL ELSE $3::timestamptz AT TIME ZONE $2 END) AS lout)
       UPDATE attendance a SET punch_in=$1, punch_out=$3, work_date=t.lin::date,
         minutes_worked = CASE WHEN $3::timestamptz IS NULL THEN NULL ELSE GREATEST(1, floor(extract(epoch FROM ($3::timestamptz - $1::timestamptz))/60)::int) END,
         is_late = (NOT EXISTS (SELECT 1 FROM attendance x WHERE x.employee_id=a.employee_id AND x.id<>a.id AND x.work_date=t.lin::date AND x.punch_in < $1)
                    AND t.lin::time > ($4::time + ($5 || ' minutes')::interval)),
         left_early = (t.lout IS NOT NULL AND t.lout::date = t.lin::date AND t.lout::time < $6::time),
         edited_by=$7
       FROM t WHERE a.id=$8`, [pin, s.timezone, pout, s.workStart, String(s.lateGraceMinutes), s.workEnd, actorId, recordId]);
    await audit({ actorId, businessId, action: "attendance.correct", entity: "attendance", entityId: recordId,
      metadata: { before: { punchIn: cur.punch_in, punchOut: cur.punch_out }, after: { punchIn: pin, punchOut: pout } }, ip }, c);
    const { rows: full } = await c.query(`${SEL} WHERE a.id=$1`, [recordId]);
    return publicRecord(full[0]);
  });
}

export async function dailyRecords(employeeId: string, from: string, to: string) {
  const { rows } = await pool.query(
    `SELECT work_date::text AS date, sum(minutes_worked)::int AS minutes, bool_or(is_late) AS late
       FROM attendance WHERE employee_id=$1 AND work_date BETWEEN $2 AND $3 AND punch_out IS NOT NULL
      GROUP BY work_date ORDER BY work_date`, [employeeId, from, to]);
  const { rows: open } = await pool.query(
    "SELECT count(*)::int AS n FROM attendance WHERE employee_id=$1 AND work_date BETWEEN $2 AND $3 AND punch_out IS NULL", [employeeId, from, to]);
  return { days: rows.map((r) => ({ date: r.date as string, minutes: r.minutes as number, late: !!r.late })), openSessions: open[0].n as number };
}
