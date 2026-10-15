import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApiError, post, qs } from "../lib/api";
import { addToCart, cartTotals, clearCart, removeLine, setQty, useCart } from "../lib/cart";
import { dateTime, label, money, num } from "../lib/format";
import { useDebounce, useFetch, useTitle } from "../lib/hooks";
import { STATES } from "../lib/states";
import { useToast } from "../lib/toast";
import { Badge, Button, Card, ConfirmDialog, Empty, ErrorState, PageHeader, Pagination, SelectField, Spinner, statusTone, TextArea, TextField } from "../components/ui";

// ---- Shop: browse listed products from every public business and add them to the cart
export function Shop() {
  useTitle("Shop");
  const [q, setQ] = useState(""); const dq = useDebounce(q); const [category, setCategory] = useState(""); const [offset, setOffset] = useState(0);
  const cart = useCart(); const { toast } = useToast(); const [conflict, setConflict] = useState<any>(null); const LIMIT = 12;
  const cats = useFetch<{ categories: { id: string; name: string }[] }>("/api/public/categories?kind=product");
  const { data, error, loading, reload } = useFetch<{ total: number; products: any[] }>(`/api/public/marketplace/products${qs({ q: dq, category, limit: LIMIT, offset })}`);
  const add = (p: any, replace = false) => {
    const line = { productId: p.id, name: p.name, price: p.price, taxRate: p.taxRate ?? 0, unit: p.unit, image: p.images?.[0] ?? null };
    const r = addToCart({ id: p.business.id, name: p.business.name, slug: p.business.slug }, line, 1, replace);
    if (r === "other-seller") setConflict(p); else { setConflict(null); toast(`${p.name} added to your cart`); }
  };
  return (
    <div className="stack">
      <PageHeader title="Shop" crumbs={[{ to: "/app", label: "Dashboard" }, { label: "Shop" }]}>
        <Link className="btn" to="/app/cart">Cart{cart.lines.length ? ` (${cart.lines.length})` : ""}</Link>
      </PageHeader>
      <div className="filters">
        <TextField label="Search" type="search" value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }} placeholder="Product name" />
        <SelectField label="Category" value={category} onChange={(e) => { setCategory(e.target.value); setOffset(0); }}><option value="">All categories</option>{cats.data?.categories.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}</SelectField>
      </div>
      {error ? <ErrorState error={error} retry={reload} /> : loading && !data ? <Spinner /> : data!.products.length === 0 ? <Card><Empty title="No products found">Try a different search or category.</Empty></Card> : (
        <div className="grid cols-3">{data!.products.map((p) => (
          <Card key={p.id}>
            <Link to={`/products/${p.id}`} className="tile">{p.images?.[0] ? <img className="thumb" src={p.images[0]} alt="" loading="lazy" /> : <span className="thumb ph" aria-hidden="true">{p.name.slice(0, 1).toUpperCase()}</span>}
              <div className="grow"><h2>{p.name}</h2><p className="price-sm">{money(p.price)} <span className="muted small">/ {p.unit}</span></p><p className="small muted">{p.business.name}</p></div></Link>
            <div className="actions" style={{ marginTop: ".75rem" }}>{p.inStock ? <Button variant="primary" small onClick={() => add(p)}>Add to cart</Button> : <Badge tone="warn">Out of stock</Badge>}</div>
          </Card>))}</div>)}
      {data && <Pagination total={data.total} limit={LIMIT} offset={offset} onChange={setOffset} />}
      <ConfirmDialog open={!!conflict} title="Start a new cart?" confirmLabel="Replace cart" onClose={() => setConflict(null)} onConfirm={() => add(conflict, true)}
        message={`Your cart has items from ${cart.businessName}. An order can only be placed with one business, so adding this will replace them.`} />
    </div>
  );
}

/** Quantity box that lets people clear and retype; only valid positive numbers are committed to the cart. */
function QtyInput({ name, value, onCommit }: { name: string; value: number; onCommit: (n: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => { if (Number(text) !== value) setText(String(value)); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [value]);
  return (
    <label className="qty"><span className="sr-only">Quantity of {name}</span>
      <input className="input" type="number" inputMode="decimal" min="0.001" step="any" value={text} aria-invalid={!(Number(text) > 0)}
        onChange={(e) => { setText(e.target.value); const n = Number(e.target.value); if (e.target.value !== "" && n > 0) onCommit(n); }}
        onBlur={() => { if (!(Number(text) > 0)) setText(String(value)); }} /></label>
  );
}

// ---- Cart + checkout
export function CartPage() {
  useTitle("Cart"); const cart = useCart(); const nav = useNavigate(); const { toast } = useToast();
  const [f, setF] = useState({ deliveryAddress: "", phone: "", notes: "", stateCode: "" }); const [errors, setErrors] = useState<Record<string, string>>({}); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const profile = useFetch<{ profile: { phone: string | null } }>("/api/me/profile");
  useEffect(() => { const ph = profile.data?.profile.phone; if (ph) setF((x) => (x.phone ? x : { ...x, phone: ph })); }, [profile.data]);
  const set = (k: string) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const t = cartTotals(cart);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(""); setErrors({});
    try {
      const r = await post<{ order: { id: string } }>("/api/me/orders", { businessId: cart.businessId, items: cart.lines.map((l) => ({ productId: l.productId, quantity: l.qty })), ...f, notes: f.notes || undefined, stateCode: f.stateCode || undefined });
      clearCart(); toast("Order placed"); nav(`/app/my-orders/${r.order.id}`);
    } catch (err) {
      if (err instanceof ApiError) { setError(err.message); if (err.details && typeof err.details === "object") setErrors(err.details as Record<string, string>); } else setError("Something went wrong. Please try again.");
    } finally { setBusy(false); }
  };
  if (!cart.lines.length) return <div className="stack"><PageHeader title="Cart" crumbs={[{ to: "/app", label: "Dashboard" }, { label: "Cart" }]} /><Card><Empty title="Your cart is empty" action={<Link className="btn btn-primary" to="/app/shop">Browse the shop</Link>}>Add products from any business to get started.</Empty></Card></div>;
  return (
    <div className="stack">
      <PageHeader title="Cart" crumbs={[{ to: "/app", label: "Dashboard" }, { to: "/app/shop", label: "Shop" }, { label: "Cart" }]} />
      <Card title={`Items from ${cart.businessName}`}>
        <ul className="list cart-lines">{cart.lines.map((l) => (
          <li key={l.productId}>
            <div className="grow"><strong>{l.name}</strong><div className="small muted">{money(l.price)} / {l.unit}{l.taxRate ? ` + ${l.taxRate}% tax` : ""}</div></div>
            <QtyInput name={l.name} value={l.qty} onCommit={(n) => setQty(l.productId, n)} />
            <span className="cart-total">{money(l.price * l.qty)}</span>
            <Button small variant="ghost" aria-label={`Remove ${l.name}`} onClick={() => removeLine(l.productId)}>Remove</Button>
          </li>))}</ul>
        <ul className="list totals"><li><span>Subtotal</span><span>{money(t.subtotal)}</span></li><li><span>Tax</span><span>{money(t.tax)}</span></li><li><strong>Estimated total</strong><strong>{money(t.total)}</strong></li></ul>
        <p className="small muted">The seller confirms the final amount. Payment is arranged directly with the seller on delivery.</p>
      </Card>
      <Card title="Delivery details">
        <form className="stack" onSubmit={submit} noValidate>
          {error && <div className="banner error" role="alert">{error}</div>}
          <TextArea label="Delivery address" required value={f.deliveryAddress} error={errors.deliveryAddress} onChange={set("deliveryAddress")} autoComplete="street-address" />
          <SelectField label="State" value={f.stateCode} onChange={set("stateCode")} error={errors.stateCode} hint="Used for the GST on your invoice. If unsure, leave as the seller's state."><option value="">Same as the seller</option>{STATES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</SelectField>
          <TextField label="Phone number" type="tel" inputMode="tel" autoComplete="tel" required value={f.phone} error={errors.phone} onChange={set("phone")} />
          <TextArea label="Notes for the seller (optional)" value={f.notes} error={errors.notes} onChange={set("notes")} />
          <p className="small muted">When your order is dispatched you'll receive a one-time delivery code in your notifications and by email. Give it only to the person completing your delivery.</p>
          <Button type="submit" variant="primary" loading={busy}>Place order</Button>
        </form>
      </Card>
    </div>
  );
}

// ---- My orders
export function MyOrders() {
  useTitle("My orders"); const [offset, setOffset] = useState(0); const LIMIT = 15;
  const { data, error, loading, reload } = useFetch<{ total: number; orders: any[] }>(`/api/me/orders${qs({ limit: LIMIT, offset })}`);
  return (
    <div className="stack">
      <PageHeader title="My orders" crumbs={[{ to: "/app", label: "Dashboard" }, { label: "My orders" }]}><Link className="btn btn-primary" to="/app/shop">Shop</Link></PageHeader>
      {error ? <ErrorState error={error} retry={reload} /> : loading && !data ? <Spinner /> : data!.orders.length === 0 ? <Card><Empty title="No orders yet" action={<Link className="btn btn-primary" to="/app/shop">Browse the shop</Link>}>Orders you place will appear here.</Empty></Card> : (
        <Card><ul className="list">{data!.orders.map((o) => (
          <li key={o.id}><div className="grow"><Link to={`/app/my-orders/${o.id}`}><strong>{o.orderNumber}</strong></Link> <span className="muted">· {o.seller.name}</span><div className="small muted">{dateTime(o.createdAt)}</div></div>
            <Badge tone={statusTone(o.status)}>{label(o.status)}</Badge><span>{money(o.total)}</span></li>))}</ul>
          <Pagination total={data!.total} limit={LIMIT} offset={offset} onChange={setOffset} /></Card>)}
    </div>
  );
}

const STEPS = ["pending", "accepted", "processing", "ready", "dispatched", "delivered"];

export function MyOrderDetail() {
  const { id = "" } = useParams(); useTitle("Order"); const { toast } = useToast();
  const { data, error, loading, reload } = useFetch<{ order: any }>(`/api/me/orders/${encodeURIComponent(id)}`);
  const [confirm, setConfirm] = useState(false); const [busy, setBusy] = useState(false);
  if (error) return <ErrorState error={error} retry={reload} />;
  if (loading || !data) return <Spinner />;
  const o = data.order; const cancelled = o.status === "cancelled"; const at = (s: string) => o.timeline.find((t: any) => t.status === s)?.at;
  const cancel = async () => {
    setBusy(true);
    try { await post(`/api/me/orders/${o.id}/cancel`); toast("Order cancelled"); setConfirm(false); reload(); }
    catch (e) { toast(e instanceof Error ? e.message : "Could not cancel", "error"); setConfirm(false); reload(); }
    finally { setBusy(false); }
  };
  return (
    <div className="stack">
      <PageHeader title={o.orderNumber} crumbs={[{ to: "/app", label: "Dashboard" }, { to: "/app/my-orders", label: "My orders" }, { label: o.orderNumber }]}><>{o.invoice && <Link className="btn" to={`/app/my-orders/${o.id}/invoice`}>Invoice {o.invoice.number}</Link>} <Badge tone={statusTone(o.status)}>{label(o.status)}</Badge></></PageHeader>
      {o.status === "dispatched" && <div className="banner info" role="status">Your order is on its way. Your delivery code was sent to your <Link to="/app/notifications">notifications</Link> and email — give it only to the person completing your delivery.</div>}
      {o.status === "delivered" && <div className="banner ok" role="status">Delivered. <Link to={`/b/${o.seller.slug}`}>View {o.seller.name}</Link> to see its profile, then leave a review under “My reviews”.</div>}
      <div className="grid cols-2">
        <Card title="Progress">{cancelled ? <p>This order was cancelled{o.cancelledAt ? ` on ${dateTime(o.cancelledAt)}` : ""}.</p> :
          <ol className="steps">{STEPS.map((s) => <li key={s} className={at(s) ? "done" : ""}><span>{label(s)}</span>{at(s) && <span className="small muted">{dateTime(at(s))}</span>}</li>)}</ol>}
          {o.canCancel && <Button variant="danger" onClick={() => setConfirm(true)}>Cancel order</Button>}
          {!o.canCancel && !cancelled && o.status !== "delivered" && <p className="small muted">The seller has started on this order. To change it, contact {o.seller.name}.</p>}
        </Card>
        <Card title="Details"><ul className="list">
          <li><span className="muted">Seller</span><Link to={`/b/${o.seller.slug}`}>{o.seller.name}</Link></li>
          <li><span className="muted">Placed</span><span>{dateTime(o.createdAt)}</span></li>
          <li><span className="muted">Deliver to</span><span>{o.deliveryAddress}</span></li>
          <li><span className="muted">Phone</span><span>{o.phone}</span></li>
          {o.notes && <li><span className="muted">Notes</span><span>{o.notes}</span></li>}</ul></Card>
      </div>
      <Card title="Items"><ul className="list">{o.items.map((i: any) => <li key={i.productId}><div className="grow">{i.name}<div className="small muted">{num(i.quantity)} × {money(i.unitPrice)}{i.taxRate ? ` + ${i.taxRate}% tax` : ""}</div></div><span>{money(i.lineTotal)}</span></li>)}</ul>
        <ul className="list totals"><li><span>Subtotal</span><span>{money(o.subtotal)}</span></li><li><span>Tax</span><span>{money(o.taxTotal)}</span></li><li><strong>Total</strong><strong>{money(o.total)}</strong></li></ul></Card>
      <ConfirmDialog open={confirm} title="Cancel this order?" message="The seller will be told. This can't be undone." confirmLabel="Cancel order" danger loading={busy} onConfirm={cancel} onClose={() => setConfirm(false)} />
    </div>
  );
}
