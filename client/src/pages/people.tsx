import { useState, type FormEvent } from "react";
import { Badge, Button, Card, Check, ConfirmDialog, Empty, ErrorState, Modal, PageHeader, Pagination, SelectField, Spinner, statusTone, TextArea, TextField } from "../components/ui";
import { ApiError, del, get, patch, post, put, qs, uploadFile } from "../lib/api";
import { date, label, money } from "../lib/format";
import { ReviewModal } from "../components/ReviewModal";
import { useDebounce, useFetch, useTitle } from "../lib/hooks";
import { useToast } from "../lib/toast";

const problem = (e: unknown, fb = "Something went wrong. Please try again.") => (e instanceof ApiError ? e.message : fb);
const fieldErrs = (e: unknown): Record<string, string> => (e instanceof ApiError && e.code === "BAD_REQUEST" && e.details && typeof e.details === "object" ? e.details : {});

type FieldDef = { key: string; label: string; type?: "text" | "date" | "number" | "textarea" | "csv" | "url"; required?: boolean; hint?: string };
interface SectionDef { title: string; path: string; fields: FieldDef[]; summary: (i: any) => { title: string; sub?: string } }

const SECTIONS: SectionDef[] = [
  { title: "Work experience", path: "experience", summary: (i) => ({ title: `${i.role} · ${i.company}`, sub: `${date(i.startDate)} – ${i.endDate ? date(i.endDate) : "Present"}` }),
    fields: [{ key: "role", label: "Role", required: true }, { key: "company", label: "Company", required: true }, { key: "startDate", label: "Start date", type: "date", required: true }, { key: "endDate", label: "End date", type: "date", hint: "Leave empty if you still work here." },
      { key: "responsibilities", label: "Responsibilities", type: "textarea" }, { key: "achievements", label: "Achievements", type: "textarea" }, { key: "skills", label: "Skills used", type: "csv", hint: "Separate with commas." }] },
  { title: "Education", path: "education", summary: (i) => ({ title: i.institution, sub: [i.degree, i.fieldOfStudy, [i.startYear, i.endYear].filter(Boolean).join("–")].filter(Boolean).join(" · ") }),
    fields: [{ key: "institution", label: "School or college", required: true }, { key: "degree", label: "Degree" }, { key: "fieldOfStudy", label: "Field of study" }, { key: "startYear", label: "Start year", type: "number" }, { key: "endYear", label: "End year", type: "number" }] },
  { title: "Certifications", path: "certifications", summary: (i) => ({ title: i.name, sub: [i.issuer, i.issuedOn && date(i.issuedOn)].filter(Boolean).join(" · ") }),
    fields: [{ key: "name", label: "Name", required: true }, { key: "issuer", label: "Issued by" }, { key: "issuedOn", label: "Issued on", type: "date" }, { key: "expiresOn", label: "Expires on", type: "date" }, { key: "url", label: "Link", type: "url" }] },
  { title: "Projects", path: "projects", summary: (i) => ({ title: i.title, sub: i.description }),
    fields: [{ key: "title", label: "Title", required: true }, { key: "description", label: "Description", type: "textarea" }, { key: "url", label: "Link", type: "url" }, { key: "skills", label: "Skills used", type: "csv", hint: "Separate with commas." }] },
];

function EntryModal({ def, item, onClose, onSaved }: { def: SectionDef; item: any | null; onClose: () => void; onSaved: () => void }) {
  const { toast } = useToast();
  const init = () => Object.fromEntries(def.fields.map((f) => [f.key, item?.[f.key] == null ? "" : f.type === "csv" ? (item[f.key] as string[]).join(", ") : String(item[f.key])]));
  const [v, setV] = useState<Record<string, string>>(init); const [errors, setErrors] = useState<Record<string, string>>({}); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(""); setErrors({});
    const body: any = {};
    for (const f of def.fields) {
      const raw = (v[f.key] ?? "").trim();
      if (raw === "") { if (item && f.key === "endDate") body.endDate = null; continue; }
      body[f.key] = f.type === "number" ? Number(raw) : f.type === "csv" ? raw.split(",").map((s) => s.trim()).filter(Boolean) : raw;
    }
    try { item ? await patch(`/api/me/${def.path}/${item.id}`, body) : await post(`/api/me/${def.path}`, body); toast("Saved"); onSaved(); onClose(); }
    catch (err) { setErrors(fieldErrs(err)); setError(problem(err)); } finally { setBusy(false); }
  };
  return (
    <Modal open title={`${item ? "Edit" : "Add"} ${def.title.toLowerCase()}`} onClose={onClose}>
      <form className="stack" onSubmit={submit} noValidate>
        {error && <div className="banner error" role="alert">{error}</div>}
        {def.fields.map((f) => f.type === "textarea"
          ? <TextArea key={f.key} label={f.label} value={v[f.key]} onChange={(e) => setV((s) => ({ ...s, [f.key]: e.target.value }))} error={errors[f.key]} />
          : <TextField key={f.key} label={f.label} required={f.required} hint={f.hint} type={f.type === "csv" ? "text" : f.type ?? "text"} inputMode={f.type === "number" ? "numeric" : f.type === "url" ? "url" : undefined}
              value={v[f.key]} onChange={(e) => setV((s) => ({ ...s, [f.key]: e.target.value }))} error={errors[f.key]} />)}
        <div className="actions"><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" loading={busy}>Save</Button></div>
      </form>
    </Modal>
  );
}

function EntrySection({ def }: { def: SectionDef }) {
  const { toast } = useToast(); const { data, error, loading, reload } = useFetch<any>(`/api/me/${def.path}`);
  const [edit, setEdit] = useState<{ item: any | null } | null>(null); const [rm, setRm] = useState<any>(null);
  const items: any[] = data?.[def.path] ?? [];
  return (
    <Card title={def.title}>
      {error ? <ErrorState error={error} retry={reload} /> : loading && !data ? <Spinner /> : items.length ? (
        <ul className="list">{items.map((i) => { const s = def.summary(i); return (
          <li key={i.id}><span><strong>{s.title}</strong>{s.sub && <><br /><span className="muted small">{s.sub}</span></>}</span><span className="actions"><Button small onClick={() => setEdit({ item: i })} aria-label={`Edit ${s.title}`}>Edit</Button><Button small variant="danger" onClick={() => setRm(i)} aria-label={`Delete ${s.title}`}>Delete</Button></span></li>
        ); })}</ul>
      ) : <p className="muted">Nothing added yet.</p>}
      <div className="actions" style={{ marginTop: ".75rem" }}><Button onClick={() => setEdit({ item: null })}>Add {def.title.toLowerCase().replace(/s$/, "")}</Button></div>
      {edit && <EntryModal def={def} item={edit.item} onClose={() => setEdit(null)} onSaved={reload} />}
      <ConfirmDialog open={!!rm} danger title="Delete this entry?" confirmLabel="Delete" message="This removes it from your profile and resume." onClose={() => setRm(null)}
        onConfirm={async () => { try { await del(`/api/me/${def.path}/${rm.id}`); toast("Deleted"); setRm(null); reload(); } catch (e) { toast(problem(e), "error"); setRm(null); } }} />
    </Card>
  );
}

export function Profile() {
  useTitle("My profile");
  const { toast } = useToast(); const { data, error, loading, reload } = useFetch<{ profile: any }>("/api/me/profile"); const resume = useFetch<any>("/api/me/resume");
  const [f, setF] = useState<any>(null); const [skills, setSkills] = useState<string[] | null>(null); const [skillText, setSkillText] = useState(""); const [busy, setBusy] = useState(false); const [errors, setErrors] = useState<Record<string, string>>({}); const [up, setUp] = useState("");
  const p = data?.profile;
  if (p && !f) { setF({ headline: p.headline ?? "", bio: p.bio ?? "", city: p.city ?? "", phone: p.phone ?? "", availability: p.availability, isPublic: p.isPublic, avatarUrl: p.avatarUrl, resumeUrl: p.resumeUrl }); setSkills(p.skills); }
  if (error) return <ErrorState error={error} retry={reload} />;
  if (loading && !p) return <Spinner />;
  if (!p || !f || !skills) return null;
  const set = (k: string) => (e: any) => setF((s: any) => ({ ...s, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const save = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErrors({});
    try { await patch("/api/me/profile", { headline: f.headline.trim() || null, bio: f.bio.trim() || null, city: f.city.trim() || null, phone: f.phone.trim() || null, availability: f.availability, isPublic: f.isPublic, avatarUrl: f.avatarUrl ?? null, resumeUrl: f.resumeUrl ?? null }); toast("Profile saved"); reload(); resume.reload(); }
    catch (err) { setErrors(fieldErrs(err)); toast(problem(err), "error"); } finally { setBusy(false); }
  };
  const addSkill = () => { const s = skillText.split(",").map((x) => x.trim()).filter(Boolean); if (s.length) setSkills((l) => [...new Map([...(l ?? []), ...s].map((x) => [x.toLowerCase(), x])).values()].slice(0, 50)); setSkillText(""); };
  const saveSkills = async () => { try { setSkills(((await put("/api/me/skills", { skills })) as any).skills); toast("Skills saved"); reload(); } catch (e) { toast(problem(e), "error"); } };
  const upload = (key: "avatarUrl" | "resumeUrl") => async (file?: File) => { if (!file) return; setUp(key); try { setF((s: any) => ({ ...s, [key]: undefined })); const r = await uploadFile(file); setF((s: any) => ({ ...s, [key]: r.url })); } catch (e) { toast(problem(e, "Upload failed"), "error"); } finally { setUp(""); } };
  return (
    <div className="stack">
      <PageHeader title="My profile" crumbs={[{ to: "/app", label: "Dashboard" }, { label: "Profile" }]} />
      <Card title="Profile completion">
        <div role="progressbar" aria-valuenow={p.completion.percent} aria-valuemin={0} aria-valuemax={100} aria-label="Profile completion" style={{ background: "var(--surface-2)", borderRadius: 999, height: 12, overflow: "hidden" }}><div style={{ width: `${p.completion.percent}%`, background: "var(--brand)", height: "100%" }} /></div>
        <p style={{ marginTop: ".5rem" }}><strong>{p.completion.percent}%</strong>{resume.data && <span className="muted"> · {resume.data.resume.totalExperience} of experience</span>}</p>
        {p.completion.missing.length > 0 && <ul className="small">{p.completion.missing.map((m: string) => <li key={m}>{m}</li>)}</ul>}
      </Card>
      <Card title="About you">
        <form className="stack" onSubmit={save} noValidate>
          <div className="form-grid">
            <TextField label="Headline" value={f.headline} onChange={set("headline")} error={errors.headline} placeholder="e.g. Senior cashier with 5 years' experience" maxLength={120} />
            <TextField label="City" value={f.city} onChange={set("city")} error={errors.city} />
            <TextField label="Phone (private)" type="tel" value={f.phone} onChange={set("phone")} error={errors.phone} hint="Only shared with employers you apply to." />
            <SelectField label="Availability" value={f.availability} onChange={set("availability")}><option value="available">Available now</option><option value="open">Open to offers</option><option value="unavailable">Not looking</option></SelectField>
          </div>
          <TextArea label="Bio" value={f.bio} onChange={set("bio")} error={errors.bio} maxLength={2000} />
          <div className="row">
            {f.avatarUrl && <img src={f.avatarUrl} alt="Your profile" width={64} height={64} style={{ borderRadius: "50%", objectFit: "cover" }} />}
            <label className="btn">{up === "avatarUrl" ? "Uploading…" : f.avatarUrl ? "Change photo" : "Upload photo"}<input type="file" hidden accept="image/png,image/jpeg,image/webp" disabled={!!up} onChange={(e) => { upload("avatarUrl")(e.target.files?.[0]); e.target.value = ""; }} /></label>
            <label className="btn">{up === "resumeUrl" ? "Uploading…" : f.resumeUrl ? "Replace resume (PDF)" : "Upload resume (PDF)"}<input type="file" hidden accept="application/pdf" disabled={!!up} onChange={(e) => { upload("resumeUrl")(e.target.files?.[0]); e.target.value = ""; }} /></label>
            {f.resumeUrl && <a href={f.resumeUrl} target="_blank" rel="noreferrer">View resume</a>}
          </div>
          <Check label="Make my profile public (name, headline, skills and experience; never my email or phone)" checked={f.isPublic} onChange={set("isPublic")} />
          {p.slug && f.isPublic && <p className="small muted">Your public page: <code>/people/{p.slug}</code></p>}
          <div className="actions"><Button type="submit" variant="primary" loading={busy}>Save profile</Button></div>
        </form>
      </Card>
      <Card title="Skills">
        <div className="row" style={{ marginBottom: ".75rem" }}>
          {skills.map((s) => <span key={s} className="badge badge-brand" style={{ paddingRight: 0 }}>{s}<button className="btn btn-ghost" style={{ minHeight: 44, minWidth: 44, padding: 0 }} aria-label={`Remove ${s}`} onClick={() => setSkills((l) => (l ?? []).filter((x) => x !== s))}>×</button></span>)}
          {!skills.length && <span className="muted">No skills yet.</span>}
        </div>
        <div className="row" style={{ alignItems: "flex-end" }}>
          <div className="grow"><TextField label="Add skills" value={skillText} onChange={(e) => setSkillText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addSkill(); } }} hint="Separate several with commas." /></div>
          <Button onClick={addSkill} disabled={!skillText.trim()}>Add</Button><Button variant="primary" onClick={saveSkills}>Save skills</Button>
        </div>
      </Card>
      {SECTIONS.map((s) => <EntrySection key={s.path} def={s} />)}
    </div>
  );
}

const WORK = ["full_time", "part_time", "contract", "temporary", "internship", "freelance"];
const pay = (j: any) => (j.payMin == null && j.payMax == null ? null : `${[j.payMin, j.payMax].filter((x) => x != null).map((x: number) => money(x, j.currency)).join(" – ")}${j.payPeriod ? ` / ${j.payPeriod}` : ""}`);

export function Jobs() {
  useTitle("Find jobs");
  const { toast } = useToast(); const [q, setQ] = useState(""); const dq = useDebounce(q); const [location, setLocation] = useState(""); const dl = useDebounce(location); const [workType, setWorkType] = useState(""); const [remote, setRemote] = useState(false); const [offset, setOffset] = useState(0);
  const { data, error, loading, reload } = useFetch<any>(`/api/public/jobs${qs({ q: dq, location: dl, workType, remote, limit: 10, offset })}`);
  const [apply, setApply] = useState<any>(null); const [letter, setLetter] = useState(""); const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const reset = (fn: (v: any) => void) => (e: any) => { fn(e.target.type === "checkbox" ? e.target.checked : e.target.value); setOffset(0); };
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr("");
    try { await post(`/api/jobs/${apply.id}/apply`, letter.trim() ? { coverLetter: letter.trim() } : {}); toast("Application sent"); setApply(null); setLetter(""); reload(); } catch (x) { setErr(problem(x)); } finally { setBusy(false); }
  };
  return (
    <div className="stack">
      <PageHeader title="Find jobs" crumbs={[{ to: "/app", label: "Dashboard" }, { label: "Jobs" }]} />
      <div className="filters">
        <TextField label="Keyword" type="search" value={q} onChange={reset(setQ)} placeholder="Job title or skill" /><TextField label="Location" value={location} onChange={reset(setLocation)} />
        <SelectField label="Job type" value={workType} onChange={reset(setWorkType)}><option value="">Any type</option>{WORK.map((w) => <option key={w} value={w}>{label(w)}</option>)}</SelectField>
        <Check label="Remote only" checked={remote} onChange={reset(setRemote)} />
      </div>
      {error ? <ErrorState error={error} retry={reload} /> : loading && !data ? <Spinner /> : !data.jobs.length ? <Card><Empty title="No jobs match your search">Try fewer filters or a different keyword.</Empty></Card> : (
        <div className="stack">
          {data.jobs.map((j: any) => (
            <Card key={j.id}>
              <div className="row between"><div><h2 style={{ margin: 0 }}>{j.title}</h2><p className="muted small" style={{ margin: 0 }}>{j.business.name}{j.location ? ` · ${j.location}` : ""}{j.isRemote ? " · Remote" : ""}</p></div>
                {j.applied ? <Badge tone="ok">Applied</Badge> : <Button variant="primary" onClick={() => { setApply(j); setErr(""); }}>Apply</Button>}</div>
              <p className="row" style={{ margin: ".5rem 0" }}><Badge>{label(j.workType)}</Badge>{pay(j) && <Badge tone="info">{pay(j)}</Badge>}{j.deadline && <Badge tone="warn">Apply by {date(j.deadline)}</Badge>}{j.skills.slice(0, 5).map((s: string) => <Badge key={s} tone="brand">{s}</Badge>)}</p>
              <details><summary>Details</summary><p style={{ whiteSpace: "pre-wrap", marginTop: ".5rem" }}>{j.description}</p>{j.requirements && <><h3>Requirements</h3><p style={{ whiteSpace: "pre-wrap" }}>{j.requirements}</p></>}</details>
            </Card>
          ))}
          <Pagination total={data.total} limit={10} offset={offset} onChange={setOffset} />
        </div>
      )}
      <Modal open={!!apply} title={apply ? `Apply: ${apply.title}` : "Apply"} onClose={() => setApply(null)}>
        <form className="stack" onSubmit={submit} noValidate>
          {err && <div className="banner error" role="alert">{err}</div>}
          <p className="muted small">The employer will see your full profile, including your email and phone. Make sure it is up to date.</p>
          <TextArea label="Cover letter (optional)" value={letter} onChange={(e) => setLetter(e.target.value)} maxLength={5000} />
          <div className="actions"><Button onClick={() => setApply(null)}>Cancel</Button><Button type="submit" variant="primary" loading={busy}>Send application</Button></div>
        </form>
      </Modal>
    </div>
  );
}

export function Applications() {
  useTitle("My applications");
  const { toast } = useToast(); const [status, setStatus] = useState(""); const [offset, setOffset] = useState(0);
  const { data, error, loading, reload } = useFetch<any>(`/api/me/applications${qs({ status, limit: 10, offset })}`);
  const [rm, setRm] = useState<any>(null); const [hist, setHist] = useState<Record<string, any>>({}); const [rev, setRev] = useState<any>(null);
  const toggle = async (a: any) => {
    if (hist[a.id]) return setHist((h) => { const n = { ...h }; delete n[a.id]; return n; });
    try { const r = await get<any>(`/api/me/applications/${a.id}`); setHist((h) => ({ ...h, [a.id]: r.application.history })); } catch (e) { toast(problem(e), "error"); }
  };
  return (
    <div className="stack">
      <PageHeader title="My applications" crumbs={[{ to: "/app", label: "Dashboard" }, { label: "Applications" }]} />
      <div className="filters"><SelectField label="Status" value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }}><option value="">All</option>{["applied", "shortlisted", "interview", "selected", "rejected", "withdrawn"].map((s) => <option key={s} value={s}>{label(s)}</option>)}</SelectField></div>
      {error ? <ErrorState error={error} retry={reload} /> : loading && !data ? <Spinner /> : !data.applications.length ? <Card><Empty title="No applications yet">Find a job you like and apply in a couple of taps.</Empty></Card> : (
        <div className="stack">
          {data.applications.map((a: any) => (
            <Card key={a.id}>
              <div className="row between"><div><h2 style={{ margin: 0 }}>{a.jobTitle}</h2><p className="muted small" style={{ margin: 0 }}>{a.businessName} · applied {date(a.appliedAt)}</p></div><Badge tone={statusTone(a.status)}>{label(a.status)}</Badge></div>
              {a.interviewAt && a.status === "interview" && <p className="banner ok" style={{ marginTop: ".5rem" }}>Interview scheduled for {new Date(a.interviewAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</p>}
              <div className="actions" style={{ marginTop: ".75rem" }}>
                <Button small onClick={() => toggle(a)} aria-expanded={!!hist[a.id]}>{hist[a.id] ? "Hide history" : "View history"}</Button>
                {["applied", "shortlisted", "interview"].includes(a.status) && <Button small variant="danger" onClick={() => setRm(a)}>Withdraw</Button>}
                {["interview", "selected"].includes(a.status) && <Button small onClick={() => setRev(a)}>Review {a.businessName}</Button>}
              </div>
              {hist[a.id] && <ul className="list" style={{ marginTop: ".5rem" }}>{hist[a.id].map((h: any, i: number) => <li key={i}><span><Badge tone={statusTone(h.status)}>{label(h.status)}</Badge>{h.note && <> {h.note}</>}</span><span className="muted small">{date(h.createdAt)}</span></li>)}</ul>}
            </Card>
          ))}
          <Pagination total={data.total} limit={10} offset={offset} onChange={setOffset} />
        </div>
      )}
      {rev && <ReviewModal subjectType="business" subjectId={rev.businessId} subjectName={rev.businessName} onClose={() => setRev(null)} />}
      <ConfirmDialog open={!!rm} danger title="Withdraw application?" confirmLabel="Withdraw" message={rm && `You will no longer be considered for ${rm.jobTitle}. You can't re-apply to the same job.`} onClose={() => setRm(null)}
        onConfirm={async () => { try { await post(`/api/me/applications/${rm.id}/withdraw`); toast("Application withdrawn"); setRm(null); reload(); } catch (e) { toast(problem(e), "error"); setRm(null); } }} />
    </div>
  );
}
