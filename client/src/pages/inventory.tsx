import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { ApiError, post, qs } from "../lib/api";
import { useBusiness } from "../lib/business";
import { dateTime, label, money, num } from "../lib/format";
import { useDebounce, useFetch, useTitle } from "../lib/hooks";
import { useToast } from "../lib/toast";
import { Badge, Button, Card, Check, DataTable, Empty, ErrorState, Modal, PageHeader, Pagination, SelectField, Spinner, Stat, TextArea, TextField } from "../components/ui";

export type StockMode = "in" | "out" | "adjust" | "damaged";
const TITLES: Record<StockMode, string> = { in: "Add stock", out: "Remove stock", adjust: "Set counted quantity", damaged: "Write off damaged stock" };

/** One dialog for every stock change. The server is the source of truth: it rejects anything that would make stock negative. */
export function StockModal({ product, mode, onClose, onDone }: { product: any | null; mode: StockMode; onClose: () => void; onDone: () => void }) {
  const { current } = useBusiness(); const { toast } = useToast();
  const [qty, setQty] = useState(""); const [cost, setCost] = useState(""); const [note, setNote] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  if (!product || !current) return null;
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setError("");
    const n = Number(qty);
    if (!qty || Number.isNaN(n) || n < 0 || (mode !== "adjust" && n <= 0)) return setError("Enter a valid quantity.");
    if (mode === "adjust" && note.trim().length < 3) return setError("Please give a reason for the adjustment.");
    setBusy(true);
    try {
      const base = `/api/businesses/${current.id}/inventory`;
      if (mode === "in") await post(`${base}/stock-in`, { productId: product.id, quantity: n, ...(cost ? { unitCost: Number(cost) } : {}), ...(note ? { note } : {}) });
      if (mode === "out") await post(`${base}/stock-out`, { productId: product.id, quantity: n, ...(note ? { note } : {}) });
      if (mode === "damaged") await post(`${base}/damaged`, { productId: product.id, quantity: n, ...(note ? { note } : {}) });
      if (mode === "adjust") await post(`${base}/adjust`, { productId: product.id, newQuantity: n, reason: note.trim() });
      toast("Stock updated"); onDone(); onClose();
    } catch (err) { setError(err instanceof ApiError ? err.message : "Could not update stock"); } finally { setBusy(false); }
  };
  return (
    <Modal open title={`${TITLES[mode]}: ${product.name}`} onClose={onClose}>
      <form className="stack" onSubmit={submit} noValidate>
        <p className="muted small">Currently <strong>{num(product.stockQty)} {product.unit}</strong> in stock.</p>
        {error && <div className="banner error" role="alert">{error}</div>}
        <TextField label={mode === "adjust" ? "Counted quantity" : "Quantity"} type="number" inputMode="decimal" step="any" min="0" value={qty} onChange={(e) => setQty(e.target.value)} required autoFocus />
        {mode === "in" && <TextField label="Unit cost (optional)" type="number" inputMode="decimal" step="0.01" min="0" value={cost} onChange={(e) => setCost(e.target.value)} hint="Updates the average cost." />}
        <TextArea label={mode === "adjust" ? "Reason" : "Note (optional)"} value={note} onChange={(e) => setNote(e.target.value)} required={mode === "adjust"} />
        <div className="actions"><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" loading={busy}>Save</Button></div>
      </form>
    </Modal>
  );
}

export function Inventory() {
  useTitle("Inventory");
  const { current, can } = useBusiness(); const [q, setQ] = useState(""); const dq = useDebounce(q); const [low, setLow] = useState(false); const [offset, setOffset] = useState(0);
  const [stock, setStock] = useState<{ product: any; mode: StockMode } | null>(null);
  const base = `/api/businesses/${current!.id}`;
  const { data, error, loading, reload } = useFetch<any>(`${base}/products${qs({ q: dq, lowStock: low, status: "active", limit: 25, offset, sort: "name" })}`);
  const val = useFetch<any>(can("reports.view") ? `${base}/inventory/valuation` : null);
  const manage = can("inventory.manage");
  return (
    <div className="stack">
      <PageHeader title="Inventory" crumbs={[{ to: "/app", label: "Dashboard" }, { label: "Inventory" }]} />
      {val.data && <div className="grid cols-3"><Stat label="Stock value (at cost)" value={money(val.data.totalCostValue)} /><Stat label="Stock value (at selling price)" value={money(val.data.totalRetailValue)} /></div>}
      <div className="filters">
        <TextField label="Search" type="search" value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }} placeholder="Name, SKU or barcode" />
        <Check label="Low stock only" checked={low} onChange={(e) => { setLow(e.target.checked); setOffset(0); }} />
      </div>
      {error ? <ErrorState error={error} retry={reload} /> : loading && !data ? <Spinner /> : (
        <Card>
          <DataTable rows={data.products} empty={<Empty title="No products found">Try a different search, or add your first product.</Empty>}
            cols={[
              { key: "name", label: "Product", render: (p: any) => <Link to={`/app/products/${p.id}`}>{p.name}</Link> },
              { key: "sku", label: "SKU" },
              { key: "stockQty", label: "In stock", num: true, render: (p: any) => <>{num(p.stockQty)} {p.unit} {p.lowStock && <Badge tone="warn">Low</Badge>}</> },
              { key: "minStock", label: "Minimum", num: true, render: (p: any) => num(p.minStock) },
            ]}
            actions={manage ? (p: any) => (<>
              <Button small onClick={() => setStock({ product: p, mode: "in" })}>Add</Button>
              <Button small onClick={() => setStock({ product: p, mode: "out" })}>Remove</Button>
              <Button small onClick={() => setStock({ product: p, mode: "adjust" })}>Count</Button>
            </>) : undefined} />
          <Pagination total={data.total} limit={25} offset={offset} onChange={setOffset} />
        </Card>
      )}
      {stock && <StockModal product={stock.product} mode={stock.mode} onClose={() => setStock(null)} onDone={reload} />}
    </div>
  );
}

export function Movements() {
  useTitle("Stock movements");
  const { current } = useBusiness(); const [type, setType] = useState(""); const [from, setFrom] = useState(""); const [to, setTo] = useState(""); const [offset, setOffset] = useState(0);
  const { data, error, loading, reload } = useFetch<any>(`/api/businesses/${current!.id}/inventory/movements${qs({ type, from, to, limit: 25, offset })}`);
  const reset = (fn: (v: string) => void) => (e: { target: { value: string } }) => { fn(e.target.value); setOffset(0); };
  return (
    <div className="stack">
      <PageHeader title="Stock movements" crumbs={[{ to: "/app", label: "Dashboard" }, { to: "/app/inventory", label: "Inventory" }, { label: "Movements" }]} />
      <div className="filters">
        <SelectField label="Type" value={type} onChange={reset(setType)}>
          <option value="">All types</option>
          {["opening", "stock_in", "stock_out", "adjustment", "purchase_receipt", "sale", "sale_cancel", "sale_return", "damaged"].map((t) => <option key={t} value={t}>{label(t)}</option>)}
        </SelectField>
        <TextField label="From" type="date" value={from} onChange={reset(setFrom)} />
        <TextField label="To" type="date" value={to} onChange={reset(setTo)} />
      </div>
      {error ? <ErrorState error={error} retry={reload} /> : loading && !data ? <Spinner /> : (
        <Card>
          <DataTable rows={data.movements} empty={<Empty title="No movements">Stock changes will be listed here, newest first.</Empty>}
            cols={[
              { key: "createdAt", label: "When", render: (m: any) => dateTime(m.createdAt) },
              { key: "productName", label: "Product", render: (m: any) => <>{m.productName} <span className="muted small">{m.sku}</span></> },
              { key: "type", label: "Type", render: (m: any) => <Badge>{label(m.type)}</Badge> },
              { key: "quantityDelta", label: "Change", num: true, render: (m: any) => <span className={m.quantityDelta > 0 ? "up" : "down"}>{m.quantityDelta > 0 ? "+" : ""}{num(m.quantityDelta)}</span> },
              { key: "balanceAfter", label: "Balance", num: true, render: (m: any) => num(m.balanceAfter) },
              { key: "note", label: "Note", render: (m: any) => m.note ?? "—" },
              { key: "actorName", label: "By", render: (m: any) => m.actorName ?? "—" },
            ]} />
          <Pagination total={data.total} limit={25} offset={offset} onChange={setOffset} />
        </Card>
      )}
    </div>
  );
}

export function LowStock() {
  useTitle("Low stock");
  const { current, can } = useBusiness(); const base = `/api/businesses/${current!.id}`;
  const { data, error, loading, reload } = useFetch<any>(`${base}/inventory/low-stock`);
  const [stock, setStock] = useState<any>(null);
  return (
    <div className="stack">
      <PageHeader title="Low stock" crumbs={[{ to: "/app", label: "Dashboard" }, { to: "/app/inventory", label: "Inventory" }, { label: "Low stock" }]} />
      {error ? <ErrorState error={error} retry={reload} /> : loading && !data ? <Spinner /> : (
        <Card>
          <DataTable rows={data.products} empty={<Empty title="Nothing is running low">Every product is above its minimum level.</Empty>}
            cols={[
              { key: "name", label: "Product", render: (p: any) => <Link to={`/app/products/${p.id}`}>{p.name}</Link> }, { key: "sku", label: "SKU" },
              { key: "stockQty", label: "In stock", num: true, render: (p: any) => <>{num(p.stockQty)} {p.unit} {p.stockQty === 0 && <Badge tone="danger">Out</Badge>}</> },
              { key: "minStock", label: "Minimum", num: true, render: (p: any) => num(p.minStock) },
            ]}
            actions={can("inventory.manage") ? (p: any) => <Button small onClick={() => setStock(p)}>Add stock</Button> : undefined} />
        </Card>
      )}
      {stock && <StockModal product={stock} mode="in" onClose={() => setStock(null)} onDone={reload} />}
    </div>
  );
}
