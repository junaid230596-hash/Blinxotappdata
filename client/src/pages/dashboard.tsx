import { useState } from "react";
import { Link } from "react-router-dom";
import { ReviewModal } from "../components/ReviewModal";
import { PunchCard } from "../components/Punch";
import { Badge, Card, Empty, ErrorState, PageHeader, Spinner, Stat, statusTone } from "../components/ui";
import { useAuth } from "../lib/auth";
import { useBusiness } from "../lib/business";
import { date, hm, label, money, num, pct } from "../lib/format";
import { useFetch, useTitle } from "../lib/hooks";
import { CreateBusinessPrompt } from "./business";

export default function Dashboard() {
  useTitle("Dashboard");
  const { user } = useAuth(); const biz = useBusiness();
  if (!user) return null;
  if (user.accountType === "super_admin") return <AdminOverview />;
  if (biz.loading) return <Spinner />;
  if (!biz.current) {
    if (user.accountType === "individual") return <IndividualDashboard />;
    if (user.accountType === "employee") return <Card><Empty title="No business yet">You haven't been added to a business. Ask your employer to send you an invitation.</Empty></Card>;
    return <CreateBusinessPrompt />;
  }
  return user.accountType === "employee" ? <EmployeeDashboard /> : <BusinessDashboard />;
}

function Bars({ data, name }: { data: { day: string; total: number }[]; name: string }) {
  const max = Math.max(1, ...data.map((d) => d.total));
  return (
    <div className="bars" role="img" aria-label={`${name}: ${data.map((d) => `${d.day} ${money(d.total)}`).join(", ")}`}>
      {data.map((d) => <span key={d.day} title={`${date(d.day)}: ${money(d.total)}`} style={{ height: `${Math.max(2, (d.total / max) * 100)}%` }} />)}
    </div>
  );
}

function BusinessDashboard() {
  const { current, can } = useBusiness(); const { user } = useAuth();
  const { data: d, error, loading, reload } = useFetch<any>(`/api/businesses/${current!.id}/dashboard`);
  if (loading && !d) return <Spinner />;
  if (error) return <ErrorState error={error} retry={reload} />;
  const has = (s: string) => d.sections.includes(s);
  const delta = d.sales ? pct(d.sales.revenueLast30Days, d.sales.revenuePrevious30Days) : null;
  const quick = [
    can("orders.create") && ["/app/orders/new", "New order"], can("products.manage") && ["/app/products/new", "Add product"],
    can("employees.create") && ["/app/employees/new", "Add employee"], can("customers.manage") && ["/app/customers", "Customers"], can("inventory.manage") && ["/app/inventory", "Adjust stock"],
  ].filter(Boolean) as string[][];
  return (
    <div className="stack">
      <PageHeader title={`Welcome back, ${user!.fullName.split(" ")[0]}`}><span className="muted">{current!.name}</span></PageHeader>
      {quick.length > 0 && <div className="actions" aria-label="Quick actions">{quick.map(([to, l]) => <Link key={to} className="btn btn-primary" to={to}>{l}</Link>)}</div>}

      <div className="grid cols-4">
        {has("sales") && <Stat label="Revenue, last 30 days" value={money(d.sales.revenueLast30Days)} delta={delta === null ? null : `${delta >= 0 ? "▲" : "▼"} ${Math.abs(delta)}% vs previous 30 days`} tone={delta !== null && delta < 0 ? "down" : "up"} />}
        {has("orders") && <Stat label="Open orders" value={num(d.orders.open)} delta={d.orders.pending ? `${d.orders.pending} awaiting acceptance` : null} />}
        {has("inventory") && <Stat label="Low-stock products" value={num(d.inventory.lowStockCount)} delta={d.inventory.stockValue !== undefined ? `Stock value ${money(d.inventory.stockValue)}` : null} tone={d.inventory.lowStockCount ? "down" : undefined} />}
        {has("people") && <Stat label="Present today" value={`${d.people.presentToday} / ${d.people.employees}`} delta={d.people.onLeaveToday ? `${d.people.onLeaveToday} on leave` : `${d.people.clockedInNow} clocked in now`} />}
        {has("customers") && <Stat label="Customers" value={num(d.customers.total)} />}
        {has("tasks") && <Stat label={d.tasks.scope === "mine" ? "My open tasks" : "Open tasks"} value={num(d.tasks.open)} delta={d.tasks.overdue ? `${d.tasks.overdue} overdue` : null} tone={d.tasks.overdue ? "down" : undefined} />}
        {has("purchasing") && <Stat label="Pending purchases" value={num(d.purchasing.pendingPurchases)} delta={`${d.purchasing.suppliers} suppliers`} />}
        {has("crm") && <Stat label="Open pipeline" value={money(d.crm.openPipelineValue)} delta={`${d.crm.openDeals} deals · ${d.crm.newLeads} new leads`} />}
        {has("leave") && <Stat label="Leave requests" value={num(d.leave.pendingRequests)} delta="awaiting decision" />}
      </div>

      {has("sales") && <Card title="Sales, last 14 days"><Bars data={d.sales.trend} name="Revenue per day" /><p className="muted small" style={{ marginTop: ".5rem" }}>This month so far: <strong>{money(d.sales.revenueThisMonth)}</strong> · {d.sales.salesLast30Days} sales in 30 days</p></Card>}

      <div className="grid cols-2">
        {has("orders") && (
          <Card title="Recent orders">
            {d.orders.recent.length ? <ul className="list">{d.orders.recent.map((o: any) => (
              <li key={o.id}><span><Link to={`/app/orders/${o.id}`}><strong>{o.orderNumber}</strong></Link><br /><span className="muted small">{o.party}</span></span><span className="right">{money(o.total)}<br /><Badge tone={statusTone(o.status)}>{label(o.status)}</Badge></span></li>
            ))}</ul> : <Empty title="No orders yet">Orders you create or receive will appear here.</Empty>}
          </Card>
        )}
        {has("inventory") && (
          <Card title="Needs restocking">
            {d.inventory.lowStock.length ? <ul className="list">{d.inventory.lowStock.map((p: any) => (
              <li key={p.id}><span><Link to={`/app/products/${p.id}`}>{p.name}</Link><br /><span className="muted small">{p.sku}</span></span><span className="right"><strong>{num(p.stockQty)}</strong> {p.unit}<br /><span className="muted small">min {num(p.minStock)}</span></span></li>
            ))}</ul> : <Empty title="Stock looks healthy">Nothing is below its minimum level.</Empty>}
          </Card>
        )}
      </div>
      {has("recentActivity") && (
        <Card title="Recent activity">
          <ul className="list">{d.recentActivity.map((a: any) => <li key={a.id}><span>{a.actor ?? "System"} · <span className="muted">{label(a.action.replace(/\./g, " "))}</span></span><span className="muted small">{date(a.createdAt)}</span></li>)}</ul>
        </Card>
      )}
    </div>
  );
}

function EmployeeDashboard() {
  const { current } = useBusiness(); const [reviewing, setReviewing] = useState(false);
  const { data: d, error, loading, reload } = useFetch<any>(`/api/businesses/${current!.id}/me/dashboard`);
  if (loading && !d) return <Spinner />;
  if (error) return <ErrorState error={error} retry={reload} />;
  return (
    <div className="stack">
      <PageHeader title="My day"><span className="muted">{current!.name}</span></PageHeader>
      <div className="grid cols-2">
        <PunchCard onChange={reload} />
        <Card title="This month">
          <div className="grid cols-3">
            <div className="stat"><span className="v">{d.month.daysPresent}</span><span className="l">Days present</span></div>
            <div className="stat"><span className="v">{d.month.hoursWorked}</span><span className="l">Hours worked</span></div>
            <div className="stat"><span className="v">{d.month.lateDays}</span><span className="l">Late days</span></div>
          </div>
          <p style={{ marginTop: "1rem" }}><Link to="/app/attendance">View attendance history →</Link></p>
        </Card>
      </div>
      <div className="grid cols-2">
        <Card title="My tasks">
          <p className="muted small">{d.tasks.open} open{d.tasks.overdue ? ` · ${d.tasks.overdue} overdue` : ""}</p>
          {d.tasks.next.length ? <ul className="list">{d.tasks.next.map((t: any) => <li key={t.id}><span>{t.title}<br /><span className="muted small">{t.dueDate ? `Due ${date(t.dueDate)}` : "No due date"}</span></span><Badge tone={statusTone(t.status)}>{label(t.status)}</Badge></li>)}</ul> : <Empty title="All caught up">You have no open tasks.</Empty>}
          <p><Link to="/app/tasks">Open tasks →</Link></p>
        </Card>
        <Card title="Pay & time off">
          {d.latestPay ? <p><span className="muted small">Latest statement ({date(d.latestPay.periodStart)} – {date(d.latestPay.periodEnd)})</span><br /><strong style={{ fontSize: "1.4rem" }}>{money(d.latestPay.netPay)}</strong> <Badge tone={statusTone(d.latestPay.status)}>{label(d.latestPay.status)}</Badge></p> : <p className="muted">No pay statement yet.</p>}
          <p className="small">{d.leave.pending ? `${d.leave.pending} leave request pending. ` : ""}{d.leave.nextApprovedStart ? `Next approved leave starts ${date(d.leave.nextApprovedStart)}.` : "No upcoming approved leave."}</p>
          {d.unacknowledgedReviews > 0 && <p className="banner">You have {d.unacknowledgedReviews} performance review{d.unacknowledgedReviews > 1 ? "s" : ""} to acknowledge.</p>}
        </Card>
      </div>
      <p className="muted small">Time worked today: {hm(d.attendance.minutesToday)}</p>
      <p><button className="btn" onClick={() => setReviewing(true)}>Review {current!.name}</button></p>
      {reviewing && <ReviewModal subjectType="business" subjectId={current!.id} subjectName={current!.name} onClose={() => setReviewing(false)} />}
    </div>
  );
}

function IndividualDashboard() {
  const { data: d, error, loading, reload } = useFetch<any>("/api/me/dashboard");
  const { user } = useAuth();
  if (loading && !d) return <Spinner />;
  if (error) return <ErrorState error={error} retry={reload} />;
  const pctDone = d.completion.percent;
  return (
    <div className="stack">
      <PageHeader title={`Hello, ${user!.fullName.split(" ")[0]}`} />
      <div className="grid cols-2">
        <Card title="Profile completion">
          <div role="progressbar" aria-valuenow={pctDone} aria-valuemin={0} aria-valuemax={100} aria-label="Profile completion" style={{ background: "var(--surface-2)", borderRadius: 999, height: 12, overflow: "hidden" }}>
            <div style={{ width: `${pctDone}%`, background: "var(--brand)", height: "100%" }} />
          </div>
          <p style={{ marginTop: ".5rem" }}><strong>{pctDone}%</strong> complete</p>
          {d.completion.missing.length > 0 && <ul className="small">{d.completion.missing.map((m: string) => <li key={m}>{m}</li>)}</ul>}
          <Link className="btn" to="/app/profile">Edit profile</Link>
        </Card>
        <Card title="Applications">
          <div className="grid cols-3">
            <div className="stat"><span className="v">{d.applications.total}</span><span className="l">Total</span></div>
            <div className="stat"><span className="v">{d.applications.byStatus.interview ?? 0}</span><span className="l">Interviews</span></div>
            <div className="stat"><span className="v">{d.applications.byStatus.selected ?? 0}</span><span className="l">Selected</span></div>
          </div>
          <p style={{ marginTop: "1rem" }}><Link to="/app/applications">Track applications →</Link></p>
        </Card>
      </div>
      <div className="grid cols-2">
        <Card title="Jobs that match your skills">
          {d.recommendedJobs.length ? <ul className="list">{d.recommendedJobs.map((j: any) => <li key={j.id}><span><strong>{j.title}</strong><br /><span className="muted small">{j.businessName}{j.location ? ` · ${j.location}` : ""}</span></span><Badge>{label(j.workType)}</Badge></li>)}</ul>
            : <Empty title="No matches yet">Add skills to your profile to see jobs that fit.</Empty>}
          <Link to="/app/jobs">Browse all jobs →</Link>
        </Card>
        <Card title="Reputation">
          {d.rating.count ? <p><strong style={{ fontSize: "1.6rem" }}>{d.rating.average}</strong> / 5 <span className="muted">from {d.rating.count} review{d.rating.count > 1 ? "s" : ""}</span></p> : <p className="muted">You have no reviews yet. They appear after employers you've worked with leave one.</p>}
          <p className="small muted">{d.unreadNotifications} unread notification{d.unreadNotifications === 1 ? "" : "s"}</p>
        </Card>
      </div>
    </div>
  );
}

function AdminOverview() {
  const { data: d, error, loading, reload } = useFetch<any>("/api/admin/overview");
  if (loading && !d) return <Spinner />;
  if (error) return <ErrorState error={error} retry={reload} />;
  return (
    <div className="stack">
      <PageHeader title="Platform overview" />
      <div className="grid cols-4">
        <Stat label="Active users" value={num(d.users.active ?? 0)} delta={d.users.suspended ? `${d.users.suspended} suspended` : null} />
        <Stat label="Active businesses" value={num(d.businesses.active ?? 0)} delta={d.businesses.suspended ? `${d.businesses.suspended} suspended` : null} />
        <Stat label="Orders this month" value={num(d.orders.thisMonth)} delta={`${num(d.orders.total)} all time`} />
        <Stat label="Open review reports" value={num(d.openReviewReports)} />
      </div>
    </div>
  );
}
