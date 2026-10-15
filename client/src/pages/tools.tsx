import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { FormModal, InlineForm, ListPage, type FieldDef } from "../components/forms";
import { Badge, Button, Card, ConfirmDialog, DataTable, Empty, ErrorState, Modal, PageHeader, Pagination, Spinner, Stat, statusTone } from "../components/ui";
import { ApiError, del, patch, post, put, qs, uploadFile } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useBusiness } from "../lib/business";
import { date, dateTime, label, money, num } from "../lib/format";
import { useFetch, useTitle } from "../lib/hooks";
import { STATES } from "../lib/states";
import { useToast } from "../lib/toast";

const problem = (e: unknown, fb = "Something went wrong. Please try again.") => (e instanceof ApiError ? e.message : fb);
const WORK = ["full_time", "part_time", "contract", "temporary", "internship", "freelance"].map((w) => [w, label(w)] as [string, string]);

// ------------------------------ job postings ------------------------------
export function JobPostings() {
  useTitle("Job postings"); const { current } = useBusiness(); const { toast } = useToast(); const base = `/api/businesses/${current!.id}/jobs`;
  const [edit, setEdit] = useState<{ row: any | null } | null>(null); const [rm, setRm] = useState<any>(null);
  const fields: FieldDef[] = [
    { key: "title", label: "Job title", required: true }, { key: "workType", label: "Job type", type: "select", options: WORK }, { key: "description", label: "Description", type: "textarea", required: true }, { key: "requirements", label: "Requirements", type: "textarea" },
    { key: "skills", label: "Skills wanted", type: "csv", hint: "Separate with commas." }, { key: "location", label: "Location" }, { key: "isRemote", label: "Remote work is possible", type: "checkbox" },
    { key: "payMin", label: "Pay from (₹)", type: "number", min: 0, nullWhenEmpty: true }, { key: "payMax", label: "Pay up to (₹)", type: "number", min: 0, nullWhenEmpty: true },
    { key: "payPeriod", label: "Pay period", type: "select", nullWhenEmpty: true, options: [["", "Not shown"], ["hour", "Per hour"], ["day", "Per day"], ["week", "Per week"], ["month", "Per month"], ["year", "Per year"], ["fixed", "Fixed amount"]] },
    { key: "deadline", label: "Apply by", type: "date", nullWhenEmpty: true },
  ];
  return (
    <ListPage title="Job postings" crumbs={[{ to: "/app", label: "Dashboard" }, { label: "Job postings" }]} endpoint={base} listKey="jobs" search="Search by title"
      filters={[{ key: "status", label: "Status", options: [["", "All"], ["draft", "Draft"], ["open", "Open"], ["closed", "Closed"]] }]}
      headerActions={() => <Button variant="primary" onClick={() => setEdit({ row: null })}>Post a job</Button>}
      empty={<Empty title="No job postings yet">Create a posting, then open it to let people apply.</Empty>}
      cols={[
        { key: "title", label: "Job", render: (j: any) => <><strong>{j.title}</strong><br /><span className="muted small">{label(j.workType)}{j.location ? ` · ${j.location}` : ""}</span></> },
        { key: "status", label: "Status", render: (j: any) => <Badge tone={j.status === "open" ? "ok" : j.status === "closed" ? "danger" : "warn"}>{label(j.status)}</Badge> },
        { key: "applicantCount", label: "Applicants", num: true, render: (j: any) => <Link to={`/app/applicants?job=${j.id}`}>{j.applicantCount}</Link> }, { key: "deadline", label: "Apply by", render: (j: any) => (j.deadline ? date(j.deadline) : "—") },
      ]}
      actions={(j, reload) => <>
        {j.status !== "open" && <Button small variant="primary" onClick={async () => { try { await patch(`${base}/${j.id}`, { status: "open" }); toast("Job is now open for applications"); reload(); } catch (e) { toast(problem(e), "error"); } }}>{j.status === "draft" ? "Publish" : "Reopen"}</Button>}
        {j.status === "open" && <Button small onClick={async () => { try { await patch(`${base}/${j.id}`, { status: "closed" }); toast("Job closed"); reload(); } catch (e) { toast(problem(e), "error"); } }}>Close</Button>}
        <Button small onClick={() => setEdit({ row: j })}>Edit</Button><Button small variant="danger" onClick={() => setRm({ j, reload })}>Delete</Button></>}>
      {(reload) => (<>
        {edit && <FormModal title={edit.row ? "Edit job" : "Post a job"} fields={fields} initial={edit.row ?? { workType: "full_time" }} onClose={() => setEdit(null)}
          intro={!edit.row && <p className="muted small">New postings are saved as drafts. Publish one when you're ready for people to apply.</p>}
          onSubmit={async (b) => { edit.row ? await patch(`${base}/${edit.row.id}`, b) : await post(base, b); toast("Job saved"); reload(); }} />}
        <ConfirmDialog open={!!rm} danger title="Delete this job?" confirmLabel="Delete" message="Jobs that already have applicants can't be deleted. Close them instead." onClose={() => setRm(null)}
          onConfirm={async () => { try { await del(`${base}/${rm.j.id}`); toast("Job deleted"); rm.reload(); } catch (e) { toast(problem(e), "error"); } setRm(null); }} />
      </>)}
    </ListPage>
  );
}

// -------------------------------- applicants --------------------------------
const NEXT: Record<string, [string, string][]> = { applied: [["shortlisted", "Shortlist"], ["rejected", "Reject"]], shortlisted: [["interview", "Invite to interview"], ["selected", "Select"], ["rejected", "Reject"]], interview: [["selected", "Select"], ["rejected", "Reject"]] };

function ApplicantModal({ id, base, onClose, onChanged }: { id: string; base: string; onClose: () => void; onChanged: () => void }) {
  const { toast } = useToast(); const { data, error, loading, reload } = useFetch<{ application: any }>(`${base}/${id}`); const [step, setStep] = useState<string | null>(null);
  const a = data?.application; const r = a?.applicant;
  return (
    <Modal open title={r ? r.name : "Applicant"} onClose={onClose}>
      {error ? <ErrorState error={error} retry={reload} /> : loading && !a ? <Spinner /> : a && (
        <div className="stack">
          <p className="row" style={{ margin: 0 }}><Badge tone={statusTone(a.status)}>{label(a.status)}</Badge><span className="muted small">for {a.jobTitle} · applied {date(a.appliedAt)}</span></p>
          {a.interviewAt && <p className="banner ok">Interview: {dateTime(a.interviewAt)}</p>}
          {NEXT[a.status] && <div className="actions">{NEXT[a.status].map(([s, l]) => <Button key={s} variant={s === "rejected" ? "danger" : s === "selected" ? "primary" : "default"} onClick={() => setStep(s)}>{l}</Button>)}</div>}
          <ul className="list"><li><span className="muted">Email</span><a href={`mailto:${r.email}`}>{r.email}</a></li>{r.phone && <li><span className="muted">Phone</span><a href={`tel:${r.phone}`}>{r.phone}</a></li>}{r.city && <li><span className="muted">City</span><span>{r.city}</span></li>}<li><span className="muted">Experience</span><span>{r.totalExperience}</span></li>
            {r.resumeUrl && <li><span className="muted">Resume</span><a href={r.resumeUrl} target="_blank" rel="noreferrer">Open PDF</a></li>}</ul>
          {r.headline && <p><strong>{r.headline}</strong></p>}{r.bio && <p>{r.bio}</p>}
          {a.coverLetter && <><h3>Cover letter</h3><p style={{ whiteSpace: "pre-wrap" }}>{a.coverLetter}</p></>}
          {r.skills.length > 0 && <p className="row">{r.skills.map((s: string) => <Badge key={s} tone="brand">{s}</Badge>)}</p>}
          {r.experience.length > 0 && <><h3>Experience</h3><ul className="list">{r.experience.map((e: any) => <li key={e.id}><span><strong>{e.role}</strong> · {e.company}<br /><span className="muted small">{date(e.startDate)} – {e.endDate ? date(e.endDate) : "Present"}</span></span></li>)}</ul></>}
          {r.education.length > 0 && <><h3>Education</h3><ul className="list">{r.education.map((e: any) => <li key={e.id}><span>{e.institution}{e.degree ? ` · ${e.degree}` : ""}</span></li>)}</ul></>}
          <details><summary>History ({a.history.length})</summary><ul className="list">{a.history.map((h: any, i: number) => <li key={i}><span><Badge tone={statusTone(h.status)}>{label(h.status)}</Badge> {h.note}</span><span className="muted small">{h.actorName ?? "Applicant"} · {date(h.createdAt)}</span></li>)}</ul></details>
        </div>
      )}
      {step && <FormModal title={label(step === "interview" ? "Invite to interview" : step)} submitLabel="Confirm" onClose={() => setStep(null)}
        fields={[...(step === "interview" ? [{ key: "interviewAt", label: "Interview date and time", type: "datetime" as const }] : []), { key: "note", label: "Note (optional)", type: "textarea" as const }]}
        onSubmit={async (b) => { await patch(`${base}/${id}/status`, { status: step, ...b }); toast(`Applicant ${step === "interview" ? "invited to interview" : step}`); reload(); onChanged(); }} />}
    </Modal>
  );
}

export function Applicants() {
  useTitle("Applicants"); const { current } = useBusiness(); const [params] = useSearchParams(); const base = `/api/businesses/${current!.id}/applications`; const jobs = useFetch<any>(`/api/businesses/${current!.id}/jobs${qs({ limit: 100 })}`); const [open, setOpen] = useState<string | null>(null);
  const [job, setJob] = useState(params.get("job") ?? "");
  return (
    <ListPage title="Applicants" crumbs={[{ to: "/app", label: "Dashboard" }, { label: "Applicants" }]} endpoint={base} listKey="applications" search={false} extra={{ jobId: job }}
      filters={[{ key: "status", label: "Status", options: [["", "All statuses"], ...["applied", "shortlisted", "interview", "selected", "rejected", "withdrawn"].map((s) => [s, label(s)] as [string, string])] }]}
      empty={<Empty title="No applicants yet">When people apply to your open jobs they appear here.</Empty>}
      cols={[
        { key: "name", label: "Applicant", render: (a: any) => <><strong>{a.applicant.name}</strong><br /><span className="muted small">{a.applicant.headline ?? a.applicant.city ?? ""}</span></> }, { key: "jobTitle", label: "Job" },
        { key: "skills", label: "Skills", render: (a: any) => (a.applicant.skills.length ? a.applicant.skills.slice(0, 4).map((s: string) => <Badge key={s}>{s}</Badge>) : "—") },
        { key: "exp", label: "Experience", render: (a: any) => `${Math.floor(a.applicant.experienceMonths / 12)} yrs ${a.applicant.experienceMonths % 12} mos` },
        { key: "status", label: "Status", render: (a: any) => <Badge tone={statusTone(a.status)}>{label(a.status)}</Badge> }, { key: "appliedAt", label: "Applied", render: (a: any) => date(a.appliedAt) },
      ]}
      actions={(a) => <Button small onClick={() => setOpen(a.id)} aria-label={`View ${a.applicant.name}`}>View</Button>}>
      {(reload) => (<>
        <div className="filters"><div className="field"><label htmlFor="jobf">Job</label><select id="jobf" className="select" value={job} onChange={(e) => setJob(e.target.value)}><option value="">All jobs</option>{jobs.data?.jobs.map((j: any) => <option key={j.id} value={j.id}>{j.title}</option>)}</select></div></div>
        {open && <ApplicantModal id={open} base={base} onClose={() => setOpen(null)} onChanged={reload} />}
      </>)}
    </ListPage>
  );
}

// ------------------------------ advertisements ------------------------------
export function Advertisements() {
  useTitle("Advertisements"); const { current } = useBusiness(); const { toast } = useToast(); const base = `/api/businesses/${current!.id}/ads`;
  const [edit, setEdit] = useState<{ row: any | null } | null>(null); const [rm, setRm] = useState<any>(null); const [file, setFile] = useState<File | null>(null);
  const today = new Date().toISOString().slice(0, 10); const later = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const fields: FieldDef[] = [
    { key: "title", label: "Headline", required: true }, { key: "description", label: "Text", type: "textarea" }, { key: "ctaLabel", label: "Button label", hint: "e.g. Shop now" }, { key: "ctaUrl", label: "Button link", type: "url", hint: "Include https://" },
    { key: "placements", label: "Where to show it", type: "multi", options: [["discover", "Discover pages"], ["business_profile", "Business profiles"], ["product_discovery", "Product discovery"]] },
    { key: "startDate", label: "Starts", type: "date", required: true }, { key: "endDate", label: "Ends", type: "date", required: true },
  ];
  return (
    <ListPage title="Advertisements" crumbs={[{ to: "/app", label: "Dashboard" }, { label: "Advertisements" }]} endpoint={base} listKey="ads" search={false} filters={[{ key: "status", label: "Status", options: [["", "All"], ["draft", "Draft"], ["active", "Live"], ["paused", "Paused"]] }]}
      headerActions={() => <Button variant="primary" onClick={() => { setFile(null); setEdit({ row: null }); }}>Create ad</Button>}
      empty={<Empty title="No ads yet">Promote your business on discovery pages. Ads go live only after you activate them.</Empty>}
      cols={[
        { key: "title", label: "Ad", render: (a: any) => <span className="row">{a.imageUrl && <img src={a.imageUrl} alt="" width={48} height={48} style={{ objectFit: "cover", borderRadius: 8 }} />}<span><strong>{a.title}</strong><br /><span className="muted small">{a.placements.map(label).join(", ")}</span></span></span> },
        { key: "dates", label: "Runs", render: (a: any) => `${date(a.startDate)} – ${date(a.endDate)}` },
        { key: "status", label: "Status", render: (a: any) => <><Badge tone={a.status === "active" ? "ok" : a.status === "paused" ? "warn" : undefined}>{a.status === "active" ? "Live" : label(a.status)}</Badge>{a.moderationStatus === "rejected" && <><br /><Badge tone="danger">Rejected</Badge> <span className="small">{a.moderationNote}</span></>}</> },
        { key: "perf", label: "Views / clicks", num: true, render: (a: any) => `${num(a.impressions)} / ${num(a.clicks)}` },
      ]}
      actions={(a, reload) => <>
        {a.status !== "active" && a.moderationStatus === "approved" && <Button small variant="primary" onClick={async () => { try { await patch(`${base}/${a.id}`, { status: "active" }); toast("Ad is live"); reload(); } catch (e) { toast(problem(e), "error"); } }}>Go live</Button>}
        {a.status === "active" && <Button small onClick={async () => { try { await patch(`${base}/${a.id}`, { status: "paused" }); toast("Ad paused"); reload(); } catch (e) { toast(problem(e), "error"); } }}>Pause</Button>}
        <Button small onClick={() => { setFile(null); setEdit({ row: a }); }}>Edit</Button><Button small variant="danger" onClick={() => setRm({ a, reload })}>Delete</Button></>}>
      {(reload) => (<>
        {edit && <FormModal title={edit.row ? "Edit ad" : "Create ad"} fields={fields} initial={edit.row ?? { placements: ["discover"], startDate: today, endDate: later }} onClose={() => setEdit(null)}
          onSubmit={async (b) => { const body = { ...b, ...(file ? { imageUrl: (await uploadFile(file, current!.id)).url } : {}) }; edit.row ? await patch(`${base}/${edit.row.id}`, body) : await post(base, body); toast("Ad saved"); reload(); }}>
          <div className="field"><label htmlFor="adimg">Image (optional)</label><input id="adimg" className="input" type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></div>
        </FormModal>}
        <ConfirmDialog open={!!rm} danger title="Delete this ad?" confirmLabel="Delete" message="It will stop showing immediately." onClose={() => setRm(null)}
          onConfirm={async () => { try { await del(`${base}/${rm.a.id}`); toast("Ad deleted"); rm.reload(); } catch (e) { toast(problem(e), "error"); } setRm(null); }} />
      </>)}
    </ListPage>
  );
}

// ---------------------------------- settings ----------------------------------
function ProfileSettings() {
  const { current, can, reload } = useBusiness(); const { toast } = useToast(); const base = `/api/businesses/${current!.id}`; const { data, error, loading } = useFetch<any>(base); const [logo, setLogo] = useState<File | null>(null);
  if (error) return <ErrorState error={error} />; if (loading && !data) return <Spinner />;
  const fields: FieldDef[] = [{ key: "name", label: "Business name", required: true }, { key: "category", label: "Category" }, { key: "phone", label: "Phone", type: "tel" }, { key: "email", label: "Business email", type: "email" }, { key: "website", label: "Website", type: "url" }, { key: "address", label: "Address" },
    { key: "description", label: "Description", type: "textarea" }, { key: "legalName", label: "Legal name (for invoices)", hint: "As registered, if different from the trading name" }, { key: "gstin", label: "GSTIN", hint: "15 characters. Enables Tax Invoices with CGST / SGST / IGST." },
    { key: "stateCode", label: "State", type: "select", options: [["", "Not set"], ...STATES], hint: "Taken from the GSTIN when you enter one" }, { key: "isPublic", label: "Show my business in public listings and the marketplace", type: "checkbox" }];
  const manage = can("business.manage");
  return (
    <Card title="Business profile">
      {data.business.logoUrl && <img src={data.business.logoUrl} alt="Business logo" width={64} height={64} style={{ objectFit: "cover", borderRadius: 12, marginBottom: ".75rem" }} />}
      <InlineForm fields={fields} initial={data.business} disabled={!manage} onSubmit={async (b) => { const body: any = { ...b, ...(logo ? { logoUrl: (await uploadFile(logo, current!.id)).url } : {}) }; if (body.gstin) { body.gstin = String(body.gstin).toUpperCase(); delete body.stateCode; } await patch(base, body); toast("Business saved"); await reload(); }}>
        {manage && <div className="field"><label htmlFor="logo">Logo</label><input id="logo" className="input" type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => setLogo(e.target.files?.[0] ?? null)} /></div>}
      </InlineForm>
      {!manage && <p className="muted small">Only owners and admins can edit the business profile.</p>}
    </Card>
  );
}

const DAYS: [string, string][] = [["mon", "Monday"], ["tue", "Tuesday"], ["wed", "Wednesday"], ["thu", "Thursday"], ["fri", "Friday"], ["sat", "Saturday"], ["sun", "Sunday"]];
const SOCIALS: [string, string][] = [["facebook", "Facebook"], ["instagram", "Instagram"], ["x", "X"], ["linkedin", "LinkedIn"], ["youtube", "YouTube"], ["whatsapp", "WhatsApp"]];

/** Opening hours and social links shown on the public business page. */
function PresenceSettings() {
  const { current, can } = useBusiness(); const { toast } = useToast(); const base = `/api/businesses/${current!.id}`; const { data, error, loading, reload } = useFetch<any>(base);
  const [hours, setHours] = useState<Record<string, { open: string; close: string; closed: boolean }> | null>(null); const [social, setSocial] = useState<Record<string, string> | null>(null);
  const [msg, setMsg] = useState(""); const [busy, setBusy] = useState(false); const manage = can("business.manage");
  if (error) return <ErrorState error={error} />; if (loading && !data) return <Spinner />;
  const h = hours ?? Object.fromEntries(DAYS.map(([k]) => { const d = data.business.businessHours?.[k]; return [k, d?.open ? { open: d.open, close: d.close, closed: false } : { open: "09:00", close: "18:00", closed: !d ? false : true }]; })) as any;
  const unset = DAYS.every(([k]) => !data.business.businessHours?.[k]) && !hours;
  const s = social ?? { ...(data.business.socialLinks ?? {}) };
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setMsg("");
    try {
      const businessHours = Object.fromEntries(DAYS.map(([k]) => [k, h[k].closed ? { closed: true } : { open: h[k].open, close: h[k].close }]));
      const socialLinks = Object.fromEntries(SOCIALS.map(([k]) => [k, (s[k] ?? "").trim()]).filter(([, v]) => v));
      await patch(base, { businessHours: unset && !hours ? {} : businessHours, socialLinks }); toast("Saved"); setHours(null); setSocial(null); reload();
    } catch (err) { setMsg(err instanceof ApiError ? Object.values((err.details as Record<string, string>) ?? {})[0] ?? err.message : "Something went wrong."); } finally { setBusy(false); }
  };
  return (
    <Card title="Opening hours and social links">
      <form className="stack" onSubmit={save} noValidate>
        {msg && <div className="banner error" role="alert">{msg}</div>}
        <fieldset className="hours-edit" disabled={!manage}><legend className="small muted">Opening hours (shown on your public page)</legend>
          {DAYS.map(([k, name]) => (
            <div key={k} className="hours-row"><span className="hours-day">{name}</span>
              <label className="check"><input type="checkbox" checked={h[k].closed} onChange={(e) => setHours({ ...h, [k]: { ...h[k], closed: e.target.checked } })} /> Closed</label>
              <input className="input" type="time" aria-label={`${name} opens`} value={h[k].open} disabled={h[k].closed || !manage} onChange={(e) => setHours({ ...h, [k]: { ...h[k], open: e.target.value } })} />
              <input className="input" type="time" aria-label={`${name} closes`} value={h[k].close} disabled={h[k].closed || !manage} onChange={(e) => setHours({ ...h, [k]: { ...h[k], close: e.target.value } })} />
            </div>))}
        </fieldset>
        <div className="form-grid">{SOCIALS.map(([k, name]) => <div className="field" key={k}><label htmlFor={`soc-${k}`}>{name} link</label><input id={`soc-${k}`} className="input" type="url" inputMode="url" placeholder="https://" disabled={!manage} value={s[k] ?? ""} onChange={(e) => setSocial({ ...s, [k]: e.target.value })} /></div>)}</div>
        {manage && <div className="actions"><Button type="submit" variant="primary" loading={busy}>Save</Button></div>}
      </form>
    </Card>
  );
}

function WorkSettings() {
  const { current, can } = useBusiness(); const { toast } = useToast(); const base = `/api/businesses/${current!.id}/attendance-settings`; const { data, error, loading } = useFetch<any>(base);
  if (error) return <ErrorState error={error} />; if (loading && !data) return <Spinner />;
  const fields: FieldDef[] = [{ key: "timezone", label: "Time zone", required: true, hint: "For example Asia/Kolkata. Lateness is judged in this time zone." }, { key: "workStart", label: "Work starts", type: "time" }, { key: "workEnd", label: "Work ends", type: "time" }, { key: "lateGraceMinutes", label: "Grace period (minutes)", type: "number", min: 0, max: 240 }];
  return <Card title="Work hours and attendance"><InlineForm fields={fields} initial={data.settings} disabled={!can("attendance.manage")} onSubmit={async (b) => { await put(base, b); toast("Work hours saved"); }} /></Card>;
}

function TeamSettings() {
  const { current, can } = useBusiness(); const { toast } = useToast(); const base = `/api/businesses/${current!.id}`; const mem = useFetch<any>(`${base}/members`); const roles = useFetch<any>(`${base}/roles`);
  if (mem.error) return <ErrorState error={mem.error} retry={mem.reload} />; if (mem.loading && !mem.data) return <Spinner />;
  const manage = can("members.manage");
  return (
    <Card title="Team and roles"><DataTable rows={mem.data.members.map((m: any) => ({ ...m, id: m.id }))} cols={[
      { key: "fullName", label: "Name", render: (m: any) => <><strong>{m.fullName}</strong><br /><span className="muted small">{m.email}</span></> },
      { key: "role", label: "Role", render: (m: any) => (manage && m.role !== "Business Owner" && roles.data ? (
        <select className="select" aria-label={`Role for ${m.fullName}`} value={m.roleId} onChange={async (e) => { try { await patch(`${base}/members/${m.id}`, { roleId: e.target.value }); toast("Role updated"); mem.reload(); } catch (err) { toast(problem(err), "error"); mem.reload(); } }}>
          {roles.data.roles.filter((r: any) => r.name !== "Business Owner").map((r: any) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>) : <Badge tone={m.role === "Business Owner" ? "brand" : undefined}>{m.role}</Badge>) },
    ]} /></Card>
  );
}

function AuditLog() {
  const { current } = useBusiness(); const [offset, setOffset] = useState(0); const { data, error, loading, reload } = useFetch<any>(`/api/businesses/${current!.id}/audit${qs({ limit: 25, offset })}`);
  if (error) return <ErrorState error={error} retry={reload} />; if (loading && !data) return <Spinner />;
  return <Card title="Activity log"><DataTable rows={data.entries} empty={<Empty title="No activity yet" />} cols={[{ key: "createdAt", label: "When", render: (e: any) => dateTime(e.createdAt) }, { key: "actor", label: "Who", render: (e: any) => e.actor ?? "System" }, { key: "action", label: "Action", render: (e: any) => label(e.action.replace(/\./g, " ")) }, { key: "entity", label: "About", render: (e: any) => e.entity ?? "—" }]} />
    <div className="actions" style={{ marginTop: ".75rem" }}><Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 25))}>Newer</Button><Button disabled={data.entries.length < 25} onClick={() => setOffset(offset + 25)}>Older</Button></div></Card>;
}

export function Settings() {
  useTitle("Settings"); const { can } = useBusiness();
  const tabs = [["profile", "Business profile", true], ["hours", "Work hours", can("attendance.manage") || can("business.manage")], ["team", "Team and roles", can("members.view")], ["audit", "Activity log", can("audit.view")]].filter(([, , show]) => show) as [string, string, boolean][];
  const [tab, setTab] = useState("profile");
  return (
    <div className="stack">
      <PageHeader title="Settings" crumbs={[{ to: "/app", label: "Dashboard" }, { label: "Settings" }]} />
      <div className="tabs" role="group" aria-label="Settings sections">{tabs.map(([k, l]) => <Button key={k} aria-pressed={tab === k} onClick={() => setTab(k)}>{l}</Button>)}</div>
      {tab === "profile" && <><ProfileSettings /><PresenceSettings /></>}{tab === "hours" && <WorkSettings />}{tab === "team" && <TeamSettings />}{tab === "audit" && <AuditLog />}
    </div>
  );
}

// -------------------------------- subscription --------------------------------
const LIMIT_LABELS: Record<string, string> = { members: "Team members", products: "Products", ordersPerMonth: "Orders this month", storageMb: "Storage (MB)", businesses: "Businesses" };

export function Subscription() {
  useTitle("Subscription"); const { current, can } = useBusiness(); const { toast } = useToast(); const base = `/api/businesses/${current!.id}/subscription`; const sub = useFetch<any>(base); const plans = useFetch<any>("/api/plans"); const [busy, setBusy] = useState("");
  if (sub.error) return <ErrorState error={sub.error} retry={sub.reload} />; if ((sub.loading && !sub.data) || !plans.data) return <Spinner />;
  const s = sub.data.subscription; const cur = plans.data.plans.find((p: any) => p.key === s.plan.key); const price = (p: any) => (p.priceMonthly == null ? Infinity : p.priceMonthly);
  const switchTo = async (key: string) => { setBusy(key); try { await put(base, { planKey: key }); toast("Plan changed"); sub.reload(); } catch (e) { toast(problem(e), "error"); } finally { setBusy(""); } };
  return (
    <div className="stack">
      <PageHeader title="Subscription" crumbs={[{ to: "/app", label: "Dashboard" }, { label: "Subscription" }]} />
      <Card title="Your plan"><p style={{ fontSize: "1.3rem", margin: 0 }}><strong>{s.plan.name}</strong> {s.plan.priceMonthly != null && <span className="muted">· {money(s.plan.priceMonthly)} / month</span>} <Badge tone={s.status === "active" ? "ok" : "danger"}>{label(s.status)}</Badge></p>
        {s.currentPeriodEnd && <p className="muted small">Renews {date(s.currentPeriodEnd)}</p>}</Card>
      <Card title="Usage">
        <ul className="list">{Object.entries(LIMIT_LABELS).map(([k, l]) => {
          const used = s.usage[k] ?? 0; const limit = s.limits[k]; const pc = limit ? Math.min(100, (used / limit) * 100) : 0;
          return (<li key={k} style={{ display: "block" }}><div className="row between"><span>{l}</span><span><strong>{num(used)}</strong> {limit != null ? `of ${num(limit)}` : "· Unlimited"}</span></div>
            {limit != null && <div role="progressbar" aria-label={l} aria-valuenow={Math.round(pc)} aria-valuemin={0} aria-valuemax={100} style={{ background: "var(--surface-2)", borderRadius: 999, height: 8, overflow: "hidden", marginTop: 6 }}><div style={{ width: `${pc}%`, height: "100%", background: pc >= 90 ? "var(--danger)" : "var(--brand)" }} /></div>}</li>);
        })}</ul>
      </Card>
      <div className="grid cols-4">{plans.data.plans.map((p: any) => (
        <Card key={p.key} className={p.key === s.plan.key ? "current" : ""}>
          <h2>{p.name} {p.key === s.plan.key && <Badge tone="brand">Current</Badge>}</h2><p style={{ fontSize: "1.3rem", margin: 0 }}><strong>{p.priceMonthly == null ? "Custom" : p.priceMonthly === 0 ? "Free" : money(p.priceMonthly)}</strong>{p.priceMonthly ? <span className="muted small"> / month</span> : null}</p>
          <ul className="small" style={{ paddingLeft: "1.1rem" }}>{Object.entries(LIMIT_LABELS).map(([k, l]) => <li key={k}>{p.limits[k] != null ? `${num(p.limits[k])} ${l.toLowerCase()}` : `Unlimited ${l.toLowerCase()}`}</li>)}</ul>
          {p.key !== s.plan.key && (price(p) < price(cur) ? (can("business.manage") && <Button loading={busy === p.key} onClick={() => switchTo(p.key)}>Switch to {p.name}</Button>) : <p className="muted small">Upgrades are arranged with our team. Contact support to move to {p.name}.</p>)}
        </Card>
      ))}</div>
    </div>
  );
}

// ---------------------------------- reputation ----------------------------------
function ReviewList({ endpoint, canReport }: { endpoint: string; canReport: boolean }) {
  const { toast } = useToast(); const [offset, setOffset] = useState(0); const { data, error, loading, reload } = useFetch<any>(`${endpoint}${qs({ limit: 10, offset })}`); const [rep, setRep] = useState<any>(null);
  if (error) return <ErrorState error={error} retry={reload} />; if (loading && !data) return <Spinner />;
  const s = data.summary;
  return (
    <div className="stack">
      <div className="grid cols-3"><Stat label="Average rating" value={s.average ?? "—"} delta={s.count ? `from ${s.count} review${s.count === 1 ? "" : "s"}` : "No reviews yet"} />
        <Card><ul className="list">{[5, 4, 3, 2, 1].map((n) => <li key={n}><span>{n} ★</span><span>{s.distribution[n]}</span></li>)}</ul></Card></div>
      <Card title="Reviews">{data.reviews.length ? <ul className="list">{data.reviews.map((r: any) => (
        <li key={r.id} style={{ alignItems: "flex-start" }}><span><span aria-label={`${r.rating} out of 5`}>{"★".repeat(r.rating)}{"☆".repeat(5 - r.rating)}</span> <strong>{r.reviewer}</strong> <Badge>{r.badge}</Badge>{r.body && <><br />{r.body}</>}<br /><span className="muted small">{date(r.createdAt)}</span></span>
          {canReport && <Button small onClick={() => setRep(r)}>Report</Button>}</li>))}</ul> : <Empty title="No reviews yet">Reviews from employees, candidates and buyers appear here.</Empty>}
        <Pagination total={s.count} limit={10} offset={offset} onChange={setOffset} /></Card>
      {rep && <FormModal title="Report this review" submitLabel="Send report" fields={[{ key: "reason", label: "What's wrong with it?", type: "textarea", required: true }]} onClose={() => setRep(null)}
        onSubmit={async (b) => { await post(`/api/reviews/${rep.id}/report`, b); toast("Thanks, our moderators will take a look"); reload(); }} />}
    </div>
  );
}
export function Reputation() {
  useTitle("Reviews"); const { current } = useBusiness();
  return <div className="stack"><PageHeader title="Reviews of your business" crumbs={[{ to: "/app", label: "Dashboard" }, { label: "Reviews" }]} />
    <p className="muted">Only people who've worked with you, interviewed with you, or received an order from you can leave a review. Report any that look unfair or fake.</p>
    <ReviewList endpoint={`/api/public/businesses/${current!.slug}/reviews`} canReport /></div>;
}
export function MyReviews() {
  useTitle("My reviews"); const { user } = useAuth();
  return <div className="stack"><PageHeader title="My reviews" crumbs={[{ to: "/app", label: "Dashboard" }, { label: "Reviews" }]} /><p className="muted">Reviews employers have left about you, {user?.fullName.split(" ")[0]}.</p><ReviewList endpoint="/api/me/reviews" canReport={false} /></div>;
}
