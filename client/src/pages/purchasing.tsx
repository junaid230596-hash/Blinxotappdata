import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { FormModal, ListPage } from "../components/forms";
import { ReviewModal } from "../components/ReviewModal";
import { Badge, Button, Card, ConfirmDialog, DataTable, Empty, ErrorState, Modal, PageHeader, Pagination, SelectField, Spinner, statusTone, TextArea, TextField } from "../components/ui";
import { ApiError, get, patch, post, qs } from "../lib/api";
import { useBusiness } from "../lib/business";
import { date, label, money, num } from "../lib/format";
import { useDebounce, useFetch, useTitle } from "../lib/hooks";
import { useToast } from "../lib/toast";

const problem = (e: unknown, fb = "Something went wrong. Please try again.") => (e instanceof ApiError ? e.message : fb);

export function Suppliers() {
  useTitle("Suppliers"); const { current, can } = useBusiness(); const base = `/api/businesses/${current!.id}`; const { toast } = useToast();
  const [edit, setEdit] = useState<{ row: any | null } | null>(null); const manage = can("purchases.manage");
  const fields = [
    { key: "name", label: "Supplier name", required: true }, { key: "contactName", label: "Contact person" }, { key: "email", label: "Email", type: "email" as const }, { key: "phone", label: "Phone", type: "tel" as const },
    { key: "address", label: "Address" }, { key: "notes", label: "Notes", type: "textarea" as const },
    ...(edit?.row ? [{ key: "status", label: "Status", type: "select" as const, options: [["active", "Active"], ["inactive", "Inactive"]] as [string, string][] }] : []),
  ];
  return (
    <>
      <ListPage title="Suppliers" crumbs={[{ to: "/app", label: "Dashboard" }, { label: "Suppliers" }]} endpoint={`${base}/suppliers`} listKey="suppliers" search="Search suppliers" filters={[{ key: "status", label: "Status", initial: "active", options: [["active", "Active"], ["inactive", "Inactive"], ["", "All"]] }]}
        headerActions={() => manage && <><Link className="btn" to="/app/marketplace">Find on marketplace</Link><Button variant="primary" onClick={() => setEdit({ row: null })}>Add supplier</Button></>}
        empty={<Empty title="No suppliers yet" action={manage ? <Link className="btn btn-primary" to="/app/marketplace">Find suppliers on Blinxot</Link> : undefined}>Add the businesses you buy from, or discover new ones on the marketplace.</Empty>}
        cols={[
          { key: "name", label: "Supplier", render: (s: any) => <><strong>{s.name}</strong> <span className="muted small">{s.code}</span>{s.linkedBusinessId && <> <Badge tone="brand">On Blinxot</Badge></>}</> },
          { key: "contact", label: "Contact", render: (s: any) => s.contactName ?? s.email ?? s.phone ?? "—" }, { key: "status", label: "Status", render: (s: any) => <Badge tone={statusTone(s.status)}>{label(s.status)}</Badge> },
        ]}
        actions={manage ? (s: any) => <>{<Link className="btn btn-sm" to={`/app/purchases/new?supplier=${s.id}`}>New purchase</Link>}<Button small onClick={() => setEdit({ row: s })}>Edit</Button></> : undefined}>
        {(reload) => edit && <FormModal title={edit.row ? `Edit ${edit.row.name}` : "Add supplier"} fields={fields} initial={edit.row ?? {}} onClose={() => setEdit(null)}
          onSubmit={async (b) => { edit.row ? await patch(`${base}/suppliers/${edit.row.id}`, b) : await post(`${base}/suppliers`, b); toast("Supplier saved"); reload(); }} />}
      </ListPage>
    </>
  );
}

export function Purchases() {
  useTitle("Purchases"); const { current, can } = useBusiness(); const base = `/api/businesses/${current!.id}`;
  return (
    <ListPage title="Purchases" crumbs={[{ to: "/app", label: "Dashboard" }, { label: "Purchases" }]} endpoint={`${base}/purchases`} listKey="purchases" search="Search PO number"
      filters={[{ key: "status", label: "Status", options: [["", "All statuses"], ...["draft", "sent", "accepted", "partially_received", "received", "cancelled"].map((s) => [s, label(s)] as [string, string])] }]}
      headerActions={() => can("purchases.manage") && <Link className="btn btn-primary" to="/app/purchases/new">New purchase</Link>}
      empty={<Empty title="No purchases yet">Create a purchase order to restock from a supplier.</Empty>}
      cols={[
        { key: "poNumber", label: "PO", render: (p: any) => <Link to={`/app/purchases/${p.id}`}><strong>{p.poNumber}</strong></Link> }, { key: "createdAt", label: "Created", render: (p: any) => date(p.createdAt) },
        { key: "supplierName", label: "Supplier" }, { key: "status", label: "Status", render: (p: any) => <Badge tone={statusTone(p.status)}>{label(p.status)}</Badge> },
        { key: "order", label: "Supplier's order", render: (p: any) => (p.order ? <Badge tone={statusTone(p.order.status)}>{label(p.order.status)}</Badge> : "—") }, { key: "total", label: "Total", num: true, render: (p: any) => money(p.total) },
      ]} />
  );
}

interface Line { key: string; name: string; supplierProductId?: string; productId?: string; quantity: string; unitCost: string; fixed: boolean; note?: string }

export function NewPurchase() {
  useTitle("New purchase"); const { current } = useBusiness(); const base = `/api/businesses/${current!.id}`; const nav = useNavigate(); const { toast } = useToast(); const [params] = useSearchParams();
  const suppliers = useFetch<any>(`${base}/suppliers${qs({ status: "active", limit: 100 })}`);
  const [supplierId, setSupplierId] = useState(params.get("supplier") ?? ""); const supplier = suppliers.data?.suppliers.find((s: any) => s.id === supplierId);
  const [q, setQ] = useState(""); const dq = useDebounce(q);
  const theirs = useFetch<any>(supplier?.linkedBusinessId ? `${base}/suppliers/${supplierId}/products${qs({ q: dq })}` : null);
  const mine = useFetch<any>(supplier && !supplier.linkedBusinessId && dq.trim() ? `${base}/products${qs({ q: dq, status: "active", limit: 8 })}` : null);
  const [lines, setLines] = useState<Line[]>([]); const [notes, setNotes] = useState(""); const [expected, setExpected] = useState(""); const [free, setFree] = useState({ name: "", cost: "" });
  const [busy, setBusy] = useState(""); const [error, setError] = useState(""); const prefilled = params.get("product");

  useEffect(() => { setLines([]); }, [supplierId]);
  useEffect(() => {                                                    // arriving from the marketplace with a product already chosen
    if (!prefilled || !theirs.data || lines.length) return;
    const p = theirs.data.products.find((x: any) => x.id === prefilled);
    if (p) addTheirs(p);                                                // eslint-disable-next-line
  }, [theirs.data, prefilled]);

  const addTheirs = (p: any) => setLines((l) => (l.some((x) => x.supplierProductId === p.id) ? l : [...l, { key: p.id, name: p.name, supplierProductId: p.id, quantity: "1", unitCost: String(p.price), fixed: true, note: `${money(p.price)} + ${p.taxRate}% tax · ${p.inStock ? "in stock" : "out of stock"}` }]));
  const addMine = (p: any) => { setLines((l) => (l.some((x) => x.productId === p.id) ? l : [...l, { key: p.id, name: p.name, productId: p.id, quantity: "1", unitCost: String(p.costPrice ?? 0), fixed: false }])); setQ(""); };
  const addFree = () => { if (!free.name.trim()) return; setLines((l) => [...l, { key: `free-${Date.now()}`, name: free.name.trim(), quantity: "1", unitCost: free.cost || "0", fixed: false }]); setFree({ name: "", cost: "" }); };
  const total = lines.reduce((t, l) => t + Number(l.quantity || 0) * Number(l.unitCost || 0), 0);
  const upd = (key: string, patchv: Partial<Line>) => setLines((all) => all.map((x) => (x.key === key ? { ...x, ...patchv } : x)));

  const save = async (send: boolean) => {
    setError("");
    if (!supplierId) return setError("Choose a supplier."); if (!lines.length) return setError("Add at least one item.");
    if (lines.some((l) => !(Number(l.quantity) > 0))) return setError("Every quantity must be more than zero.");
    setBusy(send ? "send" : "draft");
    try {
      const body = { supplierId, ...(notes.trim() ? { notes: notes.trim() } : {}), ...(expected ? { expectedDate: expected } : {}),
        items: lines.map((l) => ({ quantity: Number(l.quantity), ...(l.supplierProductId ? { supplierProductId: l.supplierProductId } : { name: l.name, unitCost: Number(l.unitCost) }), ...(l.productId ? { productId: l.productId } : {}) })) };
      const r = await post<{ purchase: any }>(`${base}/purchases`, body);
      if (send) await post(`${base}/purchases/${r.purchase.id}/send`);
      toast(send ? "Purchase order sent" : "Draft saved"); nav(`/app/purchases/${r.purchase.id}`);
    } catch (e) { setError(problem(e)); } finally { setBusy(""); }
  };
  return (
    <div className="stack">
      <PageHeader title="New purchase" crumbs={[{ to: "/app", label: "Dashboard" }, { to: "/app/purchases", label: "Purchases" }, { label: "New" }]} />
      {error && <div className="banner error" role="alert">{error}</div>}
      <Card title="Supplier">
        {suppliers.loading && !suppliers.data ? <Spinner /> : !suppliers.data?.suppliers.length ? <Empty title="You have no suppliers yet" action={<Link className="btn btn-primary" to="/app/marketplace">Find suppliers</Link>}>Add a supplier first, or discover one on the marketplace.</Empty> : (
          <SelectField label="Buying from" value={supplierId} onChange={(e) => { if (e.target.value !== supplierId && lines.length) { setLines([]); toast("Items cleared: each purchase order is placed with one supplier"); } setSupplierId(e.target.value); }}><option value="">Choose a supplier…</option>{suppliers.data.suppliers.map((s: any) => <option key={s.id} value={s.id}>{s.name}{s.linkedBusinessId ? " (on Blinxot)" : ""}</option>)}</SelectField>
        )}
        {supplier?.linkedBusinessId && <p className="muted small">This supplier is on Blinxot. Your order goes straight to them at their listed prices, and you'll get a delivery code to confirm receipt.</p>}
      </Card>
      {supplier && (
        <Card title="Items">
          {supplier.linkedBusinessId ? (<>
            <TextField label="Search their products" type="search" value={q} onChange={(e) => setQ(e.target.value)} />
            {theirs.data && <ul className="list" aria-label="Supplier products">{theirs.data.products.length ? theirs.data.products.map((p: any) => (
              <li key={p.id}><span>{p.name} <span className="muted small">{p.sku} · {p.inStock ? "in stock" : "out of stock"}</span></span><span className="row"><strong>{money(p.price)}</strong><Button small aria-label={`Add ${p.name}`} onClick={() => addTheirs(p)}>Add</Button></span></li>
            )) : <li className="muted">This supplier has no listed products{dq ? " matching your search" : ""}.</li>}</ul>}
          </>) : (<>
            <TextField label="Find one of your products" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, SKU or barcode" />
            {dq.trim() && mine.data && <ul className="list" aria-label="Your products">{mine.data.products.length ? mine.data.products.map((p: any) => <li key={p.id}><span>{p.name} <span className="muted small">{p.sku}</span></span><Button small aria-label={`Add ${p.name}`} onClick={() => addMine(p)}>Add</Button></li>) : <li className="muted">No matching products</li>}</ul>}
            <div className="row" style={{ alignItems: "flex-end", marginTop: ".5rem" }}><div className="grow"><TextField label="Or add another item" value={free.name} onChange={(e) => setFree((s) => ({ ...s, name: e.target.value }))} /></div>
              <div style={{ width: 130 }}><TextField label="Unit cost (₹)" type="number" inputMode="decimal" min="0" value={free.cost} onChange={(e) => setFree((s) => ({ ...s, cost: e.target.value }))} /></div><Button onClick={addFree} disabled={!free.name.trim()}>Add item</Button></div>
          </>)}
          {lines.length > 0 && (
            <div style={{ marginTop: "1rem" }}>
              <DataTable rows={lines.map((l) => ({ ...l, id: l.key }))} cols={[
                { key: "name", label: "Item", render: (l: Line) => <>{l.name}{l.note && <><br /><span className="muted small">{l.note}</span></>}</> },
                { key: "quantity", label: "Quantity", render: (l: Line) => <input className="input" style={{ width: 110 }} type="number" inputMode="decimal" min="0" step="any" aria-label={`Quantity for ${l.name}`} value={l.quantity} onChange={(e) => upd(l.key, { quantity: e.target.value })} /> },
                { key: "unitCost", label: "Unit cost", num: true, render: (l: Line) => l.fixed ? money(l.unitCost) : <input className="input" style={{ width: 120 }} type="number" inputMode="decimal" min="0" step="0.01" aria-label={`Unit cost for ${l.name}`} value={l.unitCost} onChange={(e) => upd(l.key, { unitCost: e.target.value })} /> },
              ]} actions={(l: Line) => <Button small variant="ghost" aria-label={`Remove ${l.name}`} onClick={() => setLines((all) => all.filter((x) => x.key !== l.key))}>Remove</Button>} />
              <p className="right"><span className="muted">Estimated total{supplier.linkedBusinessId ? " (before tax)" : ""}: </span><strong>{money(total)}</strong></p>
            </div>
          )}
        </Card>
      )}
      {supplier && <Card title="Details"><div className="form-grid"><TextField label="Expected delivery" type="date" value={expected} onChange={(e) => setExpected(e.target.value)} /></div><TextArea label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} /></Card>}
      <div className="actions"><Button variant="primary" loading={busy === "send"} disabled={!supplier} onClick={() => save(true)}>Save and send</Button><Button loading={busy === "draft"} disabled={!supplier} onClick={() => save(false)}>Save as draft</Button><Link className="btn" to="/app/purchases">Cancel</Link></div>
    </div>
  );
}

export function PurchaseDetail() {
  const { id } = useParams(); const { current, can } = useBusiness(); const { toast } = useToast(); const base = `/api/businesses/${current!.id}`;
  const { data, error, loading, reload } = useFetch<{ purchase: any }>(`${base}/purchases/${id}`);
  const [busy, setBusy] = useState(""); const [cancel, setCancel] = useState(false); const [recv, setRecv] = useState(false); const [review, setReview] = useState(false);
  const p = data?.purchase; useTitle(p?.poNumber ?? "Purchase");
  if (error) return <ErrorState error={error} retry={reload} />;
  if (loading && !p) return <Spinner />;
  if (!p) return null;
  const manage = can("purchases.manage"); const open = p.items.some((i: any) => i.remainingQty > 0);
  const run = async (key: string, path: string, ok: string) => { setBusy(key); try { await post(`${base}/purchases/${id}/${path}`); toast(ok); reload(); } catch (e) { toast(problem(e), "error"); reload(); } finally { setBusy(""); } };
  const canReceive = ["accepted", "partially_received"].includes(p.status) && open && (!p.order || p.order.status === "delivered");
  return (
    <div className="stack">
      <PageHeader title={p.poNumber} crumbs={[{ to: "/app", label: "Dashboard" }, { to: "/app/purchases", label: "Purchases" }, { label: p.poNumber }]}><Badge tone={statusTone(p.status)}>{label(p.status)}</Badge></PageHeader>
      {manage && (
        <Card title="Next step"><div className="actions">
          {p.status === "draft" && <Button variant="primary" loading={busy === "send"} onClick={() => run("send", "send", "Purchase order sent")}>Send to supplier</Button>}
          {p.status === "sent" && !p.linkedSupplier && <Button variant="primary" loading={busy === "accept"} onClick={() => run("accept", "accept", "Marked as accepted")}>Mark accepted by supplier</Button>}
          {canReceive && <Button variant="primary" onClick={() => setRecv(true)}>Receive stock</Button>}
          {["draft", "sent", "accepted"].includes(p.status) && <Button variant="danger" onClick={() => setCancel(true)}>Cancel purchase</Button>}
          {p.linkedSupplier && p.status === "received" && p.supplierBusinessId && <Button onClick={() => setReview(true)}>Review supplier</Button>}
        </div>
        {p.order && p.status !== "received" && p.status !== "cancelled" && <p className="muted small" style={{ marginTop: ".75rem" }}>{p.order.status === "pending" ? "Waiting for the supplier to accept." : p.order.status === "dispatched" || p.order.status === "ready" ? <>The supplier is delivering. Give them the 6-digit delivery code from your <Link to="/app/notifications">notifications</Link> when it arrives.</> : p.order.status === "delivered" ? "Delivered. Receive the stock when you've checked it." : `Supplier's order is ${label(p.order.status)}.`}</p>}
        {p.linkedSupplier && p.status === "sent" && !p.order && null}
        </Card>
      )}
      <div className="grid cols-2">
        <Card title="Summary"><ul className="list">
          <li><span className="muted">Supplier</span><span>{p.supplierName}{p.linkedSupplier && <> <Badge tone="brand">On Blinxot</Badge></>}</span></li>
          <li><span className="muted">Created</span><span>{date(p.createdAt)}</span></li>{p.sentAt && <li><span className="muted">Sent</span><span>{date(p.sentAt)}</span></li>}
          {p.expectedDate && <li><span className="muted">Expected</span><span>{date(p.expectedDate)}</span></li>}
          {p.order && <li><span className="muted">Supplier's order</span><span>{p.order.orderNumber} <Badge tone={statusTone(p.order.status)}>{label(p.order.status)}</Badge></span></li>}
          {p.notes && <li><span className="muted">Notes</span><span>{p.notes}</span></li>}
          <li><strong>Total{p.linkedSupplier ? " (incl. tax)" : ""}</strong><strong>{money(p.total)}</strong></li></ul></Card>
      </div>
      <Card title="Items"><DataTable rows={p.items} cols={[
        { key: "name", label: "Item", render: (i: any) => <>{i.name}{i.sku && <><br /><span className="muted small">{i.sku}</span></>}</> }, { key: "quantity", label: "Ordered", num: true, render: (i: any) => num(i.quantity) },
        { key: "receivedQty", label: "Received", num: true, render: (i: any) => num(i.receivedQty) }, { key: "unitCost", label: "Unit cost", num: true, render: (i: any) => money(i.unitCost) },
      ]} /></Card>
      <ConfirmDialog open={cancel} danger title="Cancel this purchase?" confirmLabel="Cancel purchase" message="The supplier will no longer fulfil it." onClose={() => setCancel(false)} onConfirm={async () => { setCancel(false); await run("cancel", "cancel", "Purchase cancelled"); }} />
      {recv && <ReceiveModal purchase={p} base={base} onClose={() => setRecv(false)} onDone={reload} />}
      {review && <ReviewModal subjectType="business" subjectId={p.supplierBusinessId} subjectName={p.supplierName} onClose={() => setReview(false)} />}
    </div>
  );
}

function ReceiveModal({ purchase, base, onClose, onDone }: { purchase: any; base: string; onClose: () => void; onDone: () => void }) {
  const { toast } = useToast(); const items = purchase.items.filter((i: any) => i.remainingQty > 0);
  const [qty, setQty] = useState<Record<string, string>>(() => Object.fromEntries(items.map((i: any) => [i.id, String(i.remainingQty)]))); const [map, setMap] = useState<Record<string, string>>({});
  const needsMap = items.some((i: any) => !i.productId); const prods = useFetch<any>(needsMap ? `${base}/products${qs({ status: "active", limit: 100, sort: "name" })}` : null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setError("");
    const lines = items.filter((i: any) => Number(qty[i.id]) > 0).map((i: any) => ({ itemId: i.id, quantity: Number(qty[i.id]), ...(!i.productId ? { productId: map[i.id] } : {}) }));
    if (!lines.length) return setError("Enter a quantity for at least one item.");
    if (lines.some((l: any) => "productId" in l && !l.productId)) return setError("Choose which of your products each new item should be added to.");
    setBusy(true);
    try { await post(`${base}/purchases/${purchase.id}/receive`, { items: lines }); toast("Stock received"); onDone(); onClose(); } catch (err) { setError(problem(err)); } finally { setBusy(false); }
  };
  return (
    <Modal open title="Receive stock" onClose={onClose}>
      <form className="stack" onSubmit={submit} noValidate>
        {error && <div className="banner error" role="alert">{error}</div>}
        <p className="muted small">Enter what actually arrived. Your inventory and average cost update straight away.</p>
        {items.map((i: any) => (
          <div key={i.id} className="form-grid">
            <TextField label={`${i.name} (max ${num(i.remainingQty)})`} type="number" inputMode="decimal" step="any" min="0" max={i.remainingQty} value={qty[i.id]} onChange={(e) => setQty((s) => ({ ...s, [i.id]: e.target.value }))} />
            {!i.productId && <SelectField label="Add to your product" value={map[i.id] ?? ""} onChange={(e) => setMap((s) => ({ ...s, [i.id]: e.target.value }))}><option value="">Choose…</option>{prods.data?.products.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</SelectField>}
          </div>
        ))}
        <div className="actions"><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" loading={busy}>Receive</Button></div>
      </form>
    </Modal>
  );
}

export function Marketplace() {
  useTitle("Marketplace"); const { current } = useBusiness(); const nav = useNavigate(); const { toast } = useToast(); const base = `/api/businesses/${current!.id}`;
  const [tab, setTab] = useState<"products" | "businesses">("products"); const [q, setQ] = useState(""); const dq = useDebounce(q); const [category, setCategory] = useState(""); const dc = useDebounce(category);
  const [min, setMin] = useState(""); const [max, setMax] = useState(""); const [bizFilter, setBizFilter] = useState<{ id: string; name: string } | null>(null); const [offset, setOffset] = useState(0); const [busy, setBusy] = useState("");
  const path = tab === "products" ? `/api/public/marketplace/products${qs({ q: dq, category: dc, minPrice: min, maxPrice: max, businessId: bizFilter?.id, limit: 12, offset })}` : `/api/public/marketplace/businesses${qs({ q: dq, category: dc, limit: 12, offset })}`;
  const { data, error, loading, reload } = useFetch<any>(path);
  const reset = (fn: (v: string) => void) => (e: { target: { value: string } }) => { fn(e.target.value); setOffset(0); };

  const orderFrom = async (businessId: string, name: string, productId?: string) => {
    setBusy(businessId + (productId ?? ""));
    try {
      const list = await get<any>(`${base}/suppliers${qs({ limit: 100, status: "" })}`); let sup = list.suppliers.find((s: any) => s.linkedBusinessId === businessId);
      if (!sup) sup = (await post<any>(`${base}/suppliers`, { name, linkedBusinessId: businessId })).supplier;
      else if (sup.status === "inactive") await patch(`${base}/suppliers/${sup.id}`, { status: "active" });
      nav(`/app/purchases/new?supplier=${sup.id}${productId ? `&product=${productId}` : ""}`);
    } catch (e) { toast(problem(e), "error"); } finally { setBusy(""); }
  };
  const items = (tab === "products" ? data?.products : data?.businesses)?.filter((x: any) => (tab === "products" ? x.business.id : x.id) !== current!.id) ?? [];
  return (
    <div className="stack">
      <PageHeader title="Marketplace" crumbs={[{ to: "/app", label: "Dashboard" }, { label: "Marketplace" }]} />
      <div className="tabs" role="group" aria-label="Browse"><Button aria-pressed={tab === "products"} onClick={() => { setTab("products"); setOffset(0); }}>Products</Button><Button aria-pressed={tab === "businesses"} onClick={() => { setTab("businesses"); setOffset(0); setBizFilter(null); }}>Businesses</Button></div>
      <div className="filters">
        <TextField label="Search" type="search" value={q} onChange={reset(setQ)} placeholder={tab === "products" ? "Product name" : "Business name"} />
        <TextField label="Category" value={category} onChange={reset(setCategory)} />
        {tab === "products" && <><TextField label="Min price (₹)" type="number" inputMode="decimal" min="0" value={min} onChange={reset(setMin)} /><TextField label="Max price (₹)" type="number" inputMode="decimal" min="0" value={max} onChange={reset(setMax)} /></>}
      </div>
      {bizFilter && <div className="banner ok"><span>Showing products from <strong>{bizFilter.name}</strong></span><Button small onClick={() => { setBizFilter(null); setOffset(0); }}>Show all</Button></div>}
      {error ? <ErrorState error={error} retry={reload} /> : loading && !data ? <Spinner /> : !items.length ? <Card><Empty title="Nothing found">Try a different search. Businesses appear here when they list products for other businesses to order.</Empty></Card> : (
        <div className="grid cols-3">
          {tab === "products" ? items.map((p: any) => (
            <Card key={p.id}>
              <h2 style={{ margin: 0 }}>{p.name}</h2><p className="muted small" style={{ margin: ".15rem 0" }}>{p.business.name}{p.categoryName ? ` · ${p.categoryName}` : ""}</p>
              <p style={{ margin: ".5rem 0" }}><strong style={{ fontSize: "1.2rem" }}>{money(p.price)}</strong> <span className="muted small">/ {p.unit}{p.taxRate ? ` + ${p.taxRate}% tax` : ""}</span></p>
              <p className="row">{p.inStock ? <Badge tone="ok">In stock</Badge> : <Badge tone="warn">Out of stock</Badge>}</p>
              {p.description && <p className="small muted">{p.description.slice(0, 120)}</p>}
              <div className="actions"><Button variant="primary" loading={busy === p.business.id + p.id} onClick={() => orderFrom(p.business.id, p.business.name, p.id)} aria-label={`Order ${p.name}`}>Order</Button><Button small onClick={() => { setBizFilter({ id: p.business.id, name: p.business.name }); setOffset(0); }}>More from them</Button></div>
            </Card>
          )) : items.map((b: any) => (
            <Card key={b.id}>
              <h2 style={{ margin: 0 }}>{b.name}</h2><p className="muted small">{b.category ?? "Business"} · {b.listedProducts} listed product{b.listedProducts === 1 ? "" : "s"}</p>
              {b.description && <p className="small">{b.description.slice(0, 140)}</p>}
              <div className="actions"><Button small onClick={() => { setBizFilter({ id: b.id, name: b.name }); setTab("products"); setOffset(0); }}>View products</Button><Button small loading={busy === b.id} onClick={() => orderFrom(b.id, b.name)}>Add as supplier</Button></div>
            </Card>
          ))}
        </div>
      )}
      {data && <Pagination total={data.total} limit={12} offset={offset} onChange={setOffset} />}
    </div>
  );
}

export function Returns() {
  useTitle("Returns"); const { current } = useBusiness();
  return <ListPage title="Returns" crumbs={[{ to: "/app", label: "Dashboard" }, { label: "Returns" }]} endpoint={`/api/businesses/${current!.id}/returns`} listKey="returns" search={false}
    empty={<Empty title="No returns recorded">Returns you record on delivered orders are listed here.</Empty>}
    cols={[{ key: "orderNumber", label: "Order", render: (r: any) => <Link to={`/app/orders/${r.orderId}`}>{r.orderNumber}</Link> }, { key: "reason", label: "Reason", render: (r: any) => r.reason ?? "—" }, { key: "createdAt", label: "Date", render: (r: any) => date(r.createdAt) }, { key: "refundTotal", label: "Refund", num: true, render: (r: any) => money(r.refundTotal) }]} />;
}
