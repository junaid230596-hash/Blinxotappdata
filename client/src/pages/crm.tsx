import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { FormModal, ListPage, type FieldDef } from "../components/forms";
import { Badge, Button, Card, ConfirmDialog, Empty, ErrorState, Modal, PageHeader, SelectField, Spinner, Stat, statusTone, TextField } from "../components/ui";
import { ApiError, del, patch, post, put, qs } from "../lib/api";
import { useBusiness } from "../lib/business";
import { date, dateTime, label, money, num } from "../lib/format";
import { useFetch, useTitle } from "../lib/hooks";
import { useMembers } from "../lib/members";
import { useToast } from "../lib/toast";

const problem = (e: unknown, fb = "Something went wrong. Please try again.") => (e instanceof ApiError ? e.message : fb);
const tagBadges = (tags: string[]) => (tags?.length ? <>{tags.map((t) => <Badge key={t}>{t}</Badge>)}</> : "—");
const crumbs = (l: string) => [{ to: "/app", label: "Dashboard" }, { to: "/app/crm", label: "CRM" }, { label: l }];

export function CrmOverview() {
  useTitle("CRM"); const { current, can } = useBusiness();
  const { data: d, error, loading, reload } = useFetch<any>(`/api/businesses/${current!.id}/crm/dashboard`);
  if (error) return <ErrorState error={error} retry={reload} />;
  if (loading && !d) return <Spinner />;
  const max = Math.max(1, ...d.pipeline.map((s: any) => s.deals));
  return (
    <div className="stack">
      <PageHeader title="CRM" crumbs={[{ to: "/app", label: "Dashboard" }, { label: "CRM" }]}>{can("crm.manage") && <><Link className="btn" to="/app/crm/leads">Add a lead</Link><Link className="btn btn-primary" to="/app/crm/pipeline">Open pipeline</Link></>}</PageHeader>
      <div className="grid cols-4">
        <Stat label="New leads" value={num(d.leadsByStatus.new ?? 0)} delta={`${num(d.leadsByStatus.qualified ?? 0)} qualified`} />
        <Stat label="Open pipeline" value={money(d.openPipelineValue)} delta={`${d.openDeals} open deals`} />
        <Stat label="Won (all time)" value={money(d.wonValue)} delta={`${d.wonLast30Days.deals} won in 30 days · ${money(d.wonLast30Days.value)}`} />
        <Stat label="Win rate" value={d.winRate === null ? "—" : `${d.winRate}%`} delta={`${d.wonDeals} won · ${d.lostDeals} lost`} />
        <Stat label="Follow-ups overdue" value={num(d.activities.overdue)} tone={d.activities.overdue ? "down" : undefined} delta={`${d.activities.dueToday} due today`} />
      </div>
      <div className="grid cols-2">
        <Card title="Pipeline">
          <ul className="list">{d.pipeline.map((s: any) => (
            <li key={s.stageId}><span style={{ flex: 1 }}>{s.name} {s.kind !== "open" && <Badge tone={s.kind === "won" ? "ok" : "danger"}>{label(s.kind)}</Badge>}
              <span className="bars" style={{ height: 8, marginTop: 4, display: "block" }}><span style={{ width: `${(s.deals / max) * 100}%`, flex: "none", height: 8, borderRadius: 4 }} /></span></span>
              <span className="right"><strong>{s.deals}</strong> deal{s.deals === 1 ? "" : "s"}<br /><span className="muted small">{money(s.value)}</span></span></li>
          ))}</ul>
        </Card>
        <Card title="Recent activity">{d.recentActivity.length ? <ul className="list">{d.recentActivity.map((a: any) => <li key={a.id}><span><Badge>{label(a.type)}</Badge> {a.subject}<br /><span className="muted small">{a.entityName ?? label(a.entityType)}</span></span><span className="muted small">{date(a.createdAt)}</span></li>)}</ul> : <Empty title="No activity yet">Notes, calls and follow-ups you log appear here.</Empty>}
          <Link to="/app/crm/activities">Open follow-ups →</Link></Card>
      </div>
    </div>
  );
}

type Kind = "leads" | "contacts" | "companies" | "deals";
const SINGULAR: Record<Kind, string> = { leads: "lead", contacts: "contact", companies: "company", deals: "deal" };
const ENTITY: Record<Kind, string> = { leads: "lead", contacts: "contact", companies: "company", deals: "deal" };

function ActivityModal({ entityType, entityId, name, onClose }: { entityType: string; entityId: string; name: string; onClose: () => void }) {
  const { current, can } = useBusiness(); const { toast } = useToast(); const base = `/api/businesses/${current!.id}/crm`; const members = useMembers();
  const { data, error, loading, reload } = useFetch<any>(`${base}/activities${qs({ entityType, entityId, limit: 50 })}`); const [adding, setAdding] = useState(false); const manage = can("crm.manage");
  const fields: FieldDef[] = [
    { key: "type", label: "Type", type: "select", options: ["note", "call", "email", "meeting", "task", "follow_up"].map((t) => [t, label(t)] as [string, string]) }, { key: "subject", label: "Subject", required: true },
    { key: "body", label: "Details", type: "textarea" }, { key: "dueAt", label: "Due", type: "datetime", hint: "Required for follow-ups; you'll get a reminder." },
    ...(members.options.length ? [{ key: "assignedTo", label: "Assign to", type: "select" as const, options: [["", "Me"], ...members.options] as [string, string][] }] : []),
  ];
  const act = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); toast(ok); reload(); } catch (e) { toast(problem(e), "error"); } };
  return (
    <Modal open title={`Activity: ${name}`} onClose={onClose}>
      <div className="stack">
        {manage && <div><Button variant="primary" onClick={() => setAdding(true)}>Add note, call or follow-up</Button></div>}
        {error ? <ErrorState error={error} retry={reload} /> : loading && !data ? <Spinner /> : data.activities.length ? (
          <ul className="list">{data.activities.map((a: any) => (
            <li key={a.id}><span><Badge tone={a.doneAt ? "ok" : a.dueAt && new Date(a.dueAt) < new Date() ? "danger" : undefined}>{label(a.type)}{a.doneAt ? " · done" : ""}</Badge> <strong>{a.subject}</strong>{a.body && <><br />{a.body}</>}<br /><span className="muted small">{a.dueAt ? `Due ${dateTime(a.dueAt)} · ` : ""}{a.assigneeName ?? a.createdByName ?? "—"}</span></span>
              {manage && <span className="actions">{a.dueAt && <Button small onClick={() => act(() => post(`${base}/activities/${a.id}/${a.doneAt ? "reopen" : "done"}`), a.doneAt ? "Reopened" : "Marked done")}>{a.doneAt ? "Reopen" : "Done"}</Button>}<Button small variant="danger" aria-label={`Delete ${a.subject}`} onClick={() => act(() => del(`${base}/activities/${a.id}`), "Deleted")}>Delete</Button></span>}</li>
          ))}</ul>
        ) : <p className="muted">Nothing logged yet.</p>}
        {adding && <FormModal title="New activity" fields={fields} onClose={() => setAdding(false)} onSubmit={async (b) => { await post(`${base}/activities`, { ...b, entityType, entityId }); toast("Saved"); reload(); }} />}
      </div>
    </Modal>
  );
}

/** One screen for leads, contacts and companies: list, search, add, edit, delete and activity. */
function EntityPage({ kind, title, fields, cols, filters, extraActions, intro }: { kind: Exclude<Kind, "deals">; title: string; fields: FieldDef[]; cols: any[]; filters?: any[]; extraActions?: (row: any, reload: () => void) => ReactNode; intro?: ReactNode }) {
  useTitle(title); const { current, can } = useBusiness(); const { toast } = useToast(); const base = `/api/businesses/${current!.id}/crm/${kind}`; const manage = can("crm.manage");
  const [edit, setEdit] = useState<{ row: any | null } | null>(null); const [rm, setRm] = useState<any>(null); const [act, setAct] = useState<any>(null);
  const s = SINGULAR[kind];
  return (
    <ListPage title={title} crumbs={crumbs(title)} endpoint={base} listKey={kind} search={`Search ${kind}`} filters={filters} cols={cols}
      headerActions={() => manage && <Button variant="primary" onClick={() => setEdit({ row: null })}>Add {s}</Button>}
      empty={<Empty title={`No ${kind} yet`}>{manage ? `Add your first ${s} to start tracking.` : "Nothing to show."}</Empty>}
      actions={(r, reload) => <>
        <Button small onClick={() => setAct(r)}>Activity</Button>{manage && <>{extraActions?.(r, reload)}<Button small onClick={() => setEdit({ row: r })}>Edit</Button><Button small variant="danger" onClick={() => setRm(r)}>Delete</Button></>}
      </>}>
      {(reload) => (<>
        {intro}
        {edit && <FormModal title={edit.row ? `Edit ${s}` : `Add ${s}`} fields={fields} initial={edit.row ?? {}} onClose={() => setEdit(null)}
          onSubmit={async (b) => { edit.row ? await patch(`${base}/${edit.row.id}`, b) : await post(base, b); toast(`${label(s)} saved`); reload(); }} />}
        {act && <ActivityModal entityType={ENTITY[kind]} entityId={act.id} name={act.name} onClose={() => setAct(null)} />}
        <ConfirmDialog open={!!rm} danger title={`Delete this ${s}?`} confirmLabel="Delete" message={rm && `${rm.name} and its activity history will be removed.`} onClose={() => setRm(null)}
          onConfirm={async () => { try { await del(`${base}/${rm.id}`); toast("Deleted"); setRm(null); reload(); } catch (e) { toast(problem(e), "error"); setRm(null); } }} />
      </>)}
    </ListPage>
  );
}

export function Leads() {
  const { current } = useBusiness(); const members = useMembers(); const { toast } = useToast(); const base = `/api/businesses/${current!.id}/crm`; const [done, setDone] = useState<any>(null);
  const fields: FieldDef[] = [
    { key: "name", label: "Name", required: true }, { key: "email", label: "Email", type: "email" }, { key: "phone", label: "Phone", type: "tel" }, { key: "companyName", label: "Company" }, { key: "source", label: "Source", hint: "Referral, website, event…" },
    { key: "status", label: "Status", type: "select", options: [["new", "New"], ["contacted", "Contacted"], ["qualified", "Qualified"], ["unqualified", "Unqualified"]] },
    ...(members.options.length ? [{ key: "ownerId", label: "Owner", type: "select" as const, options: [["", "Unassigned"], ...members.options] as [string, string][] }] : []),
    { key: "tags", label: "Tags", type: "csv", hint: "Separate with commas." }, { key: "notes", label: "Notes", type: "textarea" },
  ];
  return (
    <EntityPage kind="leads" title="Leads" fields={fields}
      filters={[{ key: "status", label: "Status", options: [["", "All statuses"], ...["new", "contacted", "qualified", "unqualified", "converted"].map((s) => [s, label(s)] as [string, string])] }]}
      cols={[
        { key: "name", label: "Lead", render: (l: any) => <><strong>{l.name}</strong> <span className="muted small">{l.code}</span>{l.companyName && <><br /><span className="muted small">{l.companyName}</span></>}</> },
        { key: "contact", label: "Contact", render: (l: any) => l.email ?? l.phone ?? "—" }, { key: "status", label: "Status", render: (l: any) => <Badge tone={statusTone(l.status) ?? (l.status === "converted" ? "ok" : undefined)}>{label(l.status)}</Badge> },
        { key: "ownerName", label: "Owner", render: (l: any) => l.ownerName ?? "—" }, { key: "tags", label: "Tags", render: (l: any) => tagBadges(l.tags) },
      ]}
      extraActions={(l, reload) => l.status !== "converted" ? <Button small onClick={async () => { try { const r = await post<any>(`${base}/leads/${l.id}/convert`, {}); toast("Lead converted to a deal"); setDone(r.deal); reload(); } catch (e) { toast(problem(e), "error"); } }}>Convert</Button> : null}
      intro={done && <div className="banner ok" role="status"><span>Created deal “{done.title}” in <strong>{done.stageName}</strong>.</span><Link className="btn btn-sm" to="/app/crm/pipeline">View pipeline</Link></div>} />
  );
}

export function Contacts() {
  const { current } = useBusiness(); const companies = useFetch<any>(`/api/businesses/${current!.id}/crm/companies${qs({ limit: 100 })}`);
  const fields: FieldDef[] = [
    { key: "name", label: "Name", required: true }, { key: "email", label: "Email", type: "email" }, { key: "phone", label: "Phone", type: "tel" }, { key: "jobTitle", label: "Job title" },
    { key: "companyId", label: "Company", type: "select", nullWhenEmpty: true, options: [["", "No company"], ...(companies.data?.companies.map((c: any) => [c.id, c.name]) ?? [])] as [string, string][] },
    { key: "tags", label: "Tags", type: "csv", hint: "Separate with commas." }, { key: "notes", label: "Notes", type: "textarea" },
  ];
  return <EntityPage kind="contacts" title="Contacts" fields={fields} cols={[
    { key: "name", label: "Contact", render: (c: any) => <><strong>{c.name}</strong>{c.jobTitle && <><br /><span className="muted small">{c.jobTitle}</span></>}</> }, { key: "company", label: "Company", render: (c: any) => c.companyName ?? "—" },
    { key: "contact", label: "Email / phone", render: (c: any) => c.email ?? c.phone ?? "—" }, { key: "tags", label: "Tags", render: (c: any) => tagBadges(c.tags) }]} />;
}

export function Companies() {
  const fields: FieldDef[] = [{ key: "name", label: "Company name", required: true }, { key: "industry", label: "Industry" }, { key: "website", label: "Website", type: "url", hint: "Include https://" }, { key: "phone", label: "Phone", type: "tel" },
    { key: "address", label: "Address" }, { key: "tags", label: "Tags", type: "csv", hint: "Separate with commas." }, { key: "notes", label: "Notes", type: "textarea" }];
  return <EntityPage kind="companies" title="Companies" fields={fields} cols={[
    { key: "name", label: "Company", render: (c: any) => <strong>{c.name}</strong> }, { key: "industry", label: "Industry", render: (c: any) => c.industry ?? "—" },
    { key: "website", label: "Website", render: (c: any) => c.website ?? "—" }, { key: "tags", label: "Tags", render: (c: any) => tagBadges(c.tags) }]} />;
}

function StagesModal({ stages, base, onClose, onChanged }: { stages: any[]; base: string; onClose: () => void; onChanged: () => void }) {
  const { toast } = useToast(); const [names, setNames] = useState<Record<string, string>>(Object.fromEntries(stages.map((s) => [s.id, s.name]))); const [add, setAdd] = useState({ name: "", kind: "open" });
  const run = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); toast(ok); onChanged(); } catch (e) { toast(problem(e), "error"); } };
  const move = (i: number, d: -1 | 1) => { const ids = stages.map((s) => s.id); [ids[i], ids[i + d]] = [ids[i + d], ids[i]]; return run(() => put(`${base}/stages/order`, { ids }), "Order saved"); };
  return (
    <Modal open title="Customize pipeline stages" onClose={onClose}>
      <div className="stack">
        <p className="muted small">Stages run left to right. Won and Lost stages close a deal.</p>
        <ul className="list">{stages.map((s, i) => (
          <li key={s.id}><span className="row grow"><div className="grow"><TextField label={`Stage ${i + 1}`} value={names[s.id] ?? s.name} onChange={(e) => setNames((n) => ({ ...n, [s.id]: e.target.value }))} /></div>{s.kind !== "open" && <Badge tone={s.kind === "won" ? "ok" : "danger"}>{label(s.kind)}</Badge>}</span>
            <span className="actions"><Button small aria-label={`Move ${s.name} up`} disabled={i === 0} onClick={() => move(i, -1)}>↑</Button><Button small aria-label={`Move ${s.name} down`} disabled={i === stages.length - 1} onClick={() => move(i, 1)}>↓</Button>
              <Button small disabled={(names[s.id] ?? s.name).trim() === s.name || !(names[s.id] ?? "").trim()} onClick={() => run(() => patch(`${base}/stages/${s.id}`, { name: names[s.id].trim() }), "Renamed")}>Rename</Button>
              <Button small variant="danger" aria-label={`Delete ${s.name}`} onClick={() => run(() => del(`${base}/stages/${s.id}`), "Stage deleted")}>Delete</Button></span></li>
        ))}</ul>
        <div className="row" style={{ alignItems: "flex-end" }}><div className="grow"><TextField label="New stage" value={add.name} onChange={(e) => setAdd((a) => ({ ...a, name: e.target.value }))} /></div>
          <div style={{ width: 130 }}><SelectField label="Type" value={add.kind} onChange={(e) => setAdd((a) => ({ ...a, kind: e.target.value }))}><option value="open">Open</option><option value="won">Won</option><option value="lost">Lost</option></SelectField></div>
          <Button variant="primary" disabled={!add.name.trim()} onClick={() => run(async () => { await post(`${base}/stages`, { name: add.name.trim(), kind: add.kind }); setAdd({ name: "", kind: "open" }); }, "Stage added")}>Add</Button></div>
        <div className="actions"><Button onClick={onClose}>Done</Button></div>
      </div>
    </Modal>
  );
}

export function Pipeline() {
  useTitle("Pipeline"); const { current, can } = useBusiness(); const { toast } = useToast(); const base = `/api/businesses/${current!.id}/crm`; const members = useMembers(); const manage = can("crm.manage");
  const st = useFetch<any>(`${base}/stages`); const deals = useFetch<any>(`${base}/deals${qs({ limit: 100 })}`);
  const contacts = useFetch<any>(`${base}/contacts${qs({ limit: 100 })}`); const companies = useFetch<any>(`${base}/companies${qs({ limit: 100 })}`);
  const [edit, setEdit] = useState<{ row: any | null } | null>(null); const [stagesOpen, setStagesOpen] = useState(false); const [act, setAct] = useState<any>(null); const [lost, setLost] = useState<{ deal: any; stageId: string } | null>(null); const [rm, setRm] = useState<any>(null);
  const reload = () => { st.reload(); deals.reload(); };
  const stages: any[] = st.data?.stages ?? [];
  const moveTo = async (deal: any, stageId: string) => {
    const target = stages.find((s) => s.id === stageId); if (!target || stageId === deal.stageId) return;
    if (target.kind === "lost") return setLost({ deal, stageId });
    try { await patch(`${base}/deals/${deal.id}`, { stageId }); toast(`Moved to ${target.name}`); reload(); } catch (e) { toast(problem(e), "error"); reload(); }
  };
  const fields: FieldDef[] = [
    { key: "title", label: "Deal title", required: true }, { key: "value", label: "Value (₹)", type: "number", min: 0 },
    { key: "stageId", label: "Stage", type: "select", options: stages.map((s) => [s.id, s.name] as [string, string]) },
    { key: "contactId", label: "Contact", type: "select", nullWhenEmpty: true, options: [["", "None"], ...(contacts.data?.contacts.map((c: any) => [c.id, c.name]) ?? [])] as [string, string][] },
    { key: "companyId", label: "Company", type: "select", nullWhenEmpty: true, options: [["", "None"], ...(companies.data?.companies.map((c: any) => [c.id, c.name]) ?? [])] as [string, string][] },
    ...(members.options.length ? [{ key: "ownerId", label: "Owner", type: "select" as const, nullWhenEmpty: true, options: [["", "Unassigned"], ...members.options] as [string, string][] }] : []),
    { key: "expectedClose", label: "Expected close", type: "date", nullWhenEmpty: true }, { key: "tags", label: "Tags", type: "csv" },
  ];
  const err = st.error ?? deals.error;
  return (
    <div className="stack">
      <PageHeader title="Pipeline" crumbs={crumbs("Pipeline")}>{manage && <><Button onClick={() => setStagesOpen(true)}>Customize stages</Button><Button variant="primary" onClick={() => setEdit({ row: null })} disabled={!stages.length}>Add deal</Button></>}</PageHeader>
      {err ? <ErrorState error={err} retry={reload} /> : (st.loading && !st.data) || (deals.loading && !deals.data) ? <Spinner /> : (
        <div className="kanban">
          {stages.map((s) => {
            const items = deals.data.deals.filter((d: any) => d.stageId === s.id);
            return (
              <section key={s.id} className="col" aria-label={s.name}>
                <h2>{s.name} <Badge tone={s.kind === "won" ? "ok" : s.kind === "lost" ? "danger" : undefined}>{items.length}</Badge></h2>
                <p className="muted small" style={{ margin: 0 }}>{money(items.reduce((t: number, d: any) => t + d.value, 0))}</p>
                {items.map((d: any) => (
                  <article key={d.id} className="tcard">
                    <strong>{d.title}</strong>
                    <p className="small muted" style={{ margin: ".2rem 0" }}>{money(d.value)}{d.contactName ? ` · ${d.contactName}` : ""}{d.companyName ? ` · ${d.companyName}` : ""}{d.expectedClose ? ` · closes ${date(d.expectedClose)}` : ""}</p>
                    {d.status === "lost" && d.lostReason && <p className="small down">Lost: {d.lostReason}</p>}
                    <div className="row">{manage && <select className="select" style={{ width: "auto", minHeight: 44 }} aria-label={`Stage of ${d.title}`} value={d.stageId} onChange={(e) => moveTo(d, e.target.value)}>{stages.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>}
                      <Button small onClick={() => setAct(d)}>Activity</Button>{manage && <><Button small onClick={() => setEdit({ row: d })}>Edit</Button><Button small variant="danger" aria-label={`Delete ${d.title}`} onClick={() => setRm(d)}>×</Button></>}</div>
                  </article>
                ))}
                {!items.length && <p className="muted small" style={{ marginTop: ".6rem" }}>No deals</p>}
              </section>
            );
          })}
        </div>
      )}
      {edit && <FormModal title={edit.row ? "Edit deal" : "Add deal"} fields={fields} initial={edit.row ? { ...edit.row, title: edit.row.title } : { stageId: stages.find((s) => s.kind === "open")?.id }} onClose={() => setEdit(null)}
        onSubmit={async (b) => { edit.row ? await patch(`${base}/deals/${edit.row.id}`, b) : await post(`${base}/deals`, b); toast("Deal saved"); reload(); }} />}
      {lost && <FormModal title={`Mark “${lost.deal.title}” as lost`} fields={[{ key: "lostReason", label: "Why was it lost? (optional)", type: "textarea" }]} submitLabel="Mark as lost" onClose={() => { setLost(null); reload(); }}
        onSubmit={async (b) => { await patch(`${base}/deals/${lost.deal.id}`, { stageId: lost.stageId, ...b }); toast("Deal marked as lost"); reload(); }} />}
      {stagesOpen && <StagesModal stages={stages} base={base} onClose={() => setStagesOpen(false)} onChanged={reload} />}
      {act && <ActivityModal entityType="deal" entityId={act.id} name={act.title} onClose={() => setAct(null)} />}
      <ConfirmDialog open={!!rm} danger title="Delete this deal?" confirmLabel="Delete" message={rm && `“${rm.title}” and its activity history will be removed.`} onClose={() => setRm(null)}
        onConfirm={async () => { try { await del(`${base}/deals/${rm.id}`); toast("Deleted"); setRm(null); reload(); } catch (e) { toast(problem(e), "error"); setRm(null); } }} />
    </div>
  );
}

export function FollowUps() {
  useTitle("Follow-ups"); const { current, can } = useBusiness(); const { toast } = useToast(); const base = `/api/businesses/${current!.id}/crm/activities`; const manage = can("crm.manage");
  return (
    <ListPage title="Follow-ups and tasks" crumbs={crumbs("Follow-ups")} endpoint={base} listKey="activities" search={false}
      filters={[{ key: "due", label: "Due", initial: "", options: [["", "Any time"], ["overdue", "Overdue"], ["today", "Today"], ["upcoming", "Upcoming"]] }, { key: "done", label: "Status", initial: "false", options: [["false", "Open"], ["true", "Done"], ["", "All"]] }]}
      empty={<Empty title="Nothing to follow up">Add a follow-up from any lead, contact, company or deal.</Empty>}
      cols={[
        { key: "subject", label: "What", render: (a: any) => <><strong>{a.subject}</strong><br /><span className="muted small">{label(a.type)}</span></> },
        { key: "entityName", label: "About", render: (a: any) => <>{a.entityName ?? "—"} <Badge>{label(a.entityType)}</Badge></> },
        { key: "dueAt", label: "Due", render: (a: any) => (a.dueAt ? <span className={!a.doneAt && new Date(a.dueAt) < new Date() ? "down" : ""}>{dateTime(a.dueAt)}</span> : "—") },
        { key: "assigneeName", label: "Assigned to", render: (a: any) => a.assigneeName ?? "—" }, { key: "doneAt", label: "Status", render: (a: any) => (a.doneAt ? <Badge tone="ok">Done</Badge> : <Badge tone="warn">Open</Badge>) },
      ]}
      actions={manage ? (a: any, reload) => <>
        <Button small onClick={async () => { try { await post(`${base}/${a.id}/${a.doneAt ? "reopen" : "done"}`); toast(a.doneAt ? "Reopened" : "Marked done"); reload(); } catch (e) { toast(problem(e), "error"); } }}>{a.doneAt ? "Reopen" : "Mark done"}</Button>
      </> : undefined} />
  );
}
