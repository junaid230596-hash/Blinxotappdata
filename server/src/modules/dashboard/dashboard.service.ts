import { pool } from "../../db.js";
import { getSettings, myMonth, today as attendanceToday } from "../attendance/attendance.service.js";

const n = (v: any) => (v == null ? 0 : Number(v));
const one = async (sql: string, p: any[]) => (await pool.query(sql, p)).rows[0];

/**
 * Business dashboard. Each section is only computed (and returned) when the caller's role includes the permission
 * that would let them open the underlying screen, so the dashboard never reveals more than the app does.
 */
export async function businessDashboard(businessId: string, userId: string, perms: Set<string>) {
  const out: Record<string, any> = { sections: [] as string[] };
  const add = (name: string, value: any) => { out[name] = value; out.sections.push(name); };

  if (perms.has("orders.view")) {
    const [rev, byStatus, trend, recent] = await Promise.all([
      one(`SELECT COALESCE(sum(total) FILTER (WHERE delivered_at >= now() - interval '30 days'),0) AS last30,
                  COALESCE(sum(total) FILTER (WHERE delivered_at >= now() - interval '60 days' AND delivered_at < now() - interval '30 days'),0) AS prev30,
                  COALESCE(sum(total) FILTER (WHERE delivered_at >= date_trunc('month', now())),0) AS this_month,
                  count(*) FILTER (WHERE delivered_at >= now() - interval '30 days')::int AS sales30
             FROM orders WHERE business_id=$1 AND status IN ('delivered','returned')`, [businessId]),
      pool.query("SELECT status, count(*)::int AS c FROM orders WHERE business_id=$1 GROUP BY status", [businessId]),
      pool.query(
        `SELECT d::date::text AS day, COALESCE(sum(o.total),0) AS total FROM generate_series(current_date - 13, current_date, interval '1 day') d
           LEFT JOIN orders o ON o.business_id=$1 AND o.status IN ('delivered','returned') AND o.delivered_at::date = d::date GROUP BY d ORDER BY d`, [businessId]),
      pool.query(
        `SELECT o.id, o.order_number, o.status, o.total, o.created_at, COALESCE(c.name, bb.name, 'Walk-in') AS party FROM orders o
           LEFT JOIN customers c ON c.id=o.customer_id LEFT JOIN businesses bb ON bb.id=o.buyer_business_id WHERE o.business_id=$1 ORDER BY o.created_at DESC LIMIT 5`, [businessId]),
    ]);
    const st = Object.fromEntries(byStatus.rows.map((r) => [r.status, r.c]));
    add("sales", {
      revenueLast30Days: n(rev.last30), revenuePrevious30Days: n(rev.prev30), revenueThisMonth: n(rev.this_month), salesLast30Days: rev.sales30,
      trend: trend.rows.map((r) => ({ day: r.day, total: n(r.total) })),
    });
    add("orders", {
      byStatus: st, open: ["pending", "accepted", "processing", "ready", "dispatched"].reduce((a, k) => a + (st[k] ?? 0), 0), pending: st.pending ?? 0,
      recent: recent.rows.map((r) => ({ id: r.id, orderNumber: r.order_number, status: r.status, total: n(r.total), party: r.party, createdAt: r.created_at })),
    });
  }

  if (perms.has("inventory.view")) {
    const [tot, low] = await Promise.all([
      one(`SELECT count(*)::int AS products, count(*) FILTER (WHERE stock_qty <= min_stock)::int AS low,
                  COALESCE(sum(stock_qty * cost_price),0) AS stock_value FROM products WHERE business_id=$1 AND status='active'`, [businessId]),
      pool.query(`SELECT id, name, sku, stock_qty, min_stock, unit FROM products WHERE business_id=$1 AND status='active' AND stock_qty <= min_stock ORDER BY (stock_qty - min_stock), name LIMIT 5`, [businessId]),
    ]);
    add("inventory", {
      products: tot.products, lowStockCount: tot.low,
      ...(perms.has("reports.view") ? { stockValue: n(tot.stock_value) } : {}),          // cost data stays behind reports.view
      lowStock: low.rows.map((r) => ({ id: r.id, name: r.name, sku: r.sku, unit: r.unit, stockQty: n(r.stock_qty), minStock: n(r.min_stock) })),
    });
  }

  if (perms.has("purchases.view")) {
    const [p, s] = await Promise.all([
      one(`SELECT count(*) FILTER (WHERE status IN ('sent','accepted','partially_received'))::int AS pending,
                  COALESCE(sum(total) FILTER (WHERE status NOT IN ('draft','cancelled') AND created_at >= now() - interval '30 days'),0) AS last30 FROM purchases WHERE business_id=$1`, [businessId]),
      one("SELECT count(*)::int AS c FROM suppliers WHERE business_id=$1 AND status='active'", [businessId]),
    ]);
    add("purchasing", { pendingPurchases: p.pending, purchasedLast30Days: n(p.last30), suppliers: s.c });
  }

  if (perms.has("customers.view")) add("customers", { total: (await one("SELECT count(*)::int AS c FROM customers WHERE business_id=$1 AND status='active'", [businessId])).c });

  if (perms.has("employees.view") || perms.has("attendance.view")) {
    const tz = (await getSettings(businessId)).timezone;
    const r = await one(
      `SELECT (SELECT count(*)::int FROM employees WHERE business_id=$1 AND status='active') AS employees,
              (SELECT count(DISTINCT employee_id)::int FROM attendance WHERE business_id=$1 AND work_date = (now() AT TIME ZONE $2)::date) AS present,
              (SELECT count(*)::int FROM attendance WHERE business_id=$1 AND punch_out IS NULL) AS clocked_in,
              (SELECT count(*)::int FROM leave_requests WHERE business_id=$1 AND status='approved' AND (now() AT TIME ZONE $2)::date BETWEEN start_date AND end_date) AS on_leave`, [businessId, tz]);
    add("people", { employees: r.employees, presentToday: r.present, clockedInNow: r.clocked_in, onLeaveToday: r.on_leave });
  }

  if (perms.has("tasks.view")) {
    const manage = perms.has("tasks.manage");
    const r = await one(
      `SELECT count(*) FILTER (WHERE status NOT IN ('completed','cancelled'))::int AS open,
              count(*) FILTER (WHERE status NOT IN ('completed','cancelled') AND due_date < current_date)::int AS overdue
         FROM tasks WHERE business_id=$1 ${manage ? "" : "AND assigned_to=$2"}`, manage ? [businessId] : [businessId, userId]);
    add("tasks", { open: r.open, overdue: r.overdue, scope: manage ? "all" : "mine" });
  }

  if (perms.has("crm.view")) {
    const r = await one(
      `SELECT count(*) FILTER (WHERE s.kind='open')::int AS open, COALESCE(sum(d.value) FILTER (WHERE s.kind='open'),0) AS open_value,
              COALESCE(sum(d.value) FILTER (WHERE s.kind='won' AND d.closed_at >= date_trunc('month', now())),0) AS won_month,
              (SELECT count(*)::int FROM crm_leads WHERE business_id=$1 AND status='new') AS new_leads
         FROM crm_deals d JOIN crm_pipeline_stages s ON s.id=d.stage_id WHERE d.business_id=$1`, [businessId]);
    add("crm", { openDeals: r.open, openPipelineValue: n(r.open_value), wonThisMonth: n(r.won_month), newLeads: r.new_leads });
  }

  if (perms.has("leave.manage")) add("leave", { pendingRequests: (await one("SELECT count(*)::int AS c FROM leave_requests WHERE business_id=$1 AND status='pending'", [businessId])).c });

  if (perms.has("audit.view")) {
    const { rows } = await pool.query(
      `SELECT a.id, a.action, a.entity, a.created_at, u.full_name AS actor FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id WHERE a.business_id=$1 ORDER BY a.id DESC LIMIT 10`, [businessId]);
    add("recentActivity", rows.map((r) => ({ id: Number(r.id), action: r.action, entity: r.entity, actor: r.actor, createdAt: r.created_at })));
  }

  out.unreadNotifications = (await one("SELECT count(*)::int AS c FROM notifications WHERE user_id=$1 AND read_at IS NULL", [userId])).c;
  return out;
}

/** Employee dashboard: today's attendance, hours this month, own tasks, latest pay statement, leave and reviews. */
export async function employeeDashboard(businessId: string, employeeId: string, userId: string) {
  const month = new Date().toISOString().slice(0, 7);
  const [todayRes, monthRes, tasks, nextTasks, pay, leave, reviews, notif] = await Promise.all([
    attendanceToday(businessId, employeeId),
    myMonth(employeeId, month),
    one(`SELECT count(*) FILTER (WHERE status NOT IN ('completed','cancelled'))::int AS open,
                count(*) FILTER (WHERE status NOT IN ('completed','cancelled') AND due_date < current_date)::int AS overdue FROM tasks WHERE business_id=$1 AND assigned_to=$2`, [businessId, userId]),
    pool.query(`SELECT id, title, priority, status, due_date::text AS due FROM tasks WHERE business_id=$1 AND assigned_to=$2 AND status NOT IN ('completed','cancelled')
                 ORDER BY due_date NULLS LAST, created_at LIMIT 5`, [businessId, userId]),
    pool.query(`SELECT period_start::text AS ps, period_end::text AS pe, net_pay, status FROM salary_records WHERE employee_id=$1 AND status IN ('finalized','paid') ORDER BY period_end DESC LIMIT 1`, [employeeId]),
    one(`SELECT count(*) FILTER (WHERE status='pending')::int AS pending,
                (SELECT start_date::text FROM leave_requests WHERE employee_id=$1 AND status='approved' AND end_date >= current_date ORDER BY start_date LIMIT 1) AS next_leave
           FROM leave_requests WHERE employee_id=$1`, [employeeId]),
    one("SELECT count(*)::int AS c FROM performance_reviews WHERE employee_id=$1 AND status='shared' AND acknowledged_at IS NULL", [employeeId]),
    one("SELECT count(*)::int AS c FROM notifications WHERE user_id=$1 AND read_at IS NULL", [userId]),
  ]);
  return {
    attendance: { punchedIn: todayRes.punchedIn, minutesToday: todayRes.minutesToday, since: todayRes.openSession?.punchIn ?? null },
    month: { month, ...monthRes.summary },
    tasks: { open: tasks.open, overdue: tasks.overdue, next: nextTasks.rows.map((t) => ({ id: t.id, title: t.title, priority: t.priority, status: t.status, dueDate: t.due })) },
    latestPay: pay.rows[0] ? { periodStart: pay.rows[0].ps, periodEnd: pay.rows[0].pe, netPay: n(pay.rows[0].net_pay), status: pay.rows[0].status } : null,
    leave: { pending: leave.pending, nextApprovedStart: leave.next_leave },
    unacknowledgedReviews: reviews.c, unreadNotifications: notif.c,
  };
}
