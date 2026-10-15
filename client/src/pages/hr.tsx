import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { FormModal, ListPage, type FieldDef } from "../components/forms";
import { Badge, Button, Card, ConfirmDialog, DataTable, Empty, ErrorState, Modal, PageHeader, Spinner, Stat, statusTone } from "../components/ui";
import { ApiError, api, del, download, patch, post, qs } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useBusiness } from "../lib/business";
import { date, label } from "../lib/format";
import { useFetch, useTitle } from "../lib/hooks";
import { useToast } from "../lib/toast";

const problem = (e: unknown, fb = "Something went wrong. Please try again.") => (e instanceof ApiError ? e.message : fb);
const stars = (n: number) => `${"★".repeat(n)}${"☆".repeat(5 - n)}`;

// ------------------------------ leave ------------------------------
const LEAVE_TYPES = ["casual", "sick", "paid", "unpaid", "other"].map((t) => [t, label(t)] as [string, string]);

function MyLeave() {
  const { current } = useBusiness(); const { toast } = useToast(); const base = `/api/businesses/${current!.id}/me/leave`;
  const { data, error, loading, reload } = useFetch<any>(base); const [ask, setAsk] = useState(false); const [rm, setRm] = useState<any>(null);
  const today = new Date().toISOString().slice(0, 10);
  const fields: FieldDef[] = [{ key: "type", label: "Type of leave", type: "select", options: LEAVE_TYPES }, { key: "startDate", label: "First day", type: "date", required: true, min: undefined }, { key: "endDate", label: "Last day", type: "date", required: true }, { key: "reason", label: "Reason (optional)", type: "textarea" }];
  return (
    <div className="stack">
      <div className="row between"><p className="muted" style={{ margin: 0 }}>Request time off and track its approval.</p><Button variant="primary" onClick={() => setAsk(true)}>Request leave</Button></div>
      {error ? <ErrorState error={error} retry={reload} /> : loading && !data ? <Spinner /> : (<>
        {Object.keys(data.approvedDaysThisYear).length > 0 && <div className="grid cols-4">{Object.entries(data.approvedDaysThisYear).map(([t, d]) => <Stat key={t} label={`${label(t)} leave taken this year`} value={`${d} day${d === 1 ? "" : "s"}`} />)}</div>}
        <Card><DataTable rows={data.leave} empty={<Empty title="No leave requests">Your requests will appear here.</Empty>} cols={[
          { key: "type", label: "Type", render: (l: any) => label(l.type) }, { key: "dates", label: "Dates", render: (l: any) => `${date(l.startDate)}${l.endDate !== l.startDate ? ` – ${date(l.endDate)}` : ""}` }, { key: "days", label: "Days", num: true },
          { key: "status", label: "Status", render: (l: any) => <><Badge tone={statusTone(l.status)}>{label(l.status)}</Badge>{l.decisionNote && <><br /><span className="muted small">{l.decisionNote}</span></>}</> },
        ]} actions={(l: any) => (l.status === "pending" || (l.status === "approved" && l.startDate > today)) ? <Button small variant="danger" onClick={() => setRm(l)}>Cancel</Button> : null} /></Card>
      </>)}
      {ask && <FormModal title="Request leave" fields={fields} submitLabel="Send request" onClose={() => setAsk(false)} onSubmit={async (b) => { await post(base, b); toast("Leave requested"); reload(); }} />}
      <ConfirmDialog open={!!rm} danger title="Cancel this leave request?" confirmLabel="Cancel request" message="Your manager will be told if it was already approved." onClose={() => setRm(null)}
        onConfirm={async () => { try { await post(`${base}/${rm.id}/cancel`); toast("Leave cancelled"); setRm(null); reload(); } catch (e) { toast(problem(e), "error"); setRm(null); } }} />
    </div>
  );
}

function TeamLeave() {
  const { current, can } = useBusiness(); const { toast } = useToast(); const base = `/api/businesses/${current!.id}/leave`; const [decide, setDecide] = useState<{ row: any; decision: "approved" | "rejected" } | null>(null);
  return (
    <ListPage title="Team leave" endpoint={base} listKey="leave" search={false} filters={[{ key: "status", label: "Status", initial: "pending", options: [["pending", "Pending"], ["approved", "Approved"], ["rejected", "Rejected"], ["cancelled", "Cancelled"], ["", "All"]] }]}
      empty={<Empty title="No leave requests here">Requests from your team appear here for approval.</Empty>}
      cols={[
        { key: "employeeName", label: "Employee", render: (l: any) => <strong>{l.employeeName}</strong> }, { key: "type", label: "Type", render: (l: any) => label(l.type) },
        { key: "dates", label: "Dates", render: (l: any) => `${date(l.startDate)}${l.endDate !== l.startDate ? ` – ${date(l.endDate)}` : ""} (${l.days}d)` }, { key: "reason", label: "Reason", render: (l: any) => l.reason ?? "—" },
        { key: "status", label: "Status", render: (l: any) => <Badge tone={statusTone(l.status)}>{label(l.status)}</Badge> },
      ]}
      actions={can("leave.manage") ? (l: any) => l.status === "pending" ? <><Button small variant="primary" onClick={() => setDecide({ row: l, decision: "approved" })}>Approve</Button><Button small variant="danger" onClick={() => setDecide({ row: l, decision: "rejected" })}>Reject</Button></> : null : undefined}>
      {(reload) => decide && <FormModal title={`${decide.decision === "approved" ? "Approve" : "Reject"} leave for ${decide.row.employeeName}`} fields={[{ key: "note", label: "Note to the employee (optional)", type: "textarea" }]} submitLabel={decide.decision === "approved" ? "Approve" : "Reject"} onClose={() => setDecide(null)}
        onSubmit={async (b) => { await patch(`${base}/${decide.row.id}/decision`, { decision: decide.decision, ...b }); toast(`Leave ${decide.decision}`); reload(); }} />}
    </ListPage>
  );
}

export function Leave() {
  useTitle("Leave"); const { user } = useAuth(); const { can } = useBusiness(); const isEmp = user?.accountType === "employee"; const isMgr = can("leave.view");
  const [tab, setTab] = useState<"me" | "team">(isEmp ? "me" : "team");
  return (
    <div className="stack">
      <PageHeader title="Leave" crumbs={[{ to: "/app", label: "Dashboard" }, { label: "Leave" }]} />
      {isEmp && isMgr && <div className="tabs" role="group" aria-label="Leave view"><Button aria-pressed={tab === "me"} onClick={() => setTab("me")}>My leave</Button><Button aria-pressed={tab === "team"} onClick={() => setTab("team")}>Team</Button></div>}
      {tab === "me" && isEmp ? <MyLeave /> : <TeamLeave />}
    </div>
  );
}

// -------------------------- performance reviews --------------------------
function ReviewView({ r, onClose }: { r: any; onClose: () => void }) {
  return (
    <Modal open title={`Review: ${r.employeeName ?? "My review"}`} onClose={onClose}>
      <div className="stack">
        <p className="muted small">{date(r.periodStart)} – {date(r.periodEnd)} · by {r.reviewerName ?? "—"}</p>
        <p style={{ fontSize: "1.3rem" }} aria-label={`${r.rating} out of 5`}>{stars(r.rating)}</p>
        {[["Strengths", r.strengths], ["Areas to improve", r.improvements], ["Goals", r.goals]].map(([t, v]) => v ? <div key={t as string}><h3>{t}</h3><p style={{ whiteSpace: "pre-wrap" }}>{v}</p></div> : null)}
        <div className="actions"><Button onClick={onClose}>Close</Button></div>
      </div>
    </Modal>
  );
}

function MyReviews() {
  const { current } = useBusiness(); const { toast } = useToast(); const base = `/api/businesses/${current!.id}/me/performance`; const { data, error, loading, reload } = useFetch<any>(base); const [view, setView] = useState<any>(null);
  if (error) return <ErrorState error={error} retry={reload} />; if (loading && !data) return <Spinner />;
  return (
    <>
      <Card><DataTable rows={data.reviews} empty={<Empty title="No reviews yet">Reviews your manager shares with you appear here.</Empty>} cols={[
        { key: "period", label: "Period", render: (r: any) => `${date(r.periodStart)} – ${date(r.periodEnd)}` }, { key: "rating", label: "Rating", render: (r: any) => <span aria-label={`${r.rating} out of 5`}>{stars(r.rating)}</span> },
        { key: "ack", label: "Acknowledged", render: (r: any) => (r.acknowledgedAt ? <Badge tone="ok">{date(r.acknowledgedAt)}</Badge> : <Badge tone="warn">Not yet</Badge>) },
      ]} actions={(r: any) => <><Button small onClick={() => setView(r)}>View</Button>{!r.acknowledgedAt && <Button small variant="primary" onClick={async () => { try { await post(`${base}/${r.id}/acknowledge`); toast("Review acknowledged"); reload(); } catch (e) { toast(problem(e), "error"); } }}>Acknowledge</Button>}</>} /></Card>
      {view && <ReviewView r={view} onClose={() => setView(null)} />}
    </>
  );
}

function TeamReviews() {
  const { current, can } = useBusiness(); const { toast } = useToast(); const base = `/api/businesses/${current!.id}/performance`; const emps = useFetch<any>(`/api/businesses/${current!.id}/employees${qs({ status: "active", limit: 100 })}`);
  const [edit, setEdit] = useState<{ row: any | null } | null>(null); const [view, setView] = useState<any>(null); const [rm, setRm] = useState<any>(null); const manage = can("performance.manage");
  const fields: FieldDef[] = [
    ...(edit?.row ? [] : [{ key: "employeeId", label: "Employee", type: "select" as const, required: true, options: [["", "Choose…"], ...(emps.data?.employees.map((e: any) => [e.id, e.fullName]) ?? [])] as [string, string][] }]),
    { key: "periodStart", label: "Period start", type: "date", required: true }, { key: "periodEnd", label: "Period end", type: "date", required: true },
    { key: "rating", label: "Rating", type: "select", options: [["5", "5 · Outstanding"], ["4", "4 · Exceeds expectations"], ["3", "3 · Meets expectations"], ["2", "2 · Needs improvement"], ["1", "1 · Unsatisfactory"]] },
    { key: "strengths", label: "Strengths", type: "textarea" }, { key: "improvements", label: "Areas to improve", type: "textarea" }, { key: "goals", label: "Goals for next period", type: "textarea" },
  ];
  return (
    <ListPage title="Team reviews" endpoint={base} listKey="reviews" search={false} filters={[{ key: "status", label: "Status", options: [["", "All"], ["draft", "Draft"], ["shared", "Shared"]] }]}
      headerActions={() => manage && <Button variant="primary" onClick={() => setEdit({ row: null })}>Write a review</Button>}
      empty={<Empty title="No reviews yet">Write a review, then share it with the employee when it's ready.</Empty>}
      cols={[
        { key: "employeeName", label: "Employee", render: (r: any) => <strong>{r.employeeName}</strong> }, { key: "period", label: "Period", render: (r: any) => `${date(r.periodStart)} – ${date(r.periodEnd)}` },
        { key: "rating", label: "Rating", render: (r: any) => <span aria-label={`${r.rating} out of 5`}>{stars(r.rating)}</span> },
        { key: "status", label: "Status", render: (r: any) => <><Badge tone={r.status === "shared" ? "ok" : "warn"}>{label(r.status)}</Badge>{r.status === "shared" && <> {r.acknowledgedAt ? <Badge tone="ok">Acknowledged</Badge> : <Badge>Awaiting</Badge>}</>}</> },
      ]}
      actions={(r: any, reload) => <>
        <Button small onClick={() => setView(r)}>View</Button>
        {manage && r.status === "draft" && <>
          <Button small onClick={() => setEdit({ row: { ...r, rating: String(r.rating) } })}>Edit</Button>
          <Button small variant="primary" onClick={async () => { try { await post(`${base}/${r.id}/share`); toast("Shared with the employee"); reload(); } catch (e) { toast(problem(e), "error"); } }}>Share</Button>
          <Button small variant="danger" onClick={() => setRm({ r, reload })}>Delete</Button></>}
      </>}>
      {(reload) => (<>
        {edit && <FormModal title={edit.row ? "Edit review" : "Write a review"} fields={fields} initial={edit.row ?? { rating: "4" }} onClose={() => setEdit(null)}
          onSubmit={async (b) => { const body = { ...b, rating: Number(b.rating) }; edit.row ? await patch(`${base}/${edit.row.id}`, body) : await post(base, body); toast("Review saved as a draft"); reload(); }}
          intro={<p className="muted small">Drafts are private. The employee only sees a review after you share it, and shared reviews can't be edited.</p>} />}
        {view && <ReviewView r={view} onClose={() => setView(null)} />}
        <ConfirmDialog open={!!rm} danger title="Delete this draft?" confirmLabel="Delete" message="The draft will be removed." onClose={() => setRm(null)}
          onConfirm={async () => { try { await del(`${base}/${rm.r.id}`); toast("Draft deleted"); rm.reload(); } catch (e) { toast(problem(e), "error"); } setRm(null); }} />
      </>)}
    </ListPage>
  );
}

export function Performance() {
  useTitle("Performance"); const { user } = useAuth(); const { can } = useBusiness(); const isEmp = user?.accountType === "employee"; const isMgr = can("performance.view");
  const [tab, setTab] = useState<"me" | "team">(isEmp ? "me" : "team");
  return (
    <div className="stack">
      <PageHeader title="Performance" crumbs={[{ to: "/app", label: "Dashboard" }, { label: "Performance" }]} />
      {isEmp && isMgr && <div className="tabs" role="group" aria-label="Performance view"><Button aria-pressed={tab === "me"} onClick={() => setTab("me")}>My reviews</Button><Button aria-pressed={tab === "team"} onClick={() => setTab("team")}>Team</Button></div>}
      {tab === "me" && isEmp ? <MyReviews /> : <TeamReviews />}
    </div>
  );
}

// ------------------------------ documents ------------------------------
const DOC_CATS = ["contract", "id_proof", "certificate", "payslip", "other"].map((c) => [c, label(c)] as [string, string]);
const size = (b: number) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

export function EmployeeDocuments() {
  const { id } = useParams(); const { current, can } = useBusiness(); const { toast } = useToast(); const base = `/api/businesses/${current!.id}/employees/${id}/documents`;
  const emp = useFetch<any>(`/api/businesses/${current!.id}/employees/${id}`); const { data, error, loading, reload } = useFetch<any>(base);
  const [up, setUp] = useState(false); const [file, setFile] = useState<File | null>(null); const [rm, setRm] = useState<any>(null); const manage = can("documents.manage");
  const name = emp.data?.employee.fullName ?? "Employee"; useTitle(`${name}: documents`);
  const upload = async (b: Record<string, any>) => {
    if (!file) throw new ApiError(400, "BAD_REQUEST", "Choose a file to upload.");
    const fd = new FormData(); fd.append("name", b.name); fd.append("category", b.category); if (b.expiryDate) fd.append("expiryDate", b.expiryDate); fd.append("visibleToEmployee", String(!!b.visibleToEmployee)); fd.append("file", file);
    await api("POST", base, fd); toast("Document uploaded"); reload();
  };
  const dl = async (d: any) => { try { await download(`${base}/${d.id}/file`, d.originalName ?? "document"); } catch (e) { toast(problem(e, "Download failed"), "error"); } };
  return (
    <div className="stack">
      <PageHeader title={`Documents: ${name}`} crumbs={[{ to: "/app", label: "Dashboard" }, { to: "/app/employees", label: "Employees" }, { label: "Documents" }]}>{manage && <Button variant="primary" onClick={() => { setFile(null); setUp(true); }}>Upload document</Button>}</PageHeader>
      <p className="muted">Files are stored privately. Only people with document access can open them; the employee sees a file only if you share it.</p>
      {error ? <ErrorState error={error} retry={reload} /> : loading && !data ? <Spinner /> : (
        <Card><DataTable rows={data.documents} empty={<Empty title="No documents yet">Upload contracts, ID proofs and certificates for this employee.</Empty>} cols={[
          { key: "name", label: "Document", render: (d: any) => <><strong>{d.name}</strong><br /><span className="muted small">{d.originalName} · {size(d.bytes)}</span></> }, { key: "category", label: "Type", render: (d: any) => label(d.category) },
          { key: "expiryDate", label: "Expires", render: (d: any) => (d.expiryDate ? <>{date(d.expiryDate)} {d.expiringSoon && <Badge tone="warn">Soon</Badge>}</> : "—") },
          { key: "visibleToEmployee", label: "Employee can see", render: (d: any) => (d.visibleToEmployee ? <Badge tone="ok">Shared</Badge> : <Badge>Private</Badge>) },
        ]} actions={(d: any) => <><Button small onClick={() => dl(d)}>Download</Button>{manage && <>
          <Button small onClick={async () => { try { await patch(`${base}/${d.id}`, { visibleToEmployee: !d.visibleToEmployee }); toast(d.visibleToEmployee ? "Now private" : "Shared with the employee"); reload(); } catch (e) { toast(problem(e), "error"); } }}>{d.visibleToEmployee ? "Make private" : "Share"}</Button>
          <Button small variant="danger" onClick={() => setRm(d)}>Delete</Button></>}</>} /></Card>
      )}
      {up && <FormModal title="Upload document" submitLabel="Upload" fields={[{ key: "name", label: "Document name", required: true }, { key: "category", label: "Type", type: "select", options: DOC_CATS }, { key: "expiryDate", label: "Expiry date (optional)", type: "date" }, { key: "visibleToEmployee", label: "Share with the employee", type: "checkbox" }]} onClose={() => setUp(false)} onSubmit={upload}>
        <div className="field"><label htmlFor="docfile">File</label><input id="docfile" className="input" type="file" accept="application/pdf,image/png,image/jpeg,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /><span className="hint">PDF, PNG, JPEG or WebP.</span></div>
      </FormModal>}
      <ConfirmDialog open={!!rm} danger title="Delete this document?" confirmLabel="Delete" message={rm && `“${rm.name}” will be permanently removed.`} onClose={() => setRm(null)}
        onConfirm={async () => { try { await del(`${base}/${rm.id}`); toast("Document deleted"); setRm(null); reload(); } catch (e) { toast(problem(e), "error"); setRm(null); } }} />
    </div>
  );
}

export function Documents() {
  useTitle("Documents"); const { user } = useAuth(); const { current, can } = useBusiness(); const { toast } = useToast(); const base = `/api/businesses/${current!.id}`;
  const isEmp = user?.accountType === "employee"; const mgr = can("documents.view");
  const mine = useFetch<any>(isEmp ? `${base}/me/documents` : null); const soon = useFetch<any>(mgr ? `${base}/documents/expiring?days=60` : null);
  const dl = async (path: string, name: string) => { try { await download(path, name); } catch (e) { toast(problem(e, "Download failed"), "error"); } };
  return (
    <div className="stack">
      <PageHeader title="Documents" crumbs={[{ to: "/app", label: "Dashboard" }, { label: "Documents" }]} />
      {isEmp && (<Card title="My documents">{mine.error ? <ErrorState error={mine.error} retry={mine.reload} /> : mine.loading && !mine.data ? <Spinner /> : (
        <DataTable rows={mine.data.documents} empty={<Empty title="Nothing shared with you yet">Documents your employer shares appear here.</Empty>} cols={[{ key: "name", label: "Document", render: (d: any) => <strong>{d.name}</strong> }, { key: "category", label: "Type", render: (d: any) => label(d.category) }, { key: "createdAt", label: "Added", render: (d: any) => date(d.createdAt) }]}
          actions={(d: any) => <Button small onClick={() => dl(`${base}/me/documents/${d.id}/file`, d.originalName ?? "document")}>Download</Button>} />)}</Card>)}
      {mgr && (<Card title="Expiring in the next 60 days">{soon.error ? <ErrorState error={soon.error} retry={soon.reload} /> : soon.loading && !soon.data ? <Spinner /> : (
        <DataTable rows={soon.data.documents} empty={<Empty title="Nothing is about to expire" action={<Link className="btn" to="/app/employees">Browse employees</Link>}>Open an employee and choose “Documents” to upload files.</Empty>} cols={[
          { key: "employeeName", label: "Employee", render: (d: any) => <strong>{d.employeeName}</strong> }, { key: "name", label: "Document" }, { key: "expiryDate", label: "Expires", render: (d: any) => <span className={d.expiryDate < new Date().toISOString().slice(0, 10) ? "down" : ""}>{date(d.expiryDate)}</span> }]}
          actions={(d: any) => <Link className="btn btn-sm" to={`/app/employees/${d.employeeId}/documents`}>Open</Link>} />)}</Card>)}
    </div>
  );
}
