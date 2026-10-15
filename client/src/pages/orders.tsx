import { useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApiError, patch, post, qs } from "../lib/api";
import { useBusiness } from "../lib/business";
import { date, dateTime, label, money, num } from "../lib/format";
import { useDebounce, useFetch, useTitle } from "../lib/hooks";
import { STATES } from "../lib/states";
import { useToast } from "../lib/toast";
import { Badge, Button, Card, Check, ConfirmDialog, DataTable, Empty, ErrorState, Modal, PageHeader, Pagination, SelectField, Spinner, statusTone, TextArea, TextField } from "../components/ui";

const STATUSES = ["pending", "accepted", "processing", "ready", "dispatched", "delivered", "cancelled", "returned"];

export function Orders() {
  useTitle("Orders");
  const { current, can } = useBusiness(); const [status, setStatus] = useState(""); const [source, setSource] = useState(""); const [q, setQ] = useState(""); const dq = useDebounce(q); const [offset, setOffset] = useState(0);
  const { data, error, loading, reload } = useFetch<any>(`/api/businesses/${current!.id}/orders${qs({ status, source, q: dq, limit: 25, offset })}`);
  const reset = (fn: (v: string) => void) => (e: { target: { value: string } }) => { fn(e.target.value); setOffset(0); };
  return (
    <div className="stack">
      <PageHeader title="Orders" crumbs={[{ to: "/app", label: "Dashboard" }, { label: "Orders" }]}>{can("orders.create") && <Link className="btn btn-primary" to="/app/orders/new">New order</Link>}</PageHeader>
      <div className="filters">
        <TextField label="Search" type="search" value={q} onChange={reset(setQ)} placeholder="Order number" />
        <SelectField label="Status" value={status} onChange={reset(setStatus)}><option value="">All statuses</option>{STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</SelectField>
        <SelectField label="Source" value={source} onChange={reset(setSource)}><option value="">All sources</option><option value="direct">Direct sales</option><option value="marketplace">From the marketplace</option></SelectField>
      </div>
      {error ? <ErrorState error={error} retry={reload} /> : loading && !data ? <Spinner /> : (
        <Card><DataTable rows={data.orders} empty={<Empty title="No orders found">Orders you create or receive will appear here.</Empty>}
          cols={[
            { key: "orderNumber", label: "Order", render: (o: any) => <Link to={`/app/orders/${o.id}`}><strong>{o.orderNumber}</strong></Link> },
            { key: "createdAt", label: "Created", render: (o: any) => date(o.createdAt) },
            { key: "party", label: "Customer", render: (o: any) => o.customerName ?? o.buyerName ?? "Walk-in" },
            { key: "status", label: "Status", render: (o: any) => <Badge tone={statusTone(o.status)}>{label(o.status)}</Badge> },
            { key: "total", label: "Total", num: true, render: (o: any) => money(o.total) },
          ]} />
          <Pagination total={data.total} limit={25} offset={offset} onChange={setOffset} />
        </Card>
      )}
    </div>
  );
}

interface Line { product: any; qty: string; price: string }

export function NewOrder() {
  useTitle("New order");
  const { current, can } = useBusiness(); const nav = useNavigate(); const { toast } = useToast(); const base = `/api/businesses/${current!.id}`;
  const customers = useFetch<any>(can("customers.view") ? `${base}/customers${qs({ limit: 100, sort: "name" })}` : null);
  const [q, setQ] = useState(""); const dq = useDebounce(q);
  const found = useFetch<any>(dq.trim() ? `${base}/products${qs({ q: dq, status: "active", limit: 8 })}` : null);
  const [lines, setLines] = useState<Line[]>([]); const [customerId, setCustomerId] = useState(""); const [notes, setNotes] = useState(""); const [address, setAddress] = useState(""); const [otp, setOtp] = useState(true); const [pos, setPos] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const customer = customers.data?.customers.find((c: any) => c.id === customerId);
  const canPrice = can("orders.manage");

  const add = (p: any) => { setLines((l) => (l.some((x) => x.product.id === p.id) ? l : [...l, { product: p, qty: "1", price: String(p.sellingPrice) }])); setQ(""); };
  const est = useMemo(() => lines.reduce((t, l) => t + Number(l.qty || 0) * Number(l.price || 0) * (1 + l.product.taxRate / 100), 0), [lines]);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setError("");
    if (!lines.length) return setError("Add at least one product.");
    if (lines.some((l) => !(Number(l.qty) > 0))) return setError("Every quantity must be more than zero.");
    setBusy(true);
    try {
      const body: any = { items: lines.map((l) => ({ productId: l.product.id, quantity: Number(l.qty), ...(canPrice && Number(l.price) !== l.product.sellingPrice ? { unitPrice: Number(l.price) } : {}) })) };
      if (customerId) { body.customerId = customerId; if (customer?.email) body.requireOtp = otp; }
      if (pos) body.placeOfSupply = pos; if (notes.trim()) body.notes = notes.trim(); if (address.trim()) body.deliveryAddress = address.trim();
      const r = await post<{ order: { id: string } }>(`${base}/orders`, body);
      toast("Order created"); nav(`/app/orders/${r.order.id}`);
    } catch (err) { setError(err instanceof ApiError ? err.message : "Could not create the order"); } finally { setBusy(false); }
  };
  return (
    <div className="stack">
      <PageHeader title="New order" crumbs={[{ to: "/app", label: "Dashboard" }, { to: "/app/orders", label: "Orders" }, { label: "New" }]} />
      <form className="stack" onSubmit={submit} noValidate>
        {error && <div className="banner error" role="alert">{error}</div>}
        <Card title="Products">
          <TextField label="Find a product" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, SKU or barcode" autoComplete="off" />
          {dq.trim() && found.data && (
            <ul className="list" aria-label="Search results">
              {found.data.products.length ? found.data.products.map((p: any) => (
                <li key={p.id}><span>{p.name} <span className="muted small">{p.sku} · {num(p.stockQty)} {p.unit} in stock</span></span><span className="row"><strong>{money(p.sellingPrice)}</strong><Button small onClick={() => add(p)} aria-label={`Add ${p.name}`}>Add</Button></span></li>
              )) : <li className="muted">No matching products</li>}
            </ul>
          )}
          {lines.length > 0 && (
            <div style={{ marginTop: "1rem" }}>
              <DataTable rows={lines.map((l) => ({ ...l, id: l.product.id }))}
                cols={[
                  { key: "p", label: "Product", render: (l: Line) => <>{l.product.name}<br /><span className="muted small">{num(l.product.stockQty)} {l.product.unit} available · tax {l.product.taxRate}%</span></> },
                  { key: "qty", label: "Quantity", render: (l: Line) => <input className="input" style={{ width: 110 }} type="number" inputMode="decimal" step="any" min="0" aria-label={`Quantity for ${l.product.name}`} value={l.qty} onChange={(e) => setLines((all) => all.map((x) => x.product.id === l.product.id ? { ...x, qty: e.target.value } : x))} /> },
                  { key: "price", label: "Unit price", num: true, render: (l: Line) => canPrice ? <input className="input" style={{ width: 120 }} type="number" inputMode="decimal" step="0.01" min="0" aria-label={`Price for ${l.product.name}`} value={l.price} onChange={(e) => setLines((all) => all.map((x) => x.product.id === l.product.id ? { ...x, price: e.target.value } : x))} /> : money(l.price) },
                ]}
                actions={(l: Line) => <Button small variant="ghost" aria-label={`Remove ${l.product.name}`} onClick={() => setLines((all) => all.filter((x) => x.product.id !== l.product.id))}>Remove</Button>} />
              <p className="right"><span className="muted">Estimated total (incl. tax): </span><strong>{money(est)}</strong></p>
            </div>
          )}
        </Card>
        <Card title="Details">
          <div className="form-grid">
            {customers.data && <SelectField label="Customer (optional)" value={customerId} onChange={(e) => setCustomerId(e.target.value)}><option value="">Walk-in customer</option>{customers.data.customers.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</SelectField>}
            <TextField label="Delivery address" value={address} onChange={(e) => setAddress(e.target.value)} />
            <SelectField label="Place of supply (GST)" value={pos} onChange={(e) => setPos(e.target.value)} hint="Leave as default to use the customer's state, otherwise your own. Other states are charged IGST."><option value="">Default</option>{STATES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</SelectField>
          </div>
          {customer?.email && <Check label={`Require a delivery code (emailed to ${customer.email})`} checked={otp} onChange={(e) => setOtp(e.target.checked)} />}
          <TextArea label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Card>
        <div className="actions"><Button type="submit" variant="primary" loading={busy}>Create order</Button><Link className="btn" to="/app/orders">Cancel</Link></div>
      </form>
    </div>
  );
}

const NEXT: Record<string, [string, string][]> = {
  pending: [["accepted", "Accept order"]], accepted: [["processing", "Start processing"]], processing: [["ready", "Mark ready"]],
  ready: [["dispatched", "Dispatch"]], dispatched: [],
};
const CANCELLABLE = ["pending", "accepted", "processing", "ready"];

export function OrderDetail() {
  const { id } = useParams(); const { current, can } = useBusiness(); const { toast } = useToast(); const base = `/api/businesses/${current!.id}/orders/${id}`;
  const { data, error, loading, reload } = useFetch<{ order: any }>(base);
  const [busy, setBusy] = useState(""); const [cancel, setCancel] = useState(false); const [code, setCode] = useState(""); const [codeErr, setCodeErr] = useState(""); const [ret, setRet] = useState(false);
  const o = data?.order; useTitle(o ? o.orderNumber : "Order");
  if (error) return <ErrorState error={error} retry={reload} />;
  if (loading && !o) return <Spinner />;
  if (!o) return null;
  const manage = can("orders.manage");
  const run = async (key: string, fn: () => Promise<any>, ok: string) => {
    setBusy(key);
    try { await fn(); toast(ok); reload(); } catch (e) { toast(e instanceof ApiError ? e.message : "Something went wrong", "error"); reload(); } finally { setBusy(""); }
  };
  const move = (status: string, ok: string) => run(status, () => patch(`${base}/status`, { status }), ok);
  const verify = async (e: FormEvent) => {
    e.preventDefault(); setCodeErr(""); setBusy("otp");
    try { await post(`${base}/otp/verify`, { otp: code }); toast("Delivery confirmed"); setCode(""); reload(); }
    catch (err) { setCodeErr(err instanceof ApiError ? err.message : "Could not verify the code"); } finally { setBusy(""); }
  };
  const noOtpDelivery = !o.requiresOtp && ["ready", "dispatched"].includes(o.status);
  return (
    <div className="stack">
      <PageHeader title={o.orderNumber} crumbs={[{ to: "/app", label: "Dashboard" }, { to: "/app/orders", label: "Orders" }, { label: o.orderNumber }]}><>{o.invoice && <Link className="btn" to={`/app/invoices/${o.invoice.id}`}>Invoice {o.invoice.number}</Link>} <Badge tone={statusTone(o.status)}>{label(o.status)}</Badge></></PageHeader>

      {manage && (NEXT[o.status]?.length || CANCELLABLE.includes(o.status) || noOtpDelivery) ? (
        <Card title="Next step">
          <div className="actions">
            {NEXT[o.status]?.map(([s, l]) => <Button key={s} variant="primary" loading={busy === s} onClick={() => move(s, `Order ${s}`)}>{l}</Button>)}
            {noOtpDelivery && <Button variant="primary" loading={busy === "delivered"} onClick={() => move("delivered", "Order delivered")}>Mark delivered</Button>}
            {CANCELLABLE.includes(o.status) && <Button variant="danger" onClick={() => setCancel(true)}>Cancel order</Button>}
          </div>
          {o.status === "pending" && <p className="muted small" style={{ marginTop: ".75rem" }}>Accepting reserves the stock. It fails if any item is short.</p>}
        </Card>
      ) : null}

      {manage && o.requiresOtp && ["ready", "dispatched"].includes(o.status) && (
        <Card title="Confirm delivery">
          <p>Ask the buyer for their 6-digit delivery code and enter it to complete this order.</p>
          <form className="row" onSubmit={verify} style={{ alignItems: "flex-end" }} noValidate>
            <div className="grow"><TextField label="Delivery code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} error={codeErr} /></div>
            <Button type="submit" variant="primary" loading={busy === "otp"} disabled={code.length !== 6}>Verify</Button>
          </form>
          <p style={{ marginTop: ".75rem" }}><Button small onClick={() => run("regen", () => post(`${base}/otp/regenerate`), "A new code was sent to the buyer")} loading={busy === "regen"}>Send a new code</Button></p>
        </Card>
      )}

      <div className="grid cols-2">
        <Card title="Summary">
          <ul className="list">
            <li><span className="muted">{o.buyerType ? "Buyer" : "Customer"}</span><span>{o.customerId ? <Link to={`/app/customers/${o.customerId}`}>{o.customerName}</Link> : o.buyerName ?? "Walk-in"}{o.buyerType === "individual" && <> <Badge>Individual</Badge></>}</span></li>
            {o.buyerPhone && <li><span className="muted">Buyer phone</span><a href={`tel:${o.buyerPhone.replace(/[^\d+]/g, "")}`}>{o.buyerPhone}</a></li>}
            <li><span className="muted">Created</span><span>{dateTime(o.createdAt)}</span></li>
            {o.deliveredAt && <li><span className="muted">Delivered</span><span>{dateTime(o.deliveredAt)}</span></li>}
            {o.deliveryAddress && <li><span className="muted">Address</span><span>{o.deliveryAddress}</span></li>}
            {o.notes && <li><span className="muted">Notes</span><span>{o.notes}</span></li>}
            <li><span className="muted">Delivery code</span><span>{o.requiresOtp ? "Required" : "Not required"}</span></li>
            <li><span className="muted">Subtotal</span><span>{money(o.subtotal)}</span></li>
            <li><span className="muted">Tax</span><span>{money(o.taxTotal)}</span></li>
            <li><strong>Total</strong><strong>{money(o.total)}</strong></li>
          </ul>
        </Card>
        <Card title="History">
          <ul className="list">{o.history.map((h: any, i: number) => (
            <li key={i}><span>{label(h.action.replace("order.", "").replace(/_/g, " "))}{h.metadata?.to && <> → <strong>{label(h.metadata.to)}</strong></>}<br /><span className="muted small">{h.actorName ?? "System"}</span></span><span className="muted small">{dateTime(h.createdAt)}</span></li>
          ))}</ul>
        </Card>
      </div>

      <Card title="Items">
        <DataTable rows={o.items} cols={[
          { key: "name", label: "Product", render: (i: any) => <>{i.name}<br /><span className="muted small">{i.sku}</span></> },
          { key: "quantity", label: "Qty", num: true, render: (i: any) => <>{num(i.quantity)}{i.returnedQty > 0 && <span className="muted small"> ({num(i.returnedQty)} returned)</span>}</> },
          { key: "unitPrice", label: "Unit price", num: true, render: (i: any) => money(i.unitPrice) },
          { key: "lineTotal", label: "Total", num: true, render: (i: any) => money(i.lineTotal) },
        ]} />
        {manage && o.status === "delivered" && <div className="actions" style={{ marginTop: "1rem" }}><Button onClick={() => setRet(true)}>Record a return</Button></div>}
      </Card>

      {o.returns.length > 0 && <Card title="Returns"><ul className="list">{o.returns.map((r: any) => <li key={r.id}><span>{r.reason ?? "Return"}<br /><span className="muted small">{r.items.length} item line(s)</span></span><strong>Refund {money(r.refundTotal)}</strong></li>)}</ul></Card>}

      <ConfirmDialog open={cancel} danger title="Cancel this order?" confirmLabel="Cancel order" message={o.status === "pending" ? "The order will be cancelled." : "The order will be cancelled and reserved stock returned to inventory."}
        onClose={() => setCancel(false)} onConfirm={async () => { setCancel(false); await move("cancelled", "Order cancelled"); }} />
      {ret && <ReturnModal order={o} base={base} onClose={() => setRet(false)} onDone={reload} />}
    </div>
  );
}

function ReturnModal({ order, base, onClose, onDone }: { order: any; base: string; onClose: () => void; onDone: () => void }) {
  const { toast } = useToast();
  const [qty, setQty] = useState<Record<string, string>>({}); const [cond, setCond] = useState<Record<string, string>>({}); const [reason, setReason] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setError("");
    const items = order.items.filter((i: any) => Number(qty[i.id]) > 0).map((i: any) => ({ orderItemId: i.id, quantity: Number(qty[i.id]), condition: cond[i.id] ?? "resellable" }));
    if (!items.length) return setError("Enter a quantity for at least one item.");
    setBusy(true);
    try { await post(`${base}/returns`, { items, ...(reason.trim() ? { reason: reason.trim() } : {}) }); toast("Return recorded"); onDone(); onClose(); }
    catch (err) { setError(err instanceof ApiError ? err.message : "Could not record the return"); } finally { setBusy(false); }
  };
  return (
    <Modal open title="Record a return" onClose={onClose}>
      <form className="stack" onSubmit={submit} noValidate>
        {error && <div className="banner error" role="alert">{error}</div>}
        {order.items.map((i: any) => (
          <div key={i.id} className="form-grid">
            <TextField label={`${i.name} (max ${num(i.quantity - i.returnedQty)})`} type="number" inputMode="decimal" step="any" min="0" max={i.quantity - i.returnedQty} value={qty[i.id] ?? ""} onChange={(e) => setQty((s) => ({ ...s, [i.id]: e.target.value }))} disabled={i.quantity - i.returnedQty <= 0} />
            <SelectField label="Condition" value={cond[i.id] ?? "resellable"} onChange={(e) => setCond((s) => ({ ...s, [i.id]: e.target.value }))}><option value="resellable">Resellable (back to stock)</option><option value="damaged">Damaged (not restocked)</option></SelectField>
          </div>
        ))}
        <TextArea label="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
        <div className="actions"><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" loading={busy}>Record return</Button></div>
      </form>
    </Modal>
  );
}
