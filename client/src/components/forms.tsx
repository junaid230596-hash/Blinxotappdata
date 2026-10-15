import { useState, type FormEvent, type ReactNode } from "react";
import { ApiError } from "../lib/api";
import { useDebounce, useFetch } from "../lib/hooks";
import { qs } from "../lib/api";
import { Button, Card, DataTable, Empty, ErrorState, Modal, PageHeader, Pagination, SelectField, Spinner, TextArea, TextField, type Col } from "./ui";

export interface FieldDef {
  key: string; label: string; type?: "text" | "email" | "tel" | "url" | "number" | "date" | "datetime" | "time" | "select" | "multi" | "textarea" | "checkbox" | "csv" | "password";
  required?: boolean; options?: [string, string][]; hint?: string; step?: string; min?: number; max?: number; placeholder?: string;
  nullWhenEmpty?: boolean; show?: (v: Record<string, any>) => boolean; full?: boolean;
}

const asInput = (f: FieldDef, v: any) => (f.type === "multi" ? (Array.isArray(v) ? v : []) : v == null ? "" : f.type === "csv" ? (v as string[]).join(", ") : f.type === "checkbox" ? !!v : f.type === "datetime" && v ? new Date(new Date(v).getTime() - new Date(v).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : f.type === "date" ? String(v).slice(0, 10) : String(v));

/** Turns what the person typed into the JSON the API expects: blanks are omitted (or null when clearing), numbers/arrays converted. */
export function buildBody(fields: FieldDef[], v: Record<string, any>) {
  const body: Record<string, any> = {};
  for (const f of fields) {
    if (f.show && !f.show(v)) continue;
    const raw = v[f.key];
    if (f.type === "checkbox") { body[f.key] = !!raw; continue; }
    if (f.type === "multi") { body[f.key] = raw ?? []; continue; }
    const t = typeof raw === "string" ? raw.trim() : raw;
    if (t === "" || t == null) { if (f.nullWhenEmpty) body[f.key] = null; continue; }
    body[f.key] = f.type === "number" ? Number(t) : f.type === "csv" ? String(t).split(",").map((s) => s.trim()).filter(Boolean) : f.type === "datetime" ? new Date(t as string).toISOString() : t;
  }
  return body;
}

function initialValues(fields: FieldDef[], initial: Record<string, any>) {
  return Object.fromEntries(fields.map((f) => [f.key, asInput(f, initial[f.key] ?? (f.type === "select" ? f.options?.[0]?.[0] ?? "" : undefined))]));
}

function FieldGrid({ fields, v, set, errors }: { fields: FieldDef[]; v: Record<string, any>; set: (k: string) => (e: any) => void; errors: Record<string, string> }) {
  return (
    <div className="form-grid">
      {fields.filter((f) => !f.show || f.show(v)).map((f) => {
        const common = { label: f.label, error: errors[f.key], hint: f.hint, required: f.required };
        if (f.type === "textarea") return <div key={f.key} style={{ gridColumn: "1 / -1" }}><TextArea {...common} value={v[f.key]} onChange={set(f.key)} placeholder={f.placeholder} /></div>;
        if (f.type === "select") return <SelectField key={f.key} {...common} value={v[f.key]} onChange={set(f.key)}>{f.options!.map(([val, l]) => <option key={val} value={val}>{l}</option>)}</SelectField>;
        if (f.type === "checkbox") return <label key={f.key} className="check" style={{ gridColumn: "1 / -1" }}><input type="checkbox" checked={!!v[f.key]} onChange={set(f.key)} /> <span>{f.label}</span></label>;
        if (f.type === "multi") return (
          <fieldset key={f.key} style={{ gridColumn: "1 / -1", border: 0, padding: 0, margin: 0 }}>
            <legend style={{ fontWeight: 600, fontSize: ".9rem", marginBottom: 4 }}>{f.label}</legend>
            {f.options!.map(([val, l]) => (
              <label key={val} className="check"><input type="checkbox" checked={(v[f.key] as string[]).includes(val)} onChange={(e) => set(f.key)({ target: { type: "multi", value: e.target.checked ? [...v[f.key], val] : (v[f.key] as string[]).filter((x) => x !== val) } })} /> <span>{l}</span></label>
            ))}
            {errors[f.key] ? <span className="field-error" role="alert">{errors[f.key]}</span> : f.hint ? <span className="hint">{f.hint}</span> : null}
          </fieldset>
        );
        return <TextField key={f.key} {...common} type={f.type === "csv" || !f.type ? "text" : f.type === "datetime" ? "datetime-local" : f.type} inputMode={f.type === "number" ? "decimal" : f.type === "tel" ? "tel" : f.type === "email" ? "email" : f.type === "url" ? "url" : undefined}
          step={f.step ?? (f.type === "number" ? "any" : undefined)} min={f.min} max={f.max} placeholder={f.placeholder} value={v[f.key]} onChange={set(f.key)} />;
      })}
    </div>
  );
}

function useFormState(fields: FieldDef[], initial: Record<string, any>, onSubmit: (body: Record<string, any>) => Promise<unknown>, after?: () => void) {
  const [v, setV] = useState<Record<string, any>>(() => initialValues(fields, initial));
  const [errors, setErrors] = useState<Record<string, string>>({}); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const set = (k: string) => (e: any) => setV((s) => ({ ...s, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(""); setErrors({});
    try { await onSubmit(buildBody(fields, v)); after?.(); }
    catch (err) {
      if (err instanceof ApiError) { setError(err.message); if (err.code === "BAD_REQUEST" && err.details && typeof err.details === "object") setErrors(err.details); } else setError("Something went wrong. Please try again.");
    } finally { setBusy(false); }
  };
  return { v, set, errors, error, busy, submit };
}

export function FormModal({ title, fields, initial = {}, submitLabel = "Save", onSubmit, onClose, children, intro }:
  { title: string; fields: FieldDef[]; initial?: Record<string, any>; submitLabel?: string; onSubmit: (body: Record<string, any>) => Promise<unknown>; onClose: () => void; children?: ReactNode; intro?: ReactNode }) {
  const f = useFormState(fields, initial, onSubmit, onClose);
  return (
    <Modal open title={title} onClose={onClose}>
      <form className="stack" onSubmit={f.submit} noValidate>
        {f.error && <div className="banner error" role="alert">{f.error}</div>}
        {intro}
        <FieldGrid fields={fields} v={f.v} set={f.set} errors={f.errors} />
        {children}
        <div className="actions"><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" loading={f.busy}>{submitLabel}</Button></div>
      </form>
    </Modal>
  );
}

/** The same form, inline on the page (settings screens). */
export function InlineForm({ fields, initial = {}, submitLabel = "Save changes", onSubmit, children, disabled }:
  { fields: FieldDef[]; initial?: Record<string, any>; submitLabel?: string; onSubmit: (body: Record<string, any>) => Promise<unknown>; children?: ReactNode; disabled?: boolean }) {
  const f = useFormState(fields, initial, onSubmit);
  return (
    <form className="stack" onSubmit={f.submit} noValidate>
      {f.error && <div className="banner error" role="alert">{f.error}</div>}
      <fieldset disabled={disabled} style={{ border: 0, padding: 0, margin: 0 }}><FieldGrid fields={fields} v={f.v} set={f.set} errors={f.errors} /></fieldset>
      {children}
      {!disabled && <div className="actions"><Button type="submit" variant="primary" loading={f.busy}>{submitLabel}</Button></div>}
    </form>
  );
}

export interface FilterDef { key: string; label: string; options: [string, string][]; initial?: string }

/** A searchable, filterable, paged list. `listKey` is the array's name in the API response. */
export function ListPage<T extends { id?: string | number }>({ title, crumbs, endpoint, listKey, cols, filters = [], search = "Search", searchParam = "q", extra, actions, headerActions, empty, pageSize = 25, children }:
  { searchParam?: string; title: string; crumbs?: { to?: string; label: string }[]; endpoint: string; listKey: string; cols: Col<T>[]; filters?: FilterDef[]; search?: string | false; extra?: Record<string, unknown>;
    actions?: (row: T, reload: () => void) => ReactNode; headerActions?: (reload: () => void) => ReactNode; empty?: ReactNode; pageSize?: number; children?: (reload: () => void) => ReactNode }) {
  const [q, setQ] = useState(""); const dq = useDebounce(q); const [offset, setOffset] = useState(0);
  const [f, setF] = useState<Record<string, string>>(() => Object.fromEntries(filters.map((x) => [x.key, x.initial ?? ""])));
  const { data, error, loading, reload } = useFetch<any>(`${endpoint}${qs({ ...(search ? { [searchParam]: dq } : {}), ...f, ...extra, limit: pageSize, offset })}`);
  return (
    <div className="stack">
      <PageHeader title={title} crumbs={crumbs}>{headerActions?.(reload)}</PageHeader>
      {(search || filters.length > 0) && (
        <div className="filters">
          {search && <TextField label={search} type="search" value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }} />}
          {filters.map((x) => <SelectField key={x.key} label={x.label} value={f[x.key]} onChange={(e) => { setF((s) => ({ ...s, [x.key]: e.target.value })); setOffset(0); }}>{x.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</SelectField>)}
        </div>
      )}
      {children?.(reload)}
      {error ? <ErrorState error={error} retry={reload} /> : loading && !data ? <Spinner /> : (
        <Card>
          <DataTable rows={data[listKey]} cols={cols} actions={actions ? (r) => actions(r, reload) : undefined} empty={empty ?? <Empty title="Nothing here yet" />} />
          <Pagination total={data.total ?? data[listKey].length} limit={pageSize} offset={offset} onChange={setOffset} />
        </Card>
      )}
    </div>
  );
}
