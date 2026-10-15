import { useState } from "react";
import { FormModal, InlineForm, ListPage, type FieldDef } from "../components/forms";
import { Badge, Button, Card, ConfirmDialog, Empty, ErrorState, Modal, PageHeader, Spinner, statusTone } from "../components/ui";
import { ApiError, del, patch, post, put } from "../lib/api";
import { useAuth } from "../lib/auth";
import { date, dateTime, label, money, num } from "../lib/format";
import { useFetch, useTitle } from "../lib/hooks";
import { useToast } from "../lib/toast";

const problem = (e: unknown, fb = "Something went wrong. Please try again.") => (e instanceof ApiError ? e.message : fb);
const crumbs = (l: string) => [{ to: "/app", label: "Overview" }, { label: l }];
const REASON: FieldDef[] = [{ key: "reason", label: "Reason (kept in the audit log)", type: "textarea" }];

export function AdminUsers() {
  useTitle("Users"); const { toast } = useToast(); const { user: me } = useAuth(); const [act, setAct] = useState<{ row: any; to: "suspend" | "reactivate"; reload: () => void } | null>(null);
  return (
    <ListPage title="Users" crumbs={crumbs("Users")} endpoint="/api/admin/users" listKey="users" search="Search by name or email"
      filters={[{ key: "status", label: "Status", options: [["", "All"], ["active", "Active"], ["suspended", "Suspended"]] }, { key: "accountType", label: "Account type", options: [["", "All"], ...["individual", "business_owner", "employee", "supplier", "super_admin"].map((t) => [t, label(t)] as [string, string])] }]}
      cols={[
        { key: "fullName", label: "User", render: (u: any) => <><strong>{u.fullName}</strong><br /><span className="muted small">{u.email}</span></> }, { key: "accountType", label: "Type", render: (u: any) => <Badge>{label(u.accountType)}</Badge> },
        { key: "status", label: "Status", render: (u: any) => <Badge tone={statusTone(u.status)}>{label(u.status)}</Badge> }, { key: "emailVerified", label: "Email", render: (u: any) => (u.emailVerified ? <Badge tone="ok">Verified</Badge> : <Badge tone="warn">Unverified</Badge>) },
        { key: "lastLoginAt", label: "Last login", render: (u: any) => (u.lastLoginAt ? dateTime(u.lastLoginAt) : "Never") },
      ]}
      actions={(u, reload) => u.accountType === "super_admin" || u.id === me?.id ? null : u.status === "active"
        ? <Button small variant="danger" onClick={() => setAct({ row: u, to: "suspend", reload })}>Suspend</Button> : <Button small variant="primary" onClick={() => setAct({ row: u, to: "reactivate", reload })}>Reactivate</Button>}>
      {() => act && <FormModal title={`${label(act.to)} ${act.row.fullName}`} fields={REASON} submitLabel={label(act.to)} onClose={() => setAct(null)}
        intro={act.to === "suspend" ? <p className="muted small">They are signed out immediately and cannot log in until reactivated.</p> : undefined}
        onSubmit={async (b) => { await post(`/api/admin/users/${act.row.id}/${act.to}`, b); toast(act.to === "suspend" ? "User suspended" : "User reactivated"); act.reload(); }} />}
    </ListPage>
  );
}

export function AdminBusinesses() {
  useTitle("Businesses"); const { toast } = useToast(); const plans = useFetch<any>("/api/plans"); const [act, setAct] = useState<{ row: any; kind: "suspend" | "reactivate" | "plan"; reload: () => void } | null>(null);
  return (
    <ListPage title="Businesses" crumbs={crumbs("Businesses")} endpoint="/api/admin/businesses" listKey="businesses" search="Search by name"
      filters={[{ key: "status", label: "Status", options: [["", "All"], ["active", "Active"], ["suspended", "Suspended"]] }]}
      cols={[
        { key: "name", label: "Business", render: (b: any) => <><strong>{b.name}</strong><br /><span className="muted small">{b.category ?? "—"}</span></> }, { key: "owner", label: "Owner", render: (b: any) => <>{b.ownerName}<br /><span className="muted small">{b.ownerEmail}</span></> },
        { key: "plan", label: "Plan", render: (b: any) => <Badge tone="brand">{label(b.plan ?? "free")}</Badge> }, { key: "members", label: "Members", num: true }, { key: "status", label: "Status", render: (b: any) => <Badge tone={statusTone(b.status)}>{label(b.status)}</Badge> },
      ]}
      actions={(b, reload) => <><Button small onClick={() => setAct({ row: b, kind: "plan", reload })}>Plan</Button>{b.status === "active" ? <Button small variant="danger" onClick={() => setAct({ row: b, kind: "suspend", reload })}>Suspend</Button> : <Button small variant="primary" onClick={() => setAct({ row: b, kind: "reactivate", reload })}>Reactivate</Button>}</>}>
      {() => (<>
        {act && act.kind !== "plan" && <FormModal title={`${label(act.kind)} ${act.row.name}`} fields={REASON} submitLabel={label(act.kind)} onClose={() => setAct(null)}
          intro={act.kind === "suspend" ? <p className="muted small">Members lose access, and the business disappears from public pages and the marketplace.</p> : undefined}
          onSubmit={async (b) => { await post(`/api/admin/businesses/${act.row.id}/${act.kind}`, b); toast(act.kind === "suspend" ? "Business suspended" : "Business reactivated"); act.reload(); }} />}
        {act?.kind === "plan" && <FormModal title={`Plan for ${act.row.name}`} submitLabel="Change plan" onClose={() => setAct(null)}
          fields={[{ key: "planKey", label: "Plan", type: "select", options: plans.data?.plans.map((p: any) => [p.key, `${p.name}${p.priceMonthly ? ` (${money(p.priceMonthly)}/mo)` : ""}`] as [string, string]) ?? [["free", "Free"]] }, { key: "providerRef", label: "Payment reference (optional)", hint: "e.g. the Razorpay subscription id." }]}
          initial={{ planKey: act.row.plan ?? "free" }} intro={<p className="muted small">Upgrades are applied once payment is confirmed. Changing a plan takes effect immediately.</p>}
          onSubmit={async (b) => { await put(`/api/admin/businesses/${act.row.id}/subscription`, b); toast("Plan updated"); act.reload(); }} />}
      </>)}
    </ListPage>
  );
}

export const AdminEmployees = () => { useTitle("Employees"); return <ListPage title="Employees" crumbs={crumbs("Employees")} endpoint="/api/admin/employees" listKey="employees" search="Search by name or email"
  cols={[{ key: "fullName", label: "Employee", render: (e: any) => <><strong>{e.fullName}</strong><br /><span className="muted small">{e.email}</span></> }, { key: "businessName", label: "Business" }, { key: "position", label: "Position", render: (e: any) => e.position ?? "—" }, { key: "status", label: "Status", render: (e: any) => <Badge tone={statusTone(e.status)}>{label(e.status)}</Badge> }]} />; };

export function AdminProducts() {
  useTitle("Products"); const { toast } = useToast();
  return <ListPage title="Products" crumbs={crumbs("Products")} endpoint="/api/admin/products" listKey="products" search="Search by name or SKU"
    cols={[{ key: "name", label: "Product", render: (p: any) => <><strong>{p.name}</strong><br /><span className="muted small">{p.sku}</span></> }, { key: "businessName", label: "Business" }, { key: "stockQty", label: "Stock", num: true, render: (p: any) => num(p.stockQty) }, { key: "sellingPrice", label: "Price", num: true, render: (p: any) => money(p.sellingPrice) },
      { key: "isListed", label: "Marketplace", render: (p: any) => (p.isListed ? <Badge tone="ok">Listed</Badge> : <Badge>Not listed</Badge>) }, { key: "status", label: "Status", render: (p: any) => <Badge tone={statusTone(p.status)}>{label(p.status)}</Badge> }]}
    actions={(p, reload) => p.isListed ? <Button small variant="danger" onClick={async () => { try { await patch(`/api/admin/products/${p.id}`, { isListed: false }); toast("Removed from the marketplace"); reload(); } catch (e) { toast(problem(e), "error"); } }}>Delist</Button> : null} />;
}

export const AdminOrders = () => { useTitle("Orders"); return <ListPage title="Orders" crumbs={crumbs("Orders")} endpoint="/api/admin/orders" listKey="orders" search="Order number"
  filters={[{ key: "status", label: "Status", options: [["", "All"], ...["pending", "accepted", "processing", "ready", "dispatched", "delivered", "cancelled", "returned"].map((s) => [s, label(s)] as [string, string])] }]}
  cols={[{ key: "orderNumber", label: "Order", render: (o: any) => <strong>{o.orderNumber}</strong> }, { key: "seller", label: "Seller" }, { key: "buyerBusiness", label: "Buyer", render: (o: any) => o.buyerBusiness ?? "—" }, { key: "status", label: "Status", render: (o: any) => <Badge tone={statusTone(o.status)}>{label(o.status)}</Badge> },
    { key: "total", label: "Total", num: true, render: (o: any) => money(o.total) }, { key: "createdAt", label: "Created", render: (o: any) => date(o.createdAt) }]} />; };

export function AdminReviews() {
  useTitle("Review moderation"); const { toast } = useToast(); const [act, setAct] = useState<{ row: any; reload: () => void } | null>(null); const [view, setView] = useState<any>(null);
  return (
    <ListPage title="Review moderation" crumbs={crumbs("Reviews")} endpoint="/api/admin/reviews" listKey="reviews" search={false}
      filters={[{ key: "reported", label: "Show", initial: "true", options: [["true", "Reported"], ["", "Everything"]] }, { key: "status", label: "Status", options: [["", "Any"], ["published", "Published"], ["hidden", "Hidden"]] }]}
      empty={<Empty title="Nothing to moderate">Reported reviews appear here.</Empty>}
      cols={[
        { key: "rating", label: "Review", render: (r: any) => <><span aria-label={`${r.rating} out of 5`}>{"★".repeat(r.rating)}{"☆".repeat(5 - r.rating)}</span> {r.body ?? <span className="muted">(no text)</span>}<br /><span className="muted small">by {r.reviewerName} · {label(r.relationship)}</span></> },
        { key: "status", label: "Status", render: (r: any) => <><Badge tone={r.status === "published" ? "ok" : "danger"}>{label(r.status)}</Badge>{r.hiddenReason && <><br /><span className="muted small">{r.hiddenReason}</span></>}</> }, { key: "openReports", label: "Open reports", num: true },
      ]}
      actions={(r, reload) => <><Button small onClick={() => setView(r)}>Reports</Button>{r.status === "published" ? <Button small variant="danger" onClick={() => setAct({ row: r, reload })}>Hide</Button> : <Button small variant="primary" onClick={async () => { try { await post(`/api/admin/reviews/${r.id}/restore`); toast("Review restored"); reload(); } catch (e) { toast(problem(e), "error"); } }}>Restore</Button>}</>}>
      {() => (<>
        {act && <FormModal title="Hide this review" submitLabel="Hide review" fields={[{ key: "reason", label: "Reason (shown to the author)", type: "textarea", required: true }]} onClose={() => setAct(null)} onSubmit={async (b) => { await post(`/api/admin/reviews/${act.row.id}/hide`, b); toast("Review hidden"); act.reload(); }} />}
        {view && <Modal open title="Reports on this review" onClose={() => setView(null)}>{view.reports.length ? <ul className="list">{view.reports.map((x: any, i: number) => <li key={i}><span>{x.reason}</span><span className="muted small">{date(x.createdAt)}</span></li>)}</ul> : <p className="muted">No open reports.</p>}<div className="actions"><Button onClick={() => setView(null)}>Close</Button></div></Modal>}
      </>)}
    </ListPage>
  );
}

export function AdminAds() {
  useTitle("Ad moderation"); const { toast } = useToast(); const [rej, setRej] = useState<{ row: any; reload: () => void } | null>(null);
  return (
    <ListPage title="Ad moderation" crumbs={crumbs("Advertisements")} endpoint="/api/admin/ads" listKey="ads" search={false} filters={[{ key: "moderation", label: "Moderation", options: [["", "All"], ["approved", "Approved"], ["rejected", "Rejected"]] }]}
      cols={[{ key: "title", label: "Ad", render: (a: any) => <><strong>{a.title}</strong><br /><span className="muted small">{a.businessName}</span></> }, { key: "placements", label: "Placements", render: (a: any) => a.placements.map(label).join(", ") },
        { key: "status", label: "Status", render: (a: any) => <Badge tone={a.status === "active" ? "ok" : undefined}>{label(a.status)}</Badge> }, { key: "moderationStatus", label: "Moderation", render: (a: any) => <><Badge tone={a.moderationStatus === "approved" ? "ok" : "danger"}>{label(a.moderationStatus)}</Badge>{a.moderationNote && <><br /><span className="muted small">{a.moderationNote}</span></>}</> }]}
      actions={(a, reload) => a.moderationStatus === "approved" ? <Button small variant="danger" onClick={() => setRej({ row: a, reload })}>Reject</Button> : <Button small variant="primary" onClick={async () => { try { await post(`/api/admin/ads/${a.id}/approve`); toast("Ad approved"); reload(); } catch (e) { toast(problem(e), "error"); } }}>Approve</Button>}>
      {() => rej && <FormModal title={`Reject “${rej.row.title}”`} submitLabel="Reject ad" fields={[{ key: "note", label: "Reason (shown to the business)", type: "textarea", required: true }]} onClose={() => setRej(null)} onSubmit={async (b) => { await post(`/api/admin/ads/${rej.row.id}/reject`, b); toast("Ad rejected and paused"); rej.reload(); }} />}
    </ListPage>
  );
}

export const AdminAudit = () => { useTitle("Audit log"); return <ListPage title="Audit log" crumbs={crumbs("Audit log")} endpoint="/api/admin/audit" listKey="entries" search="Action starts with" searchParam="action" pageSize={50}
  cols={[{ key: "createdAt", label: "When", render: (e: any) => dateTime(e.createdAt) }, { key: "actorName", label: "Who", render: (e: any) => <>{e.actorName ?? "System"}<br /><span className="muted small">{e.actorEmail ?? ""}</span></> }, { key: "action", label: "Action", render: (e: any) => <code>{e.action}</code> },
    { key: "entity", label: "About", render: (e: any) => e.entity ?? "—" }, { key: "ip", label: "IP", render: (e: any) => e.ip ?? "—" }]} />; };

export function AdminCategories() {
  useTitle("Categories"); const { toast } = useToast(); const [edit, setEdit] = useState<{ row: any | null; reload: () => void } | null>(null); const [rm, setRm] = useState<{ row: any; reload: () => void } | null>(null);
  return (
    <ListPage title="Categories" crumbs={crumbs("Categories")} endpoint="/api/admin/categories" listKey="categories" search={false} filters={[{ key: "kind", label: "Kind", options: [["", "All"], ["business", "Business"], ["product", "Product"]] }]}
      headerActions={(reload) => <Button variant="primary" onClick={() => setEdit({ row: null, reload })}>Add category</Button>}
      empty={<Empty title="No categories yet">Platform categories power discovery filters.</Empty>}
      cols={[{ key: "name", label: "Name", render: (c: any) => <strong>{c.name}</strong> }, { key: "kind", label: "Kind", render: (c: any) => <Badge>{label(c.kind)}</Badge> }]}
      actions={(c, reload) => <><Button small onClick={() => setEdit({ row: c, reload })}>Rename</Button><Button small variant="danger" onClick={() => setRm({ row: c, reload })}>Delete</Button></>}>
      {() => (<>
        {edit && <FormModal title={edit.row ? "Rename category" : "Add category"} onClose={() => setEdit(null)} fields={[...(edit.row ? [] : [{ key: "kind", label: "Kind", type: "select" as const, options: [["business", "Business"], ["product", "Product"]] as [string, string][] }]), { key: "name", label: "Name", required: true }]} initial={edit.row ?? {}}
          onSubmit={async (b) => { edit.row ? await patch(`/api/admin/categories/${edit.row.id}`, { name: b.name }) : await post("/api/admin/categories", b); toast("Category saved"); edit.reload(); }} />}
        <ConfirmDialog open={!!rm} danger title="Delete this category?" confirmLabel="Delete" message={rm && `“${rm.row.name}” will be removed from discovery filters.`} onClose={() => setRm(null)}
          onConfirm={async () => { try { await del(`/api/admin/categories/${rm!.row.id}`); toast("Category deleted"); rm!.reload(); } catch (e) { toast(problem(e), "error"); } setRm(null); }} />
      </>)}
    </ListPage>
  );
}

export function AdminSettings() {
  useTitle("Platform settings"); const { toast } = useToast(); const { data, error, loading, reload } = useFetch<any>("/api/admin/settings");
  if (error) return <ErrorState error={error} retry={reload} />; if (loading && !data) return <Spinner />;
  const fields: FieldDef[] = [
    { key: "registration_open", label: "Allow new people to register", type: "checkbox" },
    { key: "maintenance_mode", label: "Maintenance mode: everyone except administrators becomes read-only", type: "checkbox" },
    { key: "support_email", label: "Support email", type: "email", nullWhenEmpty: true },
  ];
  return (
    <div className="stack">
      <PageHeader title="Platform settings" crumbs={crumbs("Settings")} />
      <Card><InlineForm fields={fields} initial={data.settings} onSubmit={async (b) => { for (const [k, v] of Object.entries(b)) await put(`/api/admin/settings/${k}`, { value: v }); toast("Settings saved"); reload(); }}>
        {data.settings.maintenance_mode && <div className="banner" role="status">Maintenance mode is ON. People can browse and log in but cannot make changes.</div>}
      </InlineForm></Card>
    </div>
  );
}
