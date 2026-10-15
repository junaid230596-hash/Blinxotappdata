import { useEffect, useId, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "../lib/api";

export const Logo = ({ size = 30 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label="Blinxot logo">
    <rect width="64" height="64" rx="14" fill="#4f46e5" />
    <path d="M20 16h14a10 10 0 0 1 4 19 11 11 0 0 1-5 13H20z M28 24v6h6a3 3 0 0 0 0-6z M28 37v7h6a3.5 3.5 0 0 0 0-7z" fill="#fff" fillRule="evenodd" />
  </svg>
);

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "danger" | "ghost" | "default"; loading?: boolean; small?: boolean };
export function Button({ variant = "default", loading, small, className = "", children, disabled, type = "button", ...p }: BtnProps) {
  return <button type={type} className={`btn ${variant === "primary" ? "btn-primary" : variant === "danger" ? "btn-danger" : variant === "ghost" ? "btn-ghost" : ""} ${small ? "btn-sm" : ""} ${className}`} disabled={disabled || loading} aria-busy={loading || undefined} {...p}>{loading ? "Please wait…" : children}</button>;
}

interface FieldProps { label: string; error?: string; hint?: string }
function FieldShell({ label, error, hint, children, id }: FieldProps & { children: (a: { id: string; "aria-invalid"?: boolean; "aria-describedby"?: string }) => ReactNode; id: string }) {
  const desc = error ? `${id}-e` : hint ? `${id}-h` : undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children({ id, "aria-invalid": error ? true : undefined, "aria-describedby": desc })}
      {error ? <span id={`${id}-e`} className="field-error" role="alert">{error}</span> : hint ? <span id={`${id}-h`} className="hint">{hint}</span> : null}
    </div>
  );
}
export function TextField({ label, error, hint, ...p }: FieldProps & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId(); return <FieldShell id={id} label={label} error={error} hint={hint}>{(a) => <input className="input" {...a} {...p} />}</FieldShell>;
}
export function SelectField({ label, error, hint, children, ...p }: FieldProps & SelectHTMLAttributes<HTMLSelectElement>) {
  const id = useId(); return <FieldShell id={id} label={label} error={error} hint={hint}>{(a) => <select className="select" {...a} {...p}>{children}</select>}</FieldShell>;
}
export function TextArea({ label, error, hint, ...p }: FieldProps & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const id = useId(); return <FieldShell id={id} label={label} error={error} hint={hint}>{(a) => <textarea className="textarea" {...a} {...p} />}</FieldShell>;
}
export function Check({ label, ...p }: { label: string } & InputHTMLAttributes<HTMLInputElement>) {
  return <label className="check"><input type="checkbox" {...p} /> <span>{label}</span></label>;
}

export const Card = ({ children, title, className = "" }: { children: ReactNode; title?: string; className?: string }) => <section className={`card ${className}`}>{title && <h2>{title}</h2>}{children}</section>;
export const Badge = ({ tone, children }: { tone?: "ok" | "warn" | "danger" | "info" | "brand"; children: ReactNode }) => <span className={`badge ${tone ? `badge-${tone}` : ""}`}>{children}</span>;
export const Spinner = () => <div className="spinner" role="status" aria-label="Loading" />;
// A bold paragraph rather than a heading: an empty state can appear right under the page <h1>, and skipping heading levels breaks screen-reader navigation.
export const Empty = ({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) => <div className="empty"><p className="empty-title">{title}</p>{children && <p>{children}</p>}{action}</div>;
export function ErrorState({ error, retry }: { error: ApiError | Error; retry?: () => void }) {
  return <div className="banner error" role="alert"><span>{error.message}</span>{retry && <Button small onClick={retry}>Try again</Button>}</div>;
}
export function Stat({ label, value, delta, tone }: { label: string; value: ReactNode; delta?: string | null; tone?: "up" | "down" }) {
  return <div className="card stat"><span className="v">{value}</span><span className="l">{label}</span>{delta && <span className={`d ${tone ?? ""}`}>{delta}</span>}</div>;
}
export function PageHeader({ title, crumbs, children }: { title: string; crumbs?: { to?: string; label: string }[]; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        {crumbs && <nav className="crumbs" aria-label="Breadcrumb">{crumbs.map((c, i) => <span key={i}>{c.to ? <Link to={c.to}>{c.label}</Link> : c.label}{i < crumbs.length - 1 && " /"}</span>)}</nav>}
        <h1>{title}</h1>
      </div>
      {children && <div className="actions">{children}</div>}
    </div>
  );
}

export interface Col<T> { key: string; label: string; render?: (row: T) => ReactNode; num?: boolean }
/** A real <table> on desktop; each row becomes a labelled card on phones (pure CSS, via data-label). */
export function DataTable<T extends { id?: string | number }>({ cols, rows, actions, empty }: { cols: Col<T>[]; rows: T[]; actions?: (r: T) => ReactNode; empty?: ReactNode }) {
  if (!rows.length) return <>{empty ?? <Empty title="Nothing here yet" />}</>;
  return (
    <div className="table-wrap">
      <table className="rt">
        <thead><tr>{cols.map((c) => <th key={c.key} className={c.num ? "num" : ""} scope="col">{c.label}</th>)}{actions && <th scope="col"><span className="sr-only">Actions</span></th>}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id ?? i}>
              {cols.map((c) => <td key={c.key} data-label={c.label} className={c.num ? "num" : ""}>{c.render ? c.render(r) : String((r as any)[c.key] ?? "—")}</td>)}
              {actions && <td className="actions-cell"><div className="actions">{actions(r)}</div></td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Pagination({ total, limit, offset, onChange }: { total: number; limit: number; offset: number; onChange: (offset: number) => void }) {
  if (total <= limit) return null;
  const page = Math.floor(offset / limit) + 1, pages = Math.ceil(total / limit);
  return (
    <nav className="row between" aria-label="Pagination" style={{ marginTop: "1rem" }}>
      <Button small disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>Previous</Button>
      <span className="muted small" aria-live="polite">Page {page} of {pages}</span>
      <Button small disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}>Next</Button>
    </nav>
  );
}

export function Modal({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null); const id = useId();
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    // Land on the first form field; for confirmations, on the first action (Cancel, the safest choice) — never the "×" close button.
    const first = ref.current?.querySelector<HTMLElement>("input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled])")
      ?? ref.current?.querySelector<HTMLElement>(".actions button:not([disabled])") ?? ref.current;
    first?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab" && ref.current) {       // keep keyboard focus inside the dialog
        const f = [...ref.current.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input, select, textarea")];
        if (!f.length) return; const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", key); document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", key); document.body.style.overflow = ""; prev?.focus(); };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={id} ref={ref} tabIndex={-1}>
        <div className="row between"><h2 id={id}>{title}</h2><Button variant="ghost" aria-label="Close dialog" onClick={onClose}>×</Button></div>
        {children}
      </div>
    </div>
  );
}

export function ConfirmDialog({ open, title, message, confirmLabel = "Confirm", danger, loading, onConfirm, onClose }:
  { open: boolean; title: string; message: ReactNode; confirmLabel?: string; danger?: boolean; loading?: boolean; onConfirm: () => void; onClose: () => void }) {
  return (
    <Modal open={open} title={title} onClose={onClose}>
      <p>{message}</p>
      <div className="actions"><Button onClick={onClose}>Cancel</Button><Button variant={danger ? "danger" : "primary"} loading={loading} onClick={onConfirm}>{confirmLabel}</Button></div>
    </Modal>
  );
}

export const statusTone = (s: string): "ok" | "warn" | "danger" | "info" | "brand" | undefined =>
  ({ delivered: "ok", paid: "ok", approved: "ok", selected: "ok", active: "ok", completed: "ok", received: "ok", accepted: "info", processing: "info", ready: "info", dispatched: "info", shortlisted: "info", interview: "brand", in_progress: "info",
    pending: "warn", draft: "warn", review: "warn", applied: "warn", cancelled: "danger", rejected: "danger", returned: "danger", withdrawn: "danger", inactive: "danger", suspended: "danger" } as const)[s as "delivered"];
