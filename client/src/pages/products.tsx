import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApiError, del, get, patch, post, qs, uploadFile } from "../lib/api";
import { useBusiness } from "../lib/business";
import { dateTime, label, money, num } from "../lib/format";
import { useDebounce, useFetch, useTitle } from "../lib/hooks";
import { useToast } from "../lib/toast";
import { Badge, Button, Card, Check, ConfirmDialog, DataTable, Empty, ErrorState, Modal, PageHeader, Pagination, SelectField, Spinner, statusTone, TextArea, TextField } from "../components/ui";
import { StockModal, type StockMode } from "./inventory";

export function Products() {
  useTitle("Products");
  const { current, can } = useBusiness(); const base = `/api/businesses/${current!.id}`;
  const [q, setQ] = useState(""); const dq = useDebounce(q); const [cat, setCat] = useState(""); const [status, setStatus] = useState("active"); const [low, setLow] = useState(false); const [offset, setOffset] = useState(0);
  const cats = useFetch<any>(`${base}/categories`);
  const { data, error, loading, reload } = useFetch<any>(`${base}/products${qs({ q: dq, categoryId: cat, status, lowStock: low, limit: 25, offset })}`);
  const reset = <T,>(fn: (v: T) => void) => (v: T) => { fn(v); setOffset(0); };
  return (
    <div className="stack">
      <PageHeader title="Products" crumbs={[{ to: "/app", label: "Dashboard" }, { label: "Products" }]}>{can("products.manage") && <Link className="btn btn-primary" to="/app/products/new">Add product</Link>}</PageHeader>
      <div className="filters">
        <TextField label="Search" type="search" value={q} onChange={(e) => reset(setQ)(e.target.value)} placeholder="Name, SKU or barcode" />
        <SelectField label="Category" value={cat} onChange={(e) => reset(setCat)(e.target.value)}><option value="">All categories</option>{cats.data?.categories.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</SelectField>
        <SelectField label="Status" value={status} onChange={(e) => reset(setStatus)(e.target.value)}><option value="active">Active</option><option value="inactive">Inactive</option><option value="">All</option></SelectField>
        <Check label="Low stock only" checked={low} onChange={(e) => reset(setLow)(e.target.checked)} />
      </div>
      {error ? <ErrorState error={error} retry={reload} /> : loading && !data ? <Spinner /> : (
        <Card>
          <DataTable rows={data.products}
            empty={<Empty title="No products found" action={can("products.manage") ? <Link className="btn btn-primary" to="/app/products/new">Add your first product</Link> : undefined}>Try a different search or filter.</Empty>}
            cols={[
              { key: "name", label: "Product", render: (p: any) => <Link to={`/app/products/${p.id}`}><strong>{p.name}</strong></Link> },
              { key: "sku", label: "SKU" }, { key: "categoryName", label: "Category", render: (p: any) => p.categoryName ?? "—" },
              { key: "stockQty", label: "In stock", num: true, render: (p: any) => <>{num(p.stockQty)} {p.unit} {p.lowStock && p.status === "active" && <Badge tone="warn">Low</Badge>}</> },
              { key: "sellingPrice", label: "Price", num: true, render: (p: any) => money(p.sellingPrice) },
              { key: "status", label: "Status", render: (p: any) => <Badge tone={statusTone(p.status)}>{label(p.status)}</Badge> },
            ]} />
          <Pagination total={data.total} limit={25} offset={offset} onChange={setOffset} />
        </Card>
      )}
    </div>
  );
}

const blank = { name: "", sku: "", hsnCode: "", barcode: "", categoryId: "", unit: "pcs", sellingPrice: "", costPrice: "", taxRate: "", minStock: "", openingStock: "", description: "", isListed: false, status: "active" };

export function ProductForm() {
  const { id } = useParams(); const editing = !!id;
  useTitle(editing ? "Edit product" : "Add product");
  const { current, can } = useBusiness(); const nav = useNavigate(); const { toast } = useToast(); const base = `/api/businesses/${current!.id}`;
  const cats = useFetch<any>(`${base}/categories`);
  const [f, setF] = useState<any>(blank); const [images, setImages] = useState<string[]>([]); const [errors, setErrors] = useState<Record<string, string>>({}); const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [uploading, setUploading] = useState(false);
  const [product, setProduct] = useState<any>(null); const [loadErr, setLoadErr] = useState<ApiError | null>(null); const [stock, setStock] = useState<StockMode | null>(null); const [confirm, setConfirm] = useState(false);
  const moves = useFetch<any>(editing && can("inventory.view") ? `${base}/inventory/movements${qs({ productId: id, limit: 8 })}` : null);

  const load = () => get<{ product: any }>(`${base}/products/${id}`).then(({ product: p }) => {
    setProduct(p); setImages(p.images ?? []);
    setF({ name: p.name, sku: p.sku, hsnCode: p.hsnCode ?? "", barcode: p.barcode ?? "", categoryId: p.categoryId ?? "", unit: p.unit, sellingPrice: String(p.sellingPrice), costPrice: p.costPrice === undefined ? "" : String(p.costPrice),
      taxRate: String(p.taxRate), minStock: String(p.minStock), openingStock: "", description: p.description ?? "", isListed: p.isListed, status: p.status });
  }).catch((e) => setLoadErr(e));
  useEffect(() => { if (editing) load(); /* eslint-disable-next-line */ }, [id]);

  const set = (k: string) => (e: any) => setF((s: any) => ({ ...s, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const numOrUndef = (v: string) => (v === "" ? undefined : Number(v));
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(""); setErrors({});
    const body: any = { name: f.name.trim(), sku: f.sku.trim() || undefined, hsnCode: f.hsnCode.trim() || (editing ? null : undefined), barcode: f.barcode.trim() || (editing ? null : undefined), categoryId: f.categoryId || (editing ? null : undefined), unit: f.unit.trim() || "pcs",
      sellingPrice: numOrUndef(f.sellingPrice), taxRate: numOrUndef(f.taxRate), minStock: numOrUndef(f.minStock), description: f.description.trim() || (editing ? null : undefined), images, isListed: f.isListed };
    if (can("products.manage") && f.costPrice !== "") body.costPrice = Number(f.costPrice);
    if (!editing) body.openingStock = numOrUndef(f.openingStock); else body.status = f.status;
    try {
      const r = editing ? await patch(`${base}/products/${id}`, body) : await post(`${base}/products`, body);
      toast(editing ? "Product saved" : "Product created"); if (editing) { setProduct(r.product); } else nav(`/app/products/${r.product.id}`);
    } catch (err) {
      if (err instanceof ApiError) { setErrors(err.details && typeof err.details === "object" ? err.details : {}); setError(err.message); } else setError("Something went wrong. Please try again.");
    } finally { setBusy(false); }
  };
  const addImage = async (file?: File) => {
    if (!file) return; setUploading(true);
    try { const r = await uploadFile(file, current!.id); setImages((l) => [...l, r.url].slice(0, 8)); } catch (e) { toast(e instanceof ApiError ? e.message : "Upload failed", "error"); } finally { setUploading(false); }
  };

  if (loadErr) return <ErrorState error={loadErr} retry={() => { setLoadErr(null); load(); }} />;
  if (editing && !product) return <Spinner />;
  return (
    <div className="stack">
      <PageHeader title={editing ? product.name : "Add product"} crumbs={[{ to: "/app", label: "Dashboard" }, { to: "/app/products", label: "Products" }, { label: editing ? "Edit" : "New" }]}>
        {editing && can("products.manage") && product.status === "active" && <Button variant="danger" onClick={() => setConfirm(true)}>Deactivate</Button>}
      </PageHeader>
      <div className="grid cols-2" style={{ alignItems: "start" }}>
        <Card title="Details">
          <form className="stack" onSubmit={submit} noValidate>
            {error && <div className="banner error" role="alert">{error}</div>}
            <div className="form-grid">
              <TextField label="Name" required value={f.name} onChange={set("name")} error={errors.name} />
              <TextField label="SKU" required={editing} value={f.sku} onChange={set("sku")} error={errors.sku} placeholder={editing ? undefined : "Auto-generated"} hint={editing ? undefined : "Leave blank and Blinxot assigns the next number (SKU-000001, SKU-000002…)"} />
              <TextField label="HSN / SAC code" inputMode="numeric" value={f.hsnCode} onChange={set("hsnCode")} error={errors.hsnCode} hint="4 to 8 digits; printed on GST invoices" />
              <TextField label="Barcode" value={f.barcode} onChange={set("barcode")} error={errors.barcode} />
              <SelectField label="Category" value={f.categoryId} onChange={set("categoryId")} error={errors.categoryId}><option value="">Uncategorised</option>{cats.data?.categories.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</SelectField>
              <TextField label="Selling price (₹)" type="number" inputMode="decimal" step="0.01" min="0" value={f.sellingPrice} onChange={set("sellingPrice")} error={errors.sellingPrice} />
              {(!editing || product.costPrice !== undefined) && <TextField label="Cost price (₹)" type="number" inputMode="decimal" step="0.01" min="0" value={f.costPrice} onChange={set("costPrice")} error={errors.costPrice} />}
              <TextField label="Tax rate (%)" type="number" inputMode="decimal" step="0.01" min="0" max="100" value={f.taxRate} onChange={set("taxRate")} error={errors.taxRate} />
              <TextField label="Unit" value={f.unit} onChange={set("unit")} error={errors.unit} hint="pcs, kg, litre…" />
              <TextField label="Minimum stock" type="number" inputMode="decimal" step="any" min="0" value={f.minStock} onChange={set("minStock")} error={errors.minStock} hint="You'll be alerted at or below this level." />
              {!editing && <TextField label="Opening stock" type="number" inputMode="decimal" step="any" min="0" value={f.openingStock} onChange={set("openingStock")} error={errors.openingStock} />}
              {editing && <SelectField label="Status" value={f.status} onChange={set("status")}><option value="active">Active</option><option value="inactive">Inactive</option></SelectField>}
            </div>
            <TextArea label="Description" value={f.description} onChange={set("description")} error={errors.description} />
            <Check label="List on the marketplace so other businesses can order it" checked={f.isListed} onChange={set("isListed")} />
            <div>
              <p style={{ fontWeight: 600, fontSize: ".9rem", marginBottom: ".4rem" }}>Images</p>
              <div className="row">{images.map((u, i) => (
                <span key={u} className="row" style={{ gap: ".25rem" }}><img src={u} alt={`Product ${i + 1}`} width={64} height={64} style={{ objectFit: "cover", borderRadius: 8 }} /><Button small variant="ghost" aria-label={`Remove image ${i + 1}`} onClick={() => setImages((l) => l.filter((x) => x !== u))}>×</Button></span>
              ))}</div>
              {images.length < 8 && <label className="btn" style={{ marginTop: ".5rem" }}>{uploading ? "Uploading…" : "Add image"}<input type="file" accept="image/png,image/jpeg,image/webp" hidden disabled={uploading} onChange={(e) => { addImage(e.target.files?.[0]); e.target.value = ""; }} /></label>}
            </div>
            <div className="actions"><Button type="submit" variant="primary" loading={busy}>{editing ? "Save changes" : "Create product"}</Button><Link className="btn" to="/app/products">Cancel</Link></div>
          </form>
        </Card>
        {editing && (
          <div className="stack">
            <Card title="Stock">
              <p><span style={{ fontSize: "2rem", fontWeight: 800 }}>{num(product.stockQty)}</span> <span className="muted">{product.unit}</span> {product.lowStock && <Badge tone="warn">Low</Badge>}</p>
              {can("inventory.manage") && <div className="actions">{(["in", "out", "adjust", "damaged"] as StockMode[]).map((m) => <Button key={m} small onClick={() => setStock(m)}>{{ in: "Add", out: "Remove", adjust: "Count", damaged: "Damaged" }[m]}</Button>)}</div>}
            </Card>
            {moves.data && (
              <Card title="Recent movements">
                {moves.data.movements.length ? <ul className="list">{moves.data.movements.map((m: any) => (
                  <li key={m.id}><span><Badge>{label(m.type)}</Badge><br /><span className="muted small">{dateTime(m.createdAt)}</span></span><span className="right"><strong className={m.quantityDelta > 0 ? "up" : "down"}>{m.quantityDelta > 0 ? "+" : ""}{num(m.quantityDelta)}</strong><br /><span className="muted small">→ {num(m.balanceAfter)}</span></span></li>
                ))}</ul> : <Empty title="No movements yet" />}
                <Link to="/app/inventory/movements">All movements →</Link>
              </Card>
            )}
          </div>
        )}
      </div>
      {editing && stock && <StockModal product={product} mode={stock} onClose={() => setStock(null)} onDone={() => { load(); moves.reload(); }} />}
      <ConfirmDialog open={confirm} danger title="Deactivate product?" confirmLabel="Deactivate" message="It will be hidden from new orders and the marketplace. Stock history and past orders are kept." onClose={() => setConfirm(false)}
        onConfirm={async () => { try { await del(`${base}/products/${id}`); toast("Product deactivated"); nav("/app/products"); } catch (e) { toast(e instanceof ApiError ? e.message : "Could not deactivate", "error"); setConfirm(false); } }} />
    </div>
  );
}

export function Categories() {
  useTitle("Categories");
  const { current, can } = useBusiness(); const { toast } = useToast(); const base = `/api/businesses/${current!.id}`;
  const { data, error, loading, reload } = useFetch<any>(`${base}/categories`);
  const [name, setName] = useState(""); const [busy, setBusy] = useState(false); const [edit, setEdit] = useState<any>(null); const [editName, setEditName] = useState(""); const [rm, setRm] = useState<any>(null);
  const manage = can("products.manage");
  const add = async (e: FormEvent) => { e.preventDefault(); setBusy(true); try { await post(`${base}/categories`, { name: name.trim() }); setName(""); toast("Category added"); reload(); } catch (err) { toast(err instanceof ApiError ? err.message : "Could not add", "error"); } finally { setBusy(false); } };
  return (
    <div className="stack">
      <PageHeader title="Categories" crumbs={[{ to: "/app", label: "Dashboard" }, { label: "Categories" }]} />
      {manage && <Card><form className="row" onSubmit={add} style={{ alignItems: "flex-end" }}><div className="grow"><TextField label="New category" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required /></div><Button type="submit" variant="primary" loading={busy} disabled={!name.trim()}>Add</Button></form></Card>}
      {error ? <ErrorState error={error} retry={reload} /> : loading && !data ? <Spinner /> : (
        <Card><DataTable rows={data.categories} empty={<Empty title="No categories yet">Categories help you group and filter products.</Empty>}
          cols={[{ key: "name", label: "Name" }, { key: "productCount", label: "Products", num: true }]}
          actions={manage ? (c: any) => <><Button small onClick={() => { setEdit(c); setEditName(c.name); }}>Rename</Button><Button small variant="danger" onClick={() => setRm(c)}>Delete</Button></> : undefined} /></Card>
      )}
      <Modal open={!!edit} title="Rename category" onClose={() => setEdit(null)}>
        <form className="stack" onSubmit={async (e) => { e.preventDefault(); try { await patch(`${base}/categories/${edit.id}`, { name: editName.trim() }); toast("Category renamed"); setEdit(null); reload(); } catch (err) { toast(err instanceof ApiError ? err.message : "Could not rename", "error"); } }}>
          <TextField label="Name" value={editName} onChange={(e) => setEditName(e.target.value)} required autoFocus />
          <div className="actions"><Button onClick={() => setEdit(null)}>Cancel</Button><Button type="submit" variant="primary">Save</Button></div>
        </form>
      </Modal>
      <ConfirmDialog open={!!rm} danger title="Delete category?" confirmLabel="Delete" message={rm && `"${rm.name}" will be removed. Its ${rm.productCount} product(s) will become uncategorised.`} onClose={() => setRm(null)}
        onConfirm={async () => { try { await del(`${base}/categories/${rm.id}`); toast("Category deleted"); setRm(null); reload(); } catch (e) { toast(e instanceof ApiError ? e.message : "Could not delete", "error"); setRm(null); } }} />
    </div>
  );
}
