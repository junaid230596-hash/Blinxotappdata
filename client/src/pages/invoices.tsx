import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { qs } from "../lib/api";
import { useBusiness } from "../lib/business";
import { date, label, money, num } from "../lib/format";
import { useDebounce, useFetch, useTitle } from "../lib/hooks";
import { Badge, Button, Card, DataTable, Empty, ErrorState, PageHeader, Pagination, SelectField, Spinner, TextField } from "../components/ui";

export function Invoices() {
  useTitle("Invoices"); const { current } = useBusiness();
  const [q, setQ] = useState(""); const dq = useDebounce(q); const [status, setStatus] = useState(""); const [offset, setOffset] = useState(0);
  const { data, error, loading, reload } = useFetch<any>(`/api/businesses/${current!.id}/invoices${qs({ q: dq, status, limit: 25, offset })}`);
  return (
    <div className="stack">
      <PageHeader title="Invoices" crumbs={[{ to: "/app", label: "Dashboard" }, { label: "Invoices" }]} />
      <p className="muted small">Invoices are numbered and issued automatically when you accept an order. A cancelled order's invoice is marked void and its number is never reused.</p>
      <div className="filters">
        <TextField label="Search" type="search" value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }} placeholder="Invoice no., order no. or customer" />
        <SelectField label="Status" value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }}><option value="">All</option><option value="issued">Issued</option><option value="void">Void</option></SelectField>
      </div>
      {error ? <ErrorState error={error} retry={reload} /> : loading && !data ? <Spinner /> : (
        <Card><DataTable rows={data.invoices} empty={<Empty title="No invoices yet">Accept an order and its invoice appears here.</Empty>} cols={[
          { key: "number", label: "Invoice", render: (i: any) => <Link to={`/app/invoices/${i.id}`}><strong>{i.number}</strong></Link> },
          { key: "issuedAt", label: "Date", render: (i: any) => date(i.issuedAt) },
          { key: "orderNumber", label: "Order", render: (i: any) => <Link to={`/app/orders/${i.orderId}`}>{i.orderNumber}</Link> },
          { key: "buyerName", label: "Customer", render: (i: any) => i.buyerName ?? "—" },
          { key: "status", label: "Status", render: (i: any) => <><Badge tone={i.status === "void" ? "danger" : "ok"}>{label(i.status)}</Badge>{i.creditNoteCount > 0 && <> <Badge tone="warn">{i.creditNoteCount} credit note{i.creditNoteCount === 1 ? "" : "s"}</Badge></>}</> },
          { key: "total", label: "Total", num: true, render: (i: any) => money(i.total) },
        ]} /><Pagination total={data.total} limit={25} offset={offset} onChange={setOffset} /></Card>)}
    </div>
  );
}

const pct = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(2)}%`;

/** A printable tax document: Tax Invoice / Invoice / Credit Note. Older invoices (issued before GST support) have no `gst` block and render in the simple layout. */
export function TaxDocument({ d, number, issuedAt, voided }: { d: any; number: string; issuedAt: string; voided?: boolean }) {
  const mode: "intra" | "inter" | "none" = d.gst?.mode ?? "none"; const inr = d.currency ?? "INR"; const hasHsn = d.items.some((i: any) => i.hsn);
  const credit = d.title === "Credit Note"; const seller = d.seller;
  return (
    <article className="invoice" aria-label={`${d.title ?? "Invoice"} ${number}`}>
      {voided && <p className="invoice-void" role="status">VOID — the order was cancelled</p>}
      <header className="invoice-head">
        <div>
          <p className="invoice-seller">{seller.legalName || seller.name}</p>
          {seller.legalName && seller.legalName !== seller.name && <p className="small muted">Trading as {seller.name}</p>}
          {seller.address && <p style={{ whiteSpace: "pre-line" }}>{seller.address}</p>}
          <p className="small">{[seller.phone, seller.email, seller.website].filter(Boolean).join(" · ")}</p>
          {seller.gstin && <p className="small"><strong>GSTIN:</strong> {seller.gstin}{seller.stateName ? ` · ${seller.stateName} (${seller.stateCode})` : ""}</p>}
        </div>
        <div className="invoice-meta">
          <h2>{d.title ?? "Invoice"}</h2><p><strong>{number}</strong></p><p className="small">Date: {date(issuedAt)}</p>
          {credit ? <p className="small">Against invoice {d.against?.number}{d.against?.issuedAt ? ` dated ${date(d.against.issuedAt)}` : ""}</p> : <p className="small">Order: {d.orderNumber}</p>}
        </div>
      </header>
      <section className="invoice-bill"><h3>{credit ? "Credit to" : "Billed to"}</h3><p><strong>{d.buyer.name}</strong></p>{d.buyer.address && <p style={{ whiteSpace: "pre-line" }}>{d.buyer.address}</p>}
        <p className="small">{[d.buyer.phone, d.buyer.gstin ? `GSTIN ${d.buyer.gstin}` : null].filter(Boolean).join(" · ")}</p>
        {d.placeOfSupply && <p className="small"><strong>Place of supply:</strong> {d.placeOfSupply.name} ({d.placeOfSupply.code})</p>}
        {d.deliveryAddress && d.deliveryAddress !== d.buyer.address && <><h3>Deliver to</h3><p style={{ whiteSpace: "pre-line" }}>{d.deliveryAddress}</p></>}
        {credit && d.reason && <p className="small"><strong>Reason:</strong> {d.reason}</p>}</section>
      <div className="table-wrap"><table className="table"><caption className="sr-only">Items</caption>
        <thead><tr><th scope="col">Item</th>{hasHsn && <th scope="col">HSN/SAC</th>}<th scope="col" className="num">Qty</th><th scope="col" className="num">Rate</th><th scope="col" className="num">Taxable</th>
          {mode === "intra" && <><th scope="col" className="num">CGST</th><th scope="col" className="num">SGST</th></>}{mode === "inter" && <th scope="col" className="num">IGST</th>}{mode === "none" && <th scope="col" className="num">Tax</th>}
          <th scope="col" className="num">Amount</th></tr></thead>
        <tbody>{d.items.map((i: any, n: number) => {
          const half = i.taxRate / 2; const taxable = i.taxable ?? i.lineSubtotal ?? i.lineTotal - (i.lineTax ?? 0);
          return <tr key={n}><td>{i.name}{i.sku && <><br /><span className="small muted">{i.sku}</span></>}</td>{hasHsn && <td>{i.hsn ?? "—"}</td>}<td className="num">{num(i.quantity)}</td><td className="num">{money(i.unitPrice, inr)}</td><td className="num">{money(taxable, inr)}</td>
            {mode === "intra" && <><td className="num">{money(i.cgst, inr)}<br /><span className="small muted">{pct(half)}</span></td><td className="num">{money(i.sgst, inr)}<br /><span className="small muted">{pct(half)}</span></td></>}
            {mode === "inter" && <td className="num">{money(i.igst, inr)}<br /><span className="small muted">{pct(i.taxRate)}</span></td>}
            {mode === "none" && <td className="num">{pct(i.taxRate)}</td>}
            <td className="num">{money(i.lineTotal, inr)}</td></tr>;
        })}</tbody></table></div>
      <ul className="list totals invoice-totals">
        <li><span>Taxable value</span><span>{money(d.subtotal, inr)}</span></li>
        {mode === "intra" && <><li><span>CGST</span><span>{money(d.cgstTotal, inr)}</span></li><li><span>SGST</span><span>{money(d.sgstTotal, inr)}</span></li></>}
        {mode === "inter" && <li><span>IGST</span><span>{money(d.igstTotal, inr)}</span></li>}
        {mode === "none" && <li><span>Tax</span><span>{money(d.taxTotal, inr)}</span></li>}
        <li><strong>{credit ? "Total credit" : "Total"}</strong><strong>{money(d.total, inr)}</strong></li>
      </ul>
      {d.amountInWords && <p className="small"><strong>Amount in words:</strong> {d.amountInWords}</p>}
      {mode !== "none" && d.hsnSummary?.length > 0 && (
        <div className="table-wrap"><table className="table"><caption className="small muted">Tax summary by HSN/SAC</caption>
          <thead><tr><th scope="col">HSN/SAC</th><th scope="col" className="num">Taxable</th><th scope="col" className="num">Rate</th>{mode === "intra" ? <><th scope="col" className="num">CGST</th><th scope="col" className="num">SGST</th></> : <th scope="col" className="num">IGST</th>}<th scope="col" className="num">Total tax</th></tr></thead>
          <tbody>{d.hsnSummary.map((h: any, n: number) => <tr key={n}><td>{h.hsn}</td><td className="num">{money(h.taxable, inr)}</td><td className="num">{pct(h.taxRate)}</td>{mode === "intra" ? <><td className="num">{money(h.cgst, inr)}</td><td className="num">{money(h.sgst, inr)}</td></> : <td className="num">{money(h.igst, inr)}</td>}<td className="num">{money(h.tax, inr)}</td></tr>)}</tbody></table></div>)}
      <p className="small muted">This is a computer-generated document and does not require a signature.</p>
    </article>
  );
}

export function InvoiceDocument({ invoice }: { invoice: any }) { return <TaxDocument d={invoice.details} number={invoice.number} issuedAt={invoice.issuedAt} voided={invoice.status === "void"} />; }

function Viewer({ url, back, crumbs }: { url: string; back: string; crumbs: { to?: string; label: string }[] }) {
  useTitle("Invoice");
  const { data, error, loading, reload } = useFetch<{ invoice: any }>(url);
  if (error) return <ErrorState error={error} retry={reload} />;
  if (loading || !data) return <Spinner />;
  return (
    <div className="stack">
      <PageHeader title={`Invoice ${data.invoice.number}`} crumbs={[...crumbs, { label: data.invoice.number }]}>
        <Link className="btn" to={back}>Back</Link><Button variant="primary" onClick={() => window.print()}>Print / Save as PDF</Button>
      </PageHeader>
      <Card><InvoiceDocument invoice={data.invoice} /></Card>
      {data.invoice.creditNotes?.length > 0 && (
        <section className="stack" aria-labelledby="cn-h"><h2 id="cn-h">Credit notes</h2>
          {data.invoice.creditNotes.map((cn: any) => <Card key={cn.id}><TaxDocument d={cn.details} number={cn.number} issuedAt={cn.issuedAt} /></Card>)}</section>)}
    </div>
  );
}
export function InvoiceView() { const { id = "" } = useParams(); const { current } = useBusiness(); return <Viewer url={`/api/businesses/${current!.id}/invoices/${encodeURIComponent(id)}`} back="/app/invoices" crumbs={[{ to: "/app", label: "Dashboard" }, { to: "/app/invoices", label: "Invoices" }]} />; }
export function MyInvoiceView() { const { id = "" } = useParams(); return <Viewer url={`/api/me/orders/${encodeURIComponent(id)}/invoice`} back={`/app/my-orders/${id}`} crumbs={[{ to: "/app", label: "Dashboard" }, { to: "/app/my-orders", label: "My orders" }]} />; }
