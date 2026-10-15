import { useState } from "react";
import { Badge, Button, Card, DataTable, Empty, ErrorState, PageHeader, SelectField, Spinner, Stat, TextField } from "../components/ui";
import { ApiError, download, qs } from "../lib/api";
import { useBusiness } from "../lib/business";
import { date, label, money, num } from "../lib/format";
import { useFetch, useTitle } from "../lib/hooks";
import { useToast } from "../lib/toast";

const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => iso(new Date(Date.now() - n * 86_400_000));
const monthStart = () => { const n = new Date(); return iso(new Date(Date.UTC(n.getFullYear(), n.getMonth(), 1))); };
const MONEY_KEY = /sales|revenue|value|pay|pipeline|spent|refund|purchased|committed/i;
const NO_DATES = ["inventory"];

const cell = (v: any, type: string) => (v === null || v === undefined || v === "" ? "—" : type === "money" ? money(v) : type === "percent" ? `${v}%` : type === "date" ? date(v) : type === "number" ? num(v) : String(v));
const pretty = (k: string) => label(k.replace(/([A-Z])/g, " $1").replace(/^status_/, "status: ").toLowerCase());

export default function Reports() {
  useTitle("Reports"); const { current } = useBusiness(); const { toast } = useToast(); const base = `/api/businesses/${current!.id}/reports`;
  const cat = useFetch<{ reports: { key: string; title: string }[] }>(base);
  const [type, setType] = useState(""); const [from, setFrom] = useState(daysAgo(29)); const [to, setTo] = useState(iso(new Date())); const [busy, setBusy] = useState("");
  const key = type || cat.data?.reports[0]?.key || "";
  const path = key ? `${base}/${key}${qs({ from, to })}` : null;
  const { data, error, loading, reload } = useFetch<any>(path);
  const noDates = NO_DATES.includes(key); const bad = from > to;
  const dl = async (format: "csv" | "pdf") => { setBusy(format); try { await download(`${base}/${key}${qs({ from, to, format })}`, `${key}.${format}`); } catch (e) { toast(e instanceof ApiError ? e.message : "Download failed", "error"); } finally { setBusy(""); } };
  const preset = (f: string, t: string) => () => { setFrom(f); setTo(t); };
  return (
    <div className="stack">
      <PageHeader title="Reports" crumbs={[{ to: "/app", label: "Dashboard" }, { label: "Reports" }]} />
      {cat.error ? <ErrorState error={cat.error} retry={cat.reload} /> : cat.loading && !cat.data ? <Spinner /> : !cat.data?.reports.length ? <Card><Empty title="No reports available">Your role doesn't include any reports.</Empty></Card> : (<>
        <Card>
          <div className="filters">
            <SelectField label="Report" value={key} onChange={(e) => setType(e.target.value)}>{cat.data.reports.map((r) => <option key={r.key} value={r.key}>{r.title}</option>)}</SelectField>
            <TextField label="From" type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} disabled={noDates} />
            <TextField label="To" type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} disabled={noDates} />
          </div>
          {noDates ? <p className="muted small">This report shows current stock, so dates don't apply.</p> : (
            <div className="actions" aria-label="Date presets"><Button small onClick={preset(daysAgo(6), iso(new Date()))}>Last 7 days</Button><Button small onClick={preset(daysAgo(29), iso(new Date()))}>Last 30 days</Button><Button small onClick={preset(monthStart(), iso(new Date()))}>This month</Button><Button small onClick={preset(daysAgo(89), iso(new Date()))}>Last 90 days</Button></div>
          )}
          {bad && <p className="field-error" role="alert">The start date must be on or before the end date.</p>}
        </Card>
        {bad ? null : error ? <ErrorState error={error} retry={reload} /> : loading && !data ? <Spinner /> : data && (<>
          <div className="row between"><h2 style={{ margin: 0 }}>{data.title} <Badge>{data.rows.length} row{data.rows.length === 1 ? "" : "s"}</Badge></h2>
            <div className="actions"><Button loading={busy === "csv"} onClick={() => dl("csv")}>Download CSV</Button><Button loading={busy === "pdf"} onClick={() => dl("pdf")}>Download PDF</Button></div></div>
          {data.summary && <div className="grid cols-4">{Object.entries(data.summary).map(([k, v]) => <Stat key={k} label={pretty(k)} value={typeof v === "number" ? (MONEY_KEY.test(k) ? money(v) : num(v)) : String(v)} />)}</div>}
          <Card><DataTable rows={data.rows} empty={<Empty title="No data for this period">Try a wider date range.</Empty>} cols={data.columns.map((c: any) => ({ key: c.key, label: c.label, num: ["money", "number", "percent"].includes(c.type), render: (r: any) => cell(r[c.key], c.type) }))} /></Card>
        </>)}
      </>)}
    </div>
  );
}
