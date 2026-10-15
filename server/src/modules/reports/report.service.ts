import { pool } from "../../db.js";
import { report as attendanceReport } from "../attendance/attendance.service.js";

export type ColType = "text" | "number" | "money" | "date" | "percent";
export interface Column { key: string; label: string; type: ColType }
export interface Report { title: string; columns: Column[]; rows: Record<string, any>[]; summary?: Record<string, number | string> }
export interface Range { from: string; to: string }
interface Def { title: string; needs: string[]; run: (businessId: string, r: Range) => Promise<Report> }

const num = (v: any) => (v == null ? 0 : Number(v));
const round2 = (n: number) => Math.round(n * 100) / 100;
const sum = (rows: any[], k: string) => round2(rows.reduce((n, r) => n + num(r[k]), 0));
const TO = "$3::date + 1";                      // exclusive upper bound so the whole "to" day is included

const DEFS: Record<string, Def> = {
  sales: { title: "Sales report", needs: ["orders.view"], run: async (b, r) => {
    const { rows } = await pool.query(
      `SELECT o.order_number, o.delivered_at::date::text AS date, COALESCE(c.name, bb.name, 'Walk-in') AS party, o.status, o.total,
              COALESCE((SELECT sum(x.refund_total) FROM order_returns x WHERE x.order_id=o.id),0) AS refunds
         FROM orders o LEFT JOIN customers c ON c.id=o.customer_id LEFT JOIN businesses bb ON bb.id=o.buyer_business_id
        WHERE o.business_id=$1 AND o.status IN ('delivered','returned') AND o.delivered_at >= $2::date AND o.delivered_at < ${TO} ORDER BY o.delivered_at, o.order_number`, [b, r.from, r.to]);
    const data = rows.map((x) => ({ orderNumber: x.order_number, date: x.date, party: x.party, status: x.status, total: num(x.total), refunds: num(x.refunds), net: round2(num(x.total) - num(x.refunds)) }));
    return { title: "Sales report", rows: data,
      columns: [{ key: "orderNumber", label: "Order", type: "text" }, { key: "date", label: "Delivered", type: "date" }, { key: "party", label: "Customer", type: "text" }, { key: "status", label: "Status", type: "text" },
        { key: "total", label: "Total", type: "money" }, { key: "refunds", label: "Refunds", type: "money" }, { key: "net", label: "Net", type: "money" }],
      summary: { orders: data.length, grossSales: sum(data, "total"), refunds: sum(data, "refunds"), netSales: sum(data, "net") } };
  } },
  purchases: { title: "Purchase report", needs: ["purchases.view"], run: async (b, r) => {
    const { rows } = await pool.query(
      `SELECT p.po_number, p.created_at::date::text AS date, s.name AS supplier, p.status, p.total,
              COALESCE((SELECT round(100.0 * sum(i.received_qty) / NULLIF(sum(i.quantity),0), 1) FROM purchase_items i WHERE i.purchase_id=p.id),0) AS received_pct
         FROM purchases p JOIN suppliers s ON s.id=p.supplier_id WHERE p.business_id=$1 AND p.created_at >= $2::date AND p.created_at < ${TO} ORDER BY p.created_at, p.po_number`, [b, r.from, r.to]);
    const data = rows.map((x) => ({ poNumber: x.po_number, date: x.date, supplier: x.supplier, status: x.status, total: num(x.total), receivedPct: num(x.received_pct) }));
    const live = data.filter((x) => x.status !== "cancelled" && x.status !== "draft");
    return { title: "Purchase report", rows: data,
      columns: [{ key: "poNumber", label: "PO", type: "text" }, { key: "date", label: "Date", type: "date" }, { key: "supplier", label: "Supplier", type: "text" }, { key: "status", label: "Status", type: "text" },
        { key: "total", label: "Total", type: "money" }, { key: "receivedPct", label: "Received", type: "percent" }],
      summary: { purchases: data.length, committedValue: sum(live, "total") } };
  } },
  inventory: { title: "Inventory report", needs: ["inventory.view"], run: async (b) => {
    const { rows } = await pool.query(
      `SELECT p.name, p.sku, c.name::text AS category, p.unit, p.stock_qty, p.min_stock, p.cost_price, p.selling_price, p.stock_qty * p.cost_price AS stock_value, p.stock_qty * p.selling_price AS retail_value
         FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE p.business_id=$1 AND p.status='active' ORDER BY lower(p.name)`, [b]);
    const data = rows.map((x) => ({ name: x.name, sku: x.sku, category: x.category ?? "Uncategorised", unit: x.unit, stock: num(x.stock_qty), minStock: num(x.min_stock), costPrice: num(x.cost_price),
      stockValue: round2(num(x.stock_value)), retailValue: round2(num(x.retail_value)), low: num(x.stock_qty) <= num(x.min_stock) ? "Yes" : "No" }));
    return { title: "Inventory report (current stock)", rows: data,
      columns: [{ key: "name", label: "Product", type: "text" }, { key: "sku", label: "SKU", type: "text" }, { key: "category", label: "Category", type: "text" }, { key: "unit", label: "Unit", type: "text" },
        { key: "stock", label: "Stock", type: "number" }, { key: "minStock", label: "Min", type: "number" }, { key: "low", label: "Low?", type: "text" },
        { key: "costPrice", label: "Avg cost", type: "money" }, { key: "stockValue", label: "Cost value", type: "money" }, { key: "retailValue", label: "Retail value", type: "money" }],
      summary: { products: data.length, totalCostValue: sum(data, "stockValue"), totalRetailValue: sum(data, "retailValue"), lowStockProducts: data.filter((d) => d.low === "Yes").length } };
  } },
  "stock-movements": { title: "Stock movement report", needs: ["inventory.view"], run: async (b, r) => {
    const { rows } = await pool.query(
      `SELECT m.created_at::date::text AS date, p.name, p.sku, m.type, m.quantity_delta, m.balance_after, m.note, u.full_name AS actor
         FROM inventory_movements m JOIN products p ON p.id=m.product_id LEFT JOIN users u ON u.id=m.actor_id
        WHERE m.business_id=$1 AND m.created_at >= $2::date AND m.created_at < ${TO} ORDER BY m.id`, [b, r.from, r.to]);
    const data = rows.map((x) => ({ date: x.date, product: x.name, sku: x.sku, type: x.type, change: num(x.quantity_delta), balance: num(x.balance_after), note: x.note ?? "", by: x.actor ?? "" }));
    return { title: "Stock movement report", rows: data,
      columns: [{ key: "date", label: "Date", type: "date" }, { key: "product", label: "Product", type: "text" }, { key: "sku", label: "SKU", type: "text" }, { key: "type", label: "Type", type: "text" },
        { key: "change", label: "Change", type: "number" }, { key: "balance", label: "Balance", type: "number" }, { key: "note", label: "Note", type: "text" }, { key: "by", label: "By", type: "text" }],
      summary: { movements: data.length, unitsIn: round2(data.filter((d) => d.change > 0).reduce((n, d) => n + d.change, 0)), unitsOut: round2(-data.filter((d) => d.change < 0).reduce((n, d) => n + d.change, 0)) } };
  } },
  attendance: { title: "Employee attendance report", needs: ["attendance.view"], run: async (b, r) => {
    const rows = await attendanceReport(b, r.from, r.to);
    const data = rows.map((x) => ({ employee: x.fullName, position: x.position ?? "", daysPresent: x.daysPresent, hoursWorked: x.hoursWorked, lateDays: x.lateDays, earlyDays: x.earlyDepartureDays }));
    return { title: "Employee attendance report", rows: data,
      columns: [{ key: "employee", label: "Employee", type: "text" }, { key: "position", label: "Position", type: "text" }, { key: "daysPresent", label: "Days present", type: "number" },
        { key: "hoursWorked", label: "Hours", type: "number" }, { key: "lateDays", label: "Late days", type: "number" }, { key: "earlyDays", label: "Early departures", type: "number" }],
      summary: { employees: data.length, totalHours: sum(data, "hoursWorked"), totalLateDays: sum(data, "lateDays") } };
  } },
  "working-hours": { title: "Working hours report", needs: ["attendance.view"], run: async (b, r) => {
    const { rows } = await pool.query(
      `WITH daily AS (SELECT employee_id, work_date, sum(minutes_worked) AS minutes FROM attendance WHERE business_id=$1 AND work_date BETWEEN $2 AND $3 AND punch_out IS NOT NULL GROUP BY employee_id, work_date)
       SELECT u.full_name, count(d.work_date)::int AS days, COALESCE(sum(d.minutes),0) AS minutes,
              COALESCE(sum(GREATEST(0, d.minutes - COALESCE(s.standard_hours_per_day,8)*60)),0) AS overtime_minutes
         FROM employees e JOIN users u ON u.id=e.user_id LEFT JOIN daily d ON d.employee_id=e.id LEFT JOIN salary_configs s ON s.employee_id=e.id
        WHERE e.business_id=$1 AND (e.status='active' OR d.work_date IS NOT NULL) GROUP BY e.id, u.full_name ORDER BY u.full_name`, [b, r.from, r.to]);
    const data = rows.map((x) => ({ employee: x.full_name, days: x.days, hours: round2(num(x.minutes) / 60), avgPerDay: x.days ? round2(num(x.minutes) / 60 / x.days) : 0, overtimeHours: round2(num(x.overtime_minutes) / 60) }));
    return { title: "Working hours report", rows: data,
      columns: [{ key: "employee", label: "Employee", type: "text" }, { key: "days", label: "Days worked", type: "number" }, { key: "hours", label: "Total hours", type: "number" },
        { key: "avgPerDay", label: "Avg hours/day", type: "number" }, { key: "overtimeHours", label: "Overtime hours", type: "number" }],
      summary: { totalHours: sum(data, "hours"), totalOvertimeHours: sum(data, "overtimeHours") } };
  } },
  salary: { title: "Salary report", needs: ["salary.view"], run: async (b, r) => {
    const { rows } = await pool.query(
      `SELECT u.full_name, s.period_start::text AS ps, s.period_end::text AS pe, s.method, s.hours_worked, s.days_worked, s.base_pay, s.overtime_pay, s.bonus, s.deductions, s.late_deductions, s.net_pay, s.status
         FROM salary_records s JOIN employees e ON e.id=s.employee_id JOIN users u ON u.id=e.user_id
        WHERE s.business_id=$1 AND s.period_end >= $2::date AND s.period_end <= $3::date ORDER BY s.period_end, u.full_name`, [b, r.from, r.to]);
    const data = rows.map((x) => ({ employee: x.full_name, periodStart: x.ps, periodEnd: x.pe, method: x.method, hours: num(x.hours_worked), days: num(x.days_worked), basePay: num(x.base_pay),
      overtimePay: num(x.overtime_pay), bonus: num(x.bonus), deductions: round2(num(x.deductions) + num(x.late_deductions)), netPay: num(x.net_pay), status: x.status }));
    return { title: "Salary report", rows: data,
      columns: [{ key: "employee", label: "Employee", type: "text" }, { key: "periodStart", label: "From", type: "date" }, { key: "periodEnd", label: "To", type: "date" }, { key: "method", label: "Method", type: "text" },
        { key: "hours", label: "Hours", type: "number" }, { key: "basePay", label: "Base", type: "money" }, { key: "overtimePay", label: "Overtime", type: "money" }, { key: "bonus", label: "Bonus", type: "money" },
        { key: "deductions", label: "Deductions", type: "money" }, { key: "netPay", label: "Net pay", type: "money" }, { key: "status", label: "Status", type: "text" }],
      summary: { records: data.length, totalNetPay: sum(data, "netPay"), paid: sum(data.filter((d) => d.status === "paid"), "netPay") } };
  } },
  customers: { title: "Customer report", needs: ["customers.view"], run: async (b, r) => {
    const { rows } = await pool.query(
      `SELECT c.name, c.email, c.phone,
              (SELECT count(*)::int FROM orders o WHERE o.customer_id=c.id AND o.status <> 'cancelled' AND o.created_at >= $2::date AND o.created_at < ${TO}) AS orders,
              (SELECT COALESCE(sum(o.total),0) FROM orders o WHERE o.customer_id=c.id AND o.status IN ('delivered','returned') AND o.delivered_at >= $2::date AND o.delivered_at < ${TO})
              - (SELECT COALESCE(sum(x.refund_total),0) FROM order_returns x JOIN orders o ON o.id=x.order_id WHERE o.customer_id=c.id AND x.created_at >= $2::date AND x.created_at < ${TO}) AS spent,
              (SELECT max(o.created_at)::date::text FROM orders o WHERE o.customer_id=c.id) AS last_order
         FROM customers c WHERE c.business_id=$1 ORDER BY spent DESC, lower(c.name)`, [b, r.from, r.to]);
    const data = rows.map((x) => ({ customer: x.name, email: x.email ?? "", phone: x.phone ?? "", orders: x.orders, spent: round2(num(x.spent)), lastOrder: x.last_order ?? "" }));
    return { title: "Customer report", rows: data,
      columns: [{ key: "customer", label: "Customer", type: "text" }, { key: "email", label: "Email", type: "text" }, { key: "phone", label: "Phone", type: "text" },
        { key: "orders", label: "Orders", type: "number" }, { key: "spent", label: "Spent", type: "money" }, { key: "lastOrder", label: "Last order", type: "date" }],
      summary: { customers: data.length, totalSpent: sum(data, "spent") } };
  } },
  suppliers: { title: "Supplier report", needs: ["purchases.view"], run: async (b, r) => {
    const { rows } = await pool.query(
      `SELECT s.name, s.status, count(p.id) FILTER (WHERE p.status NOT IN ('draft','cancelled'))::int AS purchases,
              COALESCE(sum(p.total) FILTER (WHERE p.status NOT IN ('draft','cancelled')),0) AS spent,
              count(p.id) FILTER (WHERE p.status IN ('sent','accepted','partially_received'))::int AS pending
         FROM suppliers s LEFT JOIN purchases p ON p.supplier_id=s.id AND p.created_at >= $2::date AND p.created_at < ${TO}
        WHERE s.business_id=$1 GROUP BY s.id ORDER BY spent DESC, lower(s.name)`, [b, r.from, r.to]);
    const data = rows.map((x) => ({ supplier: x.name, status: x.status, purchases: x.purchases, spent: num(x.spent), pending: x.pending }));
    return { title: "Supplier report", rows: data,
      columns: [{ key: "supplier", label: "Supplier", type: "text" }, { key: "status", label: "Status", type: "text" }, { key: "purchases", label: "Purchases", type: "number" },
        { key: "spent", label: "Total value", type: "money" }, { key: "pending", label: "Pending", type: "number" }],
      summary: { suppliers: data.length, totalPurchased: sum(data, "spent") } };
  } },
  orders: { title: "Order report", needs: ["orders.view"], run: async (b, r) => {
    const { rows } = await pool.query(
      `SELECT o.order_number, o.created_at::date::text AS date, COALESCE(c.name, bb.name, 'Walk-in') AS party, o.status, o.total
         FROM orders o LEFT JOIN customers c ON c.id=o.customer_id LEFT JOIN businesses bb ON bb.id=o.buyer_business_id
        WHERE o.business_id=$1 AND o.created_at >= $2::date AND o.created_at < ${TO} ORDER BY o.created_at, o.order_number`, [b, r.from, r.to]);
    const data = rows.map((x) => ({ orderNumber: x.order_number, date: x.date, party: x.party, status: x.status, total: num(x.total) }));
    const byStatus = Object.fromEntries(Object.entries(data.reduce((m: Record<string, number>, d) => ((m[d.status] = (m[d.status] ?? 0) + 1), m), {})).map(([k, v]) => [`status_${k}`, v]));
    return { title: "Order report", rows: data,
      columns: [{ key: "orderNumber", label: "Order", type: "text" }, { key: "date", label: "Created", type: "date" }, { key: "party", label: "Customer", type: "text" }, { key: "status", label: "Status", type: "text" }, { key: "total", label: "Total", type: "money" }],
      summary: { orders: data.length, valueExcludingCancelled: sum(data.filter((d) => d.status !== "cancelled"), "total"), ...byStatus } };
  } },
  crm: { title: "CRM report", needs: ["crm.view"], run: async (b, r) => {
    const { rows } = await pool.query(
      `WITH people AS (SELECT DISTINCT owner_id FROM (SELECT owner_id FROM crm_leads WHERE business_id=$1 UNION ALL SELECT owner_id FROM crm_deals WHERE business_id=$1) x)
       SELECT COALESCE(u.full_name, 'Unassigned') AS owner,
         (SELECT count(*)::int FROM crm_leads l WHERE l.business_id=$1 AND l.owner_id IS NOT DISTINCT FROM p.owner_id AND l.created_at >= $2::date AND l.created_at < ${TO}) AS leads,
         (SELECT count(*)::int FROM crm_leads l WHERE l.business_id=$1 AND l.owner_id IS NOT DISTINCT FROM p.owner_id AND l.status='converted' AND l.updated_at >= $2::date AND l.updated_at < ${TO}) AS converted,
         (SELECT count(*)::int FROM crm_deals d JOIN crm_pipeline_stages s ON s.id=d.stage_id WHERE d.business_id=$1 AND d.owner_id IS NOT DISTINCT FROM p.owner_id AND s.kind='won' AND d.closed_at >= $2::date AND d.closed_at < ${TO}) AS won,
         (SELECT COALESCE(sum(d.value),0) FROM crm_deals d JOIN crm_pipeline_stages s ON s.id=d.stage_id WHERE d.business_id=$1 AND d.owner_id IS NOT DISTINCT FROM p.owner_id AND s.kind='won' AND d.closed_at >= $2::date AND d.closed_at < ${TO}) AS won_value,
         (SELECT count(*)::int FROM crm_deals d JOIN crm_pipeline_stages s ON s.id=d.stage_id WHERE d.business_id=$1 AND d.owner_id IS NOT DISTINCT FROM p.owner_id AND s.kind='lost' AND d.closed_at >= $2::date AND d.closed_at < ${TO}) AS lost,
         (SELECT COALESCE(sum(d.value),0) FROM crm_deals d JOIN crm_pipeline_stages s ON s.id=d.stage_id WHERE d.business_id=$1 AND d.owner_id IS NOT DISTINCT FROM p.owner_id AND s.kind='open') AS open_value
         FROM people p LEFT JOIN users u ON u.id=p.owner_id ORDER BY won_value DESC, owner`, [b, r.from, r.to]);
    const data = rows.map((x) => ({ owner: x.owner, leads: x.leads, converted: x.converted, won: x.won, wonValue: num(x.won_value), lost: x.lost, openValue: num(x.open_value) }));
    return { title: "CRM report", rows: data,
      columns: [{ key: "owner", label: "Owner", type: "text" }, { key: "leads", label: "New leads", type: "number" }, { key: "converted", label: "Converted", type: "number" }, { key: "won", label: "Deals won", type: "number" },
        { key: "wonValue", label: "Won value", type: "money" }, { key: "lost", label: "Deals lost", type: "number" }, { key: "openValue", label: "Open pipeline", type: "money" }],
      summary: { wonValue: sum(data, "wonValue"), openPipeline: sum(data, "openValue") } };
  } },
};

export const catalog = (perms: Set<string>) =>
  Object.entries(DEFS).filter(([, d]) => d.needs.every((p) => perms.has(p))).map(([key, d]) => ({ key, title: d.title }));
export const reportNeeds = (type: string) => DEFS[type]?.needs;
export const runReport = (type: string, businessId: string, range: Range) => DEFS[type].run(businessId, range);
export const isReport = (type: string) => type in DEFS;
