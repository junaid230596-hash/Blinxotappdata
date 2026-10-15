import { useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError, patch, post, qs } from "../lib/api";
import { useBusiness } from "../lib/business";
import { date, dateTime, label, money } from "../lib/format";
import { useDebounce, useFetch, useTitle } from "../lib/hooks";
import { useToast } from "../lib/toast";
import { STATES, stateName } from "../lib/states";
import { Badge, Button, Card, DataTable, Empty, ErrorState, Modal, PageHeader, Pagination, SelectField, Spinner, Stat, statusTone, TextArea, TextField } from "../components/ui";

function CustomerForm({ customer, onClose, onSaved }: { customer?: any; onClose: () => void; onSaved: () => void }) {
  const { current } = useBusiness(); const { toast } = useToast();
  const [f, setF] = useState({ name: customer?.name ?? "", phone: customer?.phone ?? "", email: customer?.email ?? "", address: customer?.address ?? "", notes: customer?.notes ?? "", gstin: customer?.gstin ?? "", stateCode: customer?.stateCode ?? "", status: customer?.status ?? "active" });
  const [errors, setErrors] = useState<Record<string, string>>({}); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const set = (k: string) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(""); setErrors({});
    const body: any = {}; for (const [k, v] of Object.entries(f)) if (customer || String(v).trim() !== "") body[k] = typeof v === "string" ? v.trim() : v; if (!customer) delete body.status; if (body.gstin) { body.gstin = body.gstin.toUpperCase(); delete body.stateCode; }
    try {
      if (customer) await patch(`/api/businesses/${current!.id}/customers/${customer.id}`, body); else await post(`/api/businesses/${current!.id}/customers`, body);
      toast(customer ? "Customer saved" : "Customer added"); onSaved(); onClose();
    } catch (err) { if (err instanceof ApiError) { setErrors(err.details && typeof err.details === "object" ? err.details : {}); setError(err.message); } else setError("Something went wrong."); } finally { setBusy(false); }
  };
  return (
    <Modal open title={customer ? "Edit customer" : "Add customer"} onClose={onClose}>
      <form className="stack" onSubmit={submit} noValidate>
        {error && <div className="banner error" role="alert">{error}</div>}
        <TextField label="Name" required value={f.name} onChange={set("name")} error={errors.name} />
        <div className="form-grid"><TextField label="Phone" type="tel" inputMode="tel" value={f.phone} onChange={set("phone")} error={errors.phone} /><TextField label="Email" type="email" value={f.email} onChange={set("email")} error={errors.email} /></div>
        <TextField label="Address" value={f.address} onChange={set("address")} error={errors.address} />
        <div className="form-grid"><TextField label="GSTIN (optional)" value={f.gstin} onChange={set("gstin")} error={errors.gstin} hint="For business customers; appears on their tax invoice" autoCapitalize="characters" /><SelectField label="State" value={f.stateCode} onChange={set("stateCode")} error={errors.stateCode}><option value="">Not set</option>{STATES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</SelectField></div>
        <TextArea label="Notes" value={f.notes} onChange={set("notes")} error={errors.notes} />
        {customer && <SelectField label="Status" value={f.status} onChange={set("status")}><option value="active">Active</option><option value="inactive">Inactive</option></SelectField>}
        <div className="actions"><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" loading={busy}>Save</Button></div>
      </form>
    </Modal>
  );
}

export function Customers() {
  useTitle("Customers");
  const { current, can } = useBusiness(); const [q, setQ] = useState(""); const dq = useDebounce(q); const [sort, setSort] = useState("name"); const [offset, setOffset] = useState(0); const [adding, setAdding] = useState(false);
  const { data, error, loading, reload } = useFetch<any>(`/api/businesses/${current!.id}/customers${qs({ q: dq, sort, dir: sort === "name" ? "asc" : "desc", limit: 25, offset })}`);
  return (
    <div className="stack">
      <PageHeader title="Customers" crumbs={[{ to: "/app", label: "Dashboard" }, { label: "Customers" }]}>{can("customers.manage") && <Button variant="primary" onClick={() => setAdding(true)}>Add customer</Button>}</PageHeader>
      <div className="filters">
        <TextField label="Search" type="search" value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }} placeholder="Name, email or phone" />
        <SelectField label="Sort by" value={sort} onChange={(e) => { setSort(e.target.value); setOffset(0); }}><option value="name">Name</option><option value="spent">Total spent</option><option value="last">Last interaction</option><option value="created">Newest</option></SelectField>
      </div>
      {error ? <ErrorState error={error} retry={reload} /> : loading && !data ? <Spinner /> : (
        <Card><DataTable rows={data.customers} empty={<Empty title="No customers yet">Add customers to track their orders and conversations.</Empty>}
          cols={[
            { key: "name", label: "Customer", render: (c: any) => <><Link to={`/app/customers/${c.id}`}><strong>{c.name}</strong></Link><br /><span className="muted small">{c.code}</span></> },
            { key: "contact", label: "Contact", render: (c: any) => c.email ?? c.phone ?? "—" },
            { key: "orderCount", label: "Orders", num: true }, { key: "totalSpent", label: "Total spent", num: true, render: (c: any) => money(c.totalSpent) },
            { key: "lastInteraction", label: "Last interaction", render: (c: any) => date(c.lastInteraction) },
          ]} />
          <Pagination total={data.total} limit={25} offset={offset} onChange={setOffset} />
        </Card>
      )}
      {adding && <CustomerForm onClose={() => setAdding(false)} onSaved={reload} />}
    </div>
  );
}

export function CustomerDetail() {
  const { id } = useParams(); const { current, can } = useBusiness(); const { toast } = useToast(); const base = `/api/businesses/${current!.id}/customers/${id}`;
  const { data, error, loading, reload } = useFetch<{ customer: any }>(base);
  const [editing, setEditing] = useState(false); const [type, setType] = useState("call"); const [summary, setSummary] = useState(""); const [busy, setBusy] = useState(false);
  const c = data?.customer; useTitle(c?.name ?? "Customer");
  if (error) return <ErrorState error={error} retry={reload} />;
  if (loading && !c) return <Spinner />;
  if (!c) return null;
  const log = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true);
    try { await post(`${base}/communications`, { type, summary: summary.trim() }); setSummary(""); toast("Logged"); reload(); } catch (err) { toast(err instanceof ApiError ? err.message : "Could not log", "error"); } finally { setBusy(false); }
  };
  return (
    <div className="stack">
      <PageHeader title={c.name} crumbs={[{ to: "/app", label: "Dashboard" }, { to: "/app/customers", label: "Customers" }, { label: c.name }]}>{can("customers.manage") && <Button onClick={() => setEditing(true)}>Edit</Button>}</PageHeader>
      <div className="grid cols-3"><Stat label="Total spent" value={money(c.totalSpent)} /><Stat label="Orders" value={c.orderCount} /><Stat label="Last interaction" value={date(c.lastInteraction)} /></div>
      <div className="grid cols-2">
        <Card title="Details"><ul className="list">
          <li><span className="muted">Email</span><span>{c.email ?? "—"}</span></li><li><span className="muted">Phone</span><span>{c.phone ?? "—"}</span></li>
          <li><span className="muted">Address</span><span>{c.address ?? "—"}</span></li>{c.gstin && <li><span className="muted">GSTIN</span><span>{c.gstin} · {stateName(c.stateCode)}</span></li>}<li><span className="muted">Status</span><Badge tone={statusTone(c.status)}>{label(c.status)}</Badge></li>
          {c.notes && <li><span className="muted">Notes</span><span>{c.notes}</span></li>}
        </ul></Card>
        <Card title="Recent orders">{c.orders.length ? <ul className="list">{c.orders.map((o: any) => <li key={o.id}><span><Link to={`/app/orders/${o.id}`}>{o.orderNumber}</Link><br /><span className="muted small">{date(o.createdAt)}</span></span><span className="right">{money(o.total)}<br /><Badge tone={statusTone(o.status)}>{label(o.status)}</Badge></span></li>)}</ul> : <Empty title="No orders yet" />}</Card>
      </div>
      <Card title="Conversations">
        {can("customers.manage") && (
          <form className="stack" onSubmit={log} style={{ marginBottom: "1rem" }}>
            <div className="form-grid"><SelectField label="Type" value={type} onChange={(e) => setType(e.target.value)}>{["call", "email", "meeting", "sms", "note"].map((t) => <option key={t} value={t}>{label(t)}</option>)}</SelectField></div>
            <TextArea label="What was discussed?" value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={2000} required />
            <div><Button type="submit" variant="primary" loading={busy} disabled={!summary.trim()}>Log conversation</Button></div>
          </form>
        )}
        {c.communications.length ? <ul className="list">{c.communications.map((m: any) => <li key={m.id}><span><Badge>{label(m.type)}</Badge> {m.summary}<br /><span className="muted small">{m.authorName ?? "—"}</span></span><span className="muted small">{dateTime(m.createdAt)}</span></li>)}</ul> : <Empty title="No conversations logged" />}
      </Card>
      {editing && <CustomerForm customer={c} onClose={() => setEditing(false)} onSaved={reload} />}
    </div>
  );
}
