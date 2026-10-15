import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PunchCard } from "../components/Punch";
import { Badge, Button, Card, ConfirmDialog, DataTable, Empty, ErrorState, Modal, PageHeader, Pagination, SelectField, Spinner, Stat, statusTone, TextArea, TextField } from "../components/ui";
import { ApiError, del, get, patch, post, put, qs } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useBusiness } from "../lib/business";
import { date, dateTime, hm, label } from "../lib/format";
import { useDebounce, useFetch, useTitle } from "../lib/hooks";
import { useToast } from "../lib/toast";

const problem = (e: unknown, fallback = "Something went wrong. Please try again.") => (e instanceof ApiError ? e.message : fallback);
const fieldErrs = (e: unknown): Record<string, string> => (e instanceof ApiError && e.code === "BAD_REQUEST" && e.details && typeof e.details === "object" ? e.details : {});

function PayFields({ v, set, errors }: { v: any; set: (k: string) => (e: any) => void; errors: Record<string, string> }) {
  return (
    <div className="form-grid">
      <SelectField label="Pay method" value={v.method} onChange={set("method")} error={errors.method}><option value="hourly">Hourly</option><option value="daily">Daily</option><option value="monthly">Monthly</option></SelectField>
      <TextField label={`Rate (₹ per ${v.method === "hourly" ? "hour" : v.method === "daily" ? "day" : "month"})`} type="number" inputMode="decimal" step="0.01" min="0" value={v.rate} onChange={set("rate")} error={errors.rate} />
      <TextField label="Standard hours per day" type="number" step="0.5" min="1" max="24" value={v.standardHoursPerDay} onChange={set("standardHoursPerDay")} error={errors.standardHoursPerDay} />
      <TextField label="Overtime multiplier" type="number" step="0.1" min="1" value={v.overtimeMultiplier} onChange={set("overtimeMultiplier")} error={errors.overtimeMultiplier} />
      <TextField label="Working days per month" type="number" min="1" max="31" value={v.standardDaysPerMonth} onChange={set("standardDaysPerMonth")} error={errors.standardDaysPerMonth} />
      <TextField label="Late-arrival penalty (₹)" type="number" step="0.01" min="0" value={v.latePenalty} onChange={set("latePenalty")} error={errors.latePenalty} />
    </div>
  );
}
const payDefaults = { method: "monthly", rate: "", standardHoursPerDay: "8", overtimeMultiplier: "1.5", standardDaysPerMonth: "26", latePenalty: "0" };
const payBody = (v: any) => ({ method: v.method, rate: Number(v.rate), standardHoursPerDay: Number(v.standardHoursPerDay), overtimeMultiplier: Number(v.overtimeMultiplier), standardDaysPerMonth: Number(v.standardDaysPerMonth), latePenalty: Number(v.latePenalty) });

export function Employees() {
  useTitle("Employees");
  const { current, can } = useBusiness(); const { toast } = useToast(); const base = `/api/businesses/${current!.id}`;
  const [q, setQ] = useState(""); const dq = useDebounce(q); const [status, setStatus] = useState("active"); const [offset, setOffset] = useState(0);
  const { data, error, loading, reload } = useFetch<any>(`${base}/employees${qs({ q: dq, status, limit: 25, offset })}`);
  const [edit, setEdit] = useState<any>(null); const [pay, setPay] = useState<any>(null); const [rm, setRm] = useState<any>(null);
  return (
    <div className="stack">
      <PageHeader title="Employees" crumbs={[{ to: "/app", label: "Dashboard" }, { label: "Employees" }]}>{can("employees.create") && <Link className="btn btn-primary" to="/app/employees/new">Add employee</Link>}</PageHeader>
      <div className="filters">
        <TextField label="Search" type="search" value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }} placeholder="Name, email, position or department" />
        <SelectField label="Status" value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }}><option value="active">Active</option><option value="inactive">Former</option><option value="">All</option></SelectField>
      </div>
      {error ? <ErrorState error={error} retry={reload} /> : loading && !data ? <Spinner /> : (
        <Card><DataTable rows={data.employees}
          empty={<Empty title="No employees found" action={can("employees.create") ? <Link className="btn btn-primary" to="/app/employees/new">Add your first employee</Link> : undefined}>Employees you add get their own login to punch in and see their work.</Empty>}
          cols={[
            { key: "fullName", label: "Name", render: (e: any) => <><strong>{e.fullName}</strong><br /><span className="muted small">{e.code} · {e.email}</span></> },
            { key: "position", label: "Position", render: (e: any) => e.position ?? "—" }, { key: "department", label: "Department", render: (e: any) => e.department ?? "—" },
            { key: "joiningDate", label: "Joined", render: (e: any) => date(e.joiningDate) }, { key: "status", label: "Status", render: (e: any) => <Badge tone={statusTone(e.status)}>{e.status === "inactive" ? "Former" : "Active"}</Badge> },
          ]}
          actions={(e: any) => e.status === "active" ? (<>
            {can("documents.view") && <Link className="btn btn-sm" to={`/app/employees/${e.id}/documents`}>Documents</Link>}
            {can("employees.edit") && <Button small onClick={() => setEdit(e)}>Edit</Button>}
            {can("salary.manage") && <Button small onClick={() => setPay(e)}>Pay settings</Button>}
            {can("employees.delete") && <Button small variant="danger" onClick={() => setRm(e)}>Remove</Button>}
          </>) : null} />
          <Pagination total={data.total} limit={25} offset={offset} onChange={setOffset} />
        </Card>
      )}
      {edit && <EditEmployee e={edit} base={base} onClose={() => setEdit(null)} onSaved={reload} />}
      {pay && <PayModal e={pay} base={base} onClose={() => setPay(null)} />}
      <ConfirmDialog open={!!rm} danger title="Remove employee?" confirmLabel="Remove" message={rm && `${rm.fullName} will lose access to this business. Their attendance and pay history are kept.`} onClose={() => setRm(null)}
        onConfirm={async () => { try { await del(`${base}/employees/${rm.id}`); toast("Employee removed"); setRm(null); reload(); } catch (e) { toast(problem(e), "error"); setRm(null); } }} />
    </div>
  );
}

function EditEmployee({ e, base, onClose, onSaved }: { e: any; base: string; onClose: () => void; onSaved: () => void }) {
  const { toast } = useToast(); const [f, setF] = useState({ position: e.position ?? "", department: e.department ?? "", phone: e.phone ?? "", joiningDate: e.joiningDate?.slice(0, 10) ?? "" });
  const [errors, setErrors] = useState<Record<string, string>>({}); const [busy, setBusy] = useState(false);
  const set = (k: string) => (ev: any) => setF((s) => ({ ...s, [k]: ev.target.value }));
  const submit = async (ev: FormEvent) => {
    ev.preventDefault(); setBusy(true); setErrors({});
    try { await patch(`${base}/employees/${e.id}`, { position: f.position, department: f.department, phone: f.phone, ...(f.joiningDate ? { joiningDate: f.joiningDate } : {}) }); toast("Employee saved"); onSaved(); onClose(); }
    catch (err) { setErrors({ ...fieldErrs(err), _: problem(err) }); } finally { setBusy(false); }
  };
  return (
    <Modal open title={`Edit ${e.fullName}`} onClose={onClose}>
      <form className="stack" onSubmit={submit} noValidate>
        {errors._ && !Object.keys(errors).some((k) => k !== "_") && <div className="banner error" role="alert">{errors._}</div>}
        <div className="form-grid">
          <TextField label="Position" value={f.position} onChange={set("position")} error={errors.position} /><TextField label="Department" value={f.department} onChange={set("department")} error={errors.department} />
          <TextField label="Phone" type="tel" value={f.phone} onChange={set("phone")} error={errors.phone} /><TextField label="Joining date" type="date" value={f.joiningDate} onChange={set("joiningDate")} error={errors.joiningDate} />
        </div>
        <div className="actions"><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" loading={busy}>Save</Button></div>
      </form>
    </Modal>
  );
}

function PayModal({ e, base, onClose }: { e: any; base: string; onClose: () => void }) {
  const { toast } = useToast(); const { can } = useBusiness(); const [v, setV] = useState<any>(payDefaults); const [ready, setReady] = useState(!can("salary.view"));
  const [errors, setErrors] = useState<Record<string, string>>({}); const [busy, setBusy] = useState(false);
  useEffect(() => { if (!can("salary.view")) return; get(`${base}/employees/${e.id}`).then(({ employee }) => { const c = employee.salaryConfig; if (c) setV(Object.fromEntries(Object.entries(c).map(([k, x]) => [k, String(x)]))); setReady(true); }).catch(() => setReady(true)); /* eslint-disable-next-line */ }, []);
  const set = (k: string) => (ev: any) => setV((s: any) => ({ ...s, [k]: ev.target.value }));
  const submit = async (ev: FormEvent) => {
    ev.preventDefault(); setBusy(true); setErrors({});
    if (v.rate === "" || Number.isNaN(Number(v.rate))) { setErrors({ rate: "Enter the pay rate" }); setBusy(false); return; }
    try { await put(`${base}/employees/${e.id}/salary-config`, payBody(v)); toast("Pay settings saved"); onClose(); } catch (err) { setErrors({ ...fieldErrs(err), _: problem(err) }); } finally { setBusy(false); }
  };
  return (
    <Modal open title={`Pay settings: ${e.fullName}`} onClose={onClose}>
      {!ready ? <Spinner /> : (
        <form className="stack" onSubmit={submit} noValidate>
          {errors._ && <div className="banner error" role="alert">{errors._}</div>}
          <PayFields v={v} set={set} errors={errors} />
          <div className="actions"><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" loading={busy}>Save</Button></div>
        </form>
      )}
    </Modal>
  );
}

export function EmployeeForm() {
  useTitle("Add employee");
  const { current, can } = useBusiness(); const { toast } = useToast(); const nav = useNavigate();
  const [f, setF] = useState({ fullName: "", email: "", position: "", department: "", phone: "", joiningDate: "" }); const [pay, setPay] = useState<any>(payDefaults); const [withPay, setWithPay] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({}); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const set = (k: string) => (e: any) => setF((s) => ({ ...s, [k]: e.target.value }));
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(""); setErrors({});
    const body: any = Object.fromEntries(Object.entries(f).filter(([, v]) => v.trim() !== "").map(([k, v]) => [k, v.trim()]));
    if (withPay && can("salary.manage")) { if (pay.rate === "") { setErrors({ rate: "Enter the pay rate" }); setBusy(false); return; } body.salary = payBody(pay); }
    try { await post(`/api/businesses/${current!.id}/employees`, body); toast(`Invitation sent to ${f.email}`); nav("/app/employees"); }
    catch (err) { setErrors(fieldErrs(err)); setError(problem(err)); } finally { setBusy(false); }
  };
  return (
    <div className="stack">
      <PageHeader title="Add employee" crumbs={[{ to: "/app", label: "Dashboard" }, { to: "/app/employees", label: "Employees" }, { label: "New" }]} />
      <Card>
        <form className="stack" onSubmit={submit} noValidate>
          {error && <div className="banner error" role="alert">{error}</div>}
          <p className="muted">We'll email them a link to set their password. They get their own login to punch in, see tasks and view their pay.</p>
          <div className="form-grid">
            <TextField label="Full name" required value={f.fullName} onChange={set("fullName")} error={errors.fullName} /><TextField label="Email" type="email" required value={f.email} onChange={set("email")} error={errors.email} />
            <TextField label="Position" value={f.position} onChange={set("position")} error={errors.position} /><TextField label="Department" value={f.department} onChange={set("department")} error={errors.department} />
            <TextField label="Phone" type="tel" value={f.phone} onChange={set("phone")} error={errors.phone} /><TextField label="Joining date" type="date" value={f.joiningDate} onChange={set("joiningDate")} error={errors.joiningDate} />
          </div>
          {can("salary.manage") && <label className="check"><input type="checkbox" checked={withPay} onChange={(e) => setWithPay(e.target.checked)} /> <span>Set pay details now</span></label>}
          {withPay && <PayFields v={pay} set={(k) => (e: any) => setPay((s: any) => ({ ...s, [k]: e.target.value }))} errors={errors} />}
          <div className="actions"><Button type="submit" variant="primary" loading={busy}>Send invitation</Button><Link className="btn" to="/app/employees">Cancel</Link></div>
        </form>
      </Card>
    </div>
  );
}

const thisMonth = () => new Date().toISOString().slice(0, 7);
const monthRange = (m: string) => { const [y, mo] = m.split("-").map(Number); return { from: `${m}-01`, to: `${m}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, "0")}` }; };

export function Attendance() {
  useTitle("Attendance");
  const { user } = useAuth(); const { can } = useBusiness();
  const isEmployee = user?.accountType === "employee"; const isManager = can("attendance.view");
  const [tab, setTab] = useState<"me" | "team">(isEmployee ? "me" : "team");
  return (
    <div className="stack">
      <PageHeader title="Attendance" crumbs={[{ to: "/app", label: "Dashboard" }, { label: "Attendance" }]} />
      {isEmployee && isManager && <div className="tabs" role="group" aria-label="Attendance view"><Button aria-pressed={tab === "me"} onClick={() => setTab("me")}>My attendance</Button><Button aria-pressed={tab === "team"} onClick={() => setTab("team")}>Team</Button></div>}
      {tab === "me" && isEmployee ? <MyAttendance /> : <TeamAttendance />}
    </div>
  );
}

function MyAttendance() {
  const { current } = useBusiness(); const [month, setMonth] = useState(thisMonth());
  const { data, error, loading, reload } = useFetch<any>(`/api/businesses/${current!.id}/me/attendance${qs({ month })}`);
  return (
    <div className="stack">
      <PunchCard onChange={reload} />
      <div className="filters"><TextField label="Month" type="month" value={month} max={thisMonth()} onChange={(e) => e.target.value && setMonth(e.target.value)} /></div>
      {error ? <ErrorState error={error} retry={reload} /> : loading && !data ? <Spinner /> : (<>
        <div className="grid cols-3"><Stat label="Days present" value={data.summary.daysPresent} /><Stat label="Hours worked" value={data.summary.hoursWorked} /><Stat label="Late days" value={data.summary.lateDays} /></div>
        <Card><DataTable rows={data.records} empty={<Empty title="No attendance this month" />}
          cols={[
            { key: "workDate", label: "Date", render: (r: any) => date(r.workDate) }, { key: "punchIn", label: "In", render: (r: any) => dateTime(r.punchIn) }, { key: "punchOut", label: "Out", render: (r: any) => (r.punchOut ? dateTime(r.punchOut) : <Badge tone="info">On the clock</Badge>) },
            { key: "minutesWorked", label: "Worked", num: true, render: (r: any) => (r.minutesWorked == null ? "—" : hm(r.minutesWorked)) },
            { key: "flags", label: "Flags", render: (r: any) => <>{r.isLate && <Badge tone="warn">Late</Badge>} {r.leftEarly && <Badge tone="warn">Left early</Badge>}{!r.isLate && !r.leftEarly && "—"}</> },
          ]} /></Card>
      </>)}
    </div>
  );
}

function TeamAttendance() {
  const { current, can } = useBusiness(); const base = `/api/businesses/${current!.id}`; const [month, setMonth] = useState(thisMonth()); const [offset, setOffset] = useState(0); const [fix, setFix] = useState<any>(null);
  const { from, to } = monthRange(month);
  const rep = useFetch<any>(`${base}/attendance/report${qs({ month })}`);
  const recs = useFetch<any>(`${base}/attendance${qs({ from, to, limit: 25, offset })}`);
  return (
    <div className="stack">
      <div className="filters"><TextField label="Month" type="month" value={month} max={thisMonth()} onChange={(e) => { if (e.target.value) { setMonth(e.target.value); setOffset(0); } }} /></div>
      {rep.error ? <ErrorState error={rep.error} retry={rep.reload} /> : rep.loading && !rep.data ? <Spinner /> : (
        <Card title="Team summary"><DataTable rows={rep.data.employees.map((e: any) => ({ ...e, id: e.employeeId }))} empty={<Empty title="No employees yet" />}
          cols={[{ key: "fullName", label: "Employee" }, { key: "daysPresent", label: "Days present", num: true }, { key: "hoursWorked", label: "Hours", num: true }, { key: "lateDays", label: "Late days", num: true }, { key: "earlyDepartureDays", label: "Early departures", num: true }]} /></Card>
      )}
      {recs.data && (
        <Card title="Records">
          <DataTable rows={recs.data.records} empty={<Empty title="No records in this month" />}
            cols={[
              { key: "employeeName", label: "Employee" }, { key: "workDate", label: "Date", render: (r: any) => date(r.workDate) }, { key: "punchIn", label: "In", render: (r: any) => dateTime(r.punchIn) },
              { key: "punchOut", label: "Out", render: (r: any) => (r.punchOut ? dateTime(r.punchOut) : <Badge tone="info">Open</Badge>) }, { key: "minutesWorked", label: "Worked", num: true, render: (r: any) => (r.minutesWorked == null ? "—" : hm(r.minutesWorked)) },
              { key: "flags", label: "Flags", render: (r: any) => <>{r.isLate && <Badge tone="warn">Late</Badge>} {r.leftEarly && <Badge tone="warn">Early</Badge>}{!r.isLate && !r.leftEarly && "—"}</> },
            ]}
            actions={can("attendance.manage") ? (r: any) => <Button small onClick={() => setFix(r)}>Correct</Button> : undefined} />
          <Pagination total={recs.data.total} limit={25} offset={offset} onChange={setOffset} />
        </Card>
      )}
      {fix && <CorrectModal rec={fix} base={base} onClose={() => setFix(null)} onDone={() => { rep.reload(); recs.reload(); }} />}
    </div>
  );
}

const local = (iso?: string | null) => (iso ? new Date(new Date(iso).getTime() - new Date(iso).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "");

function CorrectModal({ rec, base, onClose, onDone }: { rec: any; base: string; onClose: () => void; onDone: () => void }) {
  const { toast } = useToast(); const [pin, setPin] = useState(local(rec.punchIn)); const [pout, setPout] = useState(local(rec.punchOut)); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError("");
    try { await patch(`${base}/attendance/${rec.id}`, { punchIn: new Date(pin).toISOString(), ...(pout ? { punchOut: new Date(pout).toISOString() } : {}) }); toast("Attendance corrected"); onDone(); onClose(); }
    catch (err) { setError(problem(err)); } finally { setBusy(false); }
  };
  return (
    <Modal open title={`Correct attendance: ${rec.employeeName}`} onClose={onClose}>
      <form className="stack" onSubmit={submit} noValidate>
        {error && <div className="banner error" role="alert">{error}</div>}
        <p className="muted small">Use this to fix a forgotten punch-out. Changes are recorded in the audit log.</p>
        <TextField label="Punched in" type="datetime-local" value={pin} onChange={(e) => setPin(e.target.value)} required />
        <TextField label="Punched out" type="datetime-local" value={pout} onChange={(e) => setPout(e.target.value)} />
        <div className="actions"><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" loading={busy} disabled={!pin}>Save</Button></div>
      </form>
    </Modal>
  );
}

const COLS: [string, string][] = [["todo", "To do"], ["in_progress", "In progress"], ["review", "In review"], ["completed", "Completed"]];

export function Tasks() {
  useTitle("Tasks");
  const { current, can } = useBusiness(); const { user } = useAuth(); const { toast } = useToast(); const base = `/api/businesses/${current!.id}`;
  const { data, error, loading, reload } = useFetch<any>(`${base}/tasks${qs({ limit: 100 })}`);
  const [adding, setAdding] = useState(false); const [open, setOpen] = useState<string | null>(null); const manage = can("tasks.manage");
  const move = async (t: any, status: string) => { try { await patch(`${base}/tasks/${t.id}`, { status }); reload(); } catch (e) { toast(problem(e), "error"); reload(); } };
  return (
    <div className="stack">
      <PageHeader title="Tasks" crumbs={[{ to: "/app", label: "Dashboard" }, { label: "Tasks" }]}>{manage && <Button variant="primary" onClick={() => setAdding(true)}>New task</Button>}</PageHeader>
      {!manage && <p className="muted">You can see and update the tasks assigned to you.</p>}
      {error ? <ErrorState error={error} retry={reload} /> : loading && !data ? <Spinner /> : (
        <div className="kanban">
          {COLS.map(([s, name]) => {
            const items = data.tasks.filter((t: any) => t.status === s);
            return (
              <section key={s} className="col" aria-label={name}>
                <h2>{name} <Badge>{items.length}</Badge></h2>
                {items.map((t: any) => {
                  const overdue = t.dueDate && t.dueDate < new Date().toISOString().slice(0, 10) && s !== "completed";
                  const opts = manage ? [...COLS.map(([v]) => v), "cancelled"] : ["todo", "in_progress", "review"];
                  return (
                    <article key={t.id} className="tcard">
                      <button className="btn btn-ghost" style={{ padding: 0, justifyContent: "flex-start", textAlign: "left", fontWeight: 700 }} onClick={() => setOpen(t.id)}>{t.title}</button>
                      <p className="small muted" style={{ margin: ".25rem 0" }}>{t.assigneeName ?? "Unassigned"}{t.dueDate && <> · <span className={overdue ? "down" : ""}>Due {date(t.dueDate)}</span></>}</p>
                      <div className="row"><Badge tone={t.priority === "urgent" || t.priority === "high" ? "danger" : undefined}>{label(t.priority)}</Badge>
                        {opts.includes(t.status) && <select className="select" style={{ width: "auto", minHeight: 44 }} aria-label={`Status of ${t.title}`} value={t.status} onChange={(e) => move(t, e.target.value)}>{opts.map((v) => <option key={v} value={v}>{label(v)}</option>)}</select>}
                      </div>
                    </article>
                  );
                })}
                {!items.length && <p className="muted small" style={{ marginTop: ".6rem" }}>Nothing here</p>}
              </section>
            );
          })}
        </div>
      )}
      {adding && <TaskForm base={base} onClose={() => setAdding(false)} onSaved={reload} />}
      {open && <TaskDetail id={open} base={base} me={user!.id} onClose={() => setOpen(null)} onChanged={reload} />}
    </div>
  );
}

function TaskForm({ base, onClose, onSaved }: { base: string; onClose: () => void; onSaved: () => void }) {
  const { can } = useBusiness(); const { toast } = useToast(); const members = useFetch<any>(can("members.view") ? `${base}/members` : null);
  const [f, setF] = useState({ title: "", description: "", assignedTo: "", priority: "medium", dueDate: "" }); const [errors, setErrors] = useState<Record<string, string>>({}); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const set = (k: string) => (e: any) => setF((s) => ({ ...s, [k]: e.target.value }));
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(""); setErrors({});
    const body: any = { title: f.title.trim(), priority: f.priority }; if (f.description.trim()) body.description = f.description.trim(); if (f.assignedTo) body.assignedTo = f.assignedTo; if (f.dueDate) body.dueDate = f.dueDate;
    try { await post(`${base}/tasks`, body); toast("Task created"); onSaved(); onClose(); } catch (err) { setErrors(fieldErrs(err)); setError(problem(err)); } finally { setBusy(false); }
  };
  return (
    <Modal open title="New task" onClose={onClose}>
      <form className="stack" onSubmit={submit} noValidate>
        {error && <div className="banner error" role="alert">{error}</div>}
        <TextField label="Title" required value={f.title} onChange={set("title")} error={errors.title} maxLength={200} />
        <TextArea label="Description" value={f.description} onChange={set("description")} error={errors.description} />
        <div className="form-grid">
          {members.data && <SelectField label="Assign to" value={f.assignedTo} onChange={set("assignedTo")}><option value="">Unassigned</option>{members.data.members.map((m: any) => <option key={m.userId} value={m.userId}>{m.fullName}</option>)}</SelectField>}
          <SelectField label="Priority" value={f.priority} onChange={set("priority")}>{["low", "medium", "high", "urgent"].map((p) => <option key={p} value={p}>{label(p)}</option>)}</SelectField>
          <TextField label="Due date" type="date" value={f.dueDate} onChange={set("dueDate")} error={errors.dueDate} />
        </div>
        <div className="actions"><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" loading={busy} disabled={!f.title.trim()}>Create task</Button></div>
      </form>
    </Modal>
  );
}

function TaskDetail({ id, base, onClose, onChanged }: { id: string; base: string; me: string; onClose: () => void; onChanged: () => void }) {
  const { toast } = useToast(); const { data, error, loading, reload } = useFetch<{ task: any }>(`${base}/tasks/${id}`); const [text, setText] = useState(""); const [busy, setBusy] = useState(false);
  const t = data?.task;
  const send = async (e: FormEvent) => { e.preventDefault(); setBusy(true); try { await post(`${base}/tasks/${id}/comments`, { body: text.trim() }); setText(""); reload(); onChanged(); } catch (err) { toast(problem(err), "error"); } finally { setBusy(false); } };
  return (
    <Modal open title={t?.title ?? "Task"} onClose={onClose}>
      {error ? <ErrorState error={error} retry={reload} /> : loading && !t ? <Spinner /> : t && (
        <div className="stack">
          <p className="small muted"><Badge tone={statusTone(t.status)}>{label(t.status)}</Badge> · {label(t.priority)} priority · {t.assigneeName ?? "Unassigned"}{t.dueDate && ` · due ${date(t.dueDate)}`}</p>
          {t.description && <p>{t.description}</p>}
          <h3>Comments</h3>
          {t.comments.length ? <ul className="list">{t.comments.map((c: any) => <li key={c.id}><span><strong>{c.authorName}</strong><br />{c.body}</span><span className="muted small">{dateTime(c.createdAt)}</span></li>)}</ul> : <p className="muted small">No comments yet.</p>}
          <form className="stack" onSubmit={send}><TextArea label="Add a comment" value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} /><div><Button type="submit" variant="primary" loading={busy} disabled={!text.trim()}>Comment</Button></div></form>
          <details><summary>Activity ({t.activity.length})</summary><ul className="list">{t.activity.map((a: any) => <li key={a.id}><span>{label(a.action)} <span className="muted small">{a.actorName}</span></span><span className="muted small">{dateTime(a.createdAt)}</span></li>)}</ul></details>
        </div>
      )}
    </Modal>
  );
}
