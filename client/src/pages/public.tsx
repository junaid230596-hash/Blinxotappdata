import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { InstallButton } from "../components/InstallPrompt";
import { Badge, Button, Card, Empty, ErrorState, Logo, Pagination, Spinner, TextArea, TextField } from "../components/ui";
import { ApiError, post, qs } from "../lib/api";
import { addToCart } from "../lib/cart";
import { useAuth } from "../lib/auth";
import { date, label, money } from "../lib/format";
import { useDebounce, useFetch } from "../lib/hooks";
import { siteOrigin, useSeo } from "../lib/seo";

/** Only plain web links are ever rendered as hrefs (blocks javascript:, data: and friends even if bad data got in). */
export const safeHref = (u?: string | null) => (u && /^https?:\/\/\S+$/i.test(u) ? u : undefined);

// ---------------------------------------------------------------- layout
const NAVLINKS = [["/features", "Features"], ["/pricing", "Pricing"], ["/discover", "Businesses"], ["/products", "Products"], ["/jobs", "Jobs"]] as const;

export function PublicLayout() {
  const { user } = useAuth(); const loc = useLocation(); const [open, setOpen] = useState(false);
  useEffect(() => { setOpen(false); window.scrollTo?.(0, 0); }, [loc.pathname]);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", esc); return () => document.removeEventListener("keydown", esc);
  }, [open]);
  return (
    <div className="pub">
      <a className="skip" href="#main">Skip to content</a>
      <header className="pub-header">
        <div className="pub-bar">
          <Link to="/" className="brand"><Logo /><span>Blinxot</span></Link>
          <Button variant="ghost" className="pub-burger" aria-label={open ? "Close menu" : "Open menu"} aria-expanded={open} aria-controls="pub-nav" onClick={() => setOpen((o) => !o)}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">{open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M3 6h18M3 12h18M3 18h18" />}</svg>
          </Button>
          <nav id="pub-nav" className={`pub-nav ${open ? "open" : ""}`} aria-label="Main">
            {NAVLINKS.map(([to, text]) => <NavLink key={to} to={to}>{text}</NavLink>)}
            <span className="pub-nav-actions">
              {user ? <Link className="btn btn-primary" to="/app">Open app</Link> : <><Link className="btn" to="/login">Log in</Link><Link className="btn btn-primary" to="/register">Sign up free</Link></>}
            </span>
          </nav>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="pub-main"><Outlet /></main>
      <footer className="pub-footer">
        <div className="pub-wrap pub-foot">
          <div><Link to="/" className="brand"><Logo size={26} /><span>Blinxot</span></Link><p className="small muted">Business and work management for inventory, orders, people and customers.</p></div>
          <nav aria-label="Footer"><h2 className="pub-foot-h">Product</h2><Link to="/features">Features</Link><Link to="/pricing">Pricing</Link><Link to="/discover">Businesses</Link><Link to="/products">Products</Link><Link to="/jobs">Jobs</Link></nav>
          <nav aria-label="Company"><h2 className="pub-foot-h">Company</h2><Link to="/about">About</Link><Link to="/contact">Contact</Link><Link to="/login">Log in</Link><Link to="/register">Sign up</Link><InstallButton /></nav>
        </div>
        <p className="small muted pub-copy">© {new Date().getFullYear()} Blinxot. All rights reserved.</p>
      </footer>
    </div>
  );
}

const Section = ({ children, tone, id, className = "" }: { children: ReactNode; tone?: "alt"; id?: string; className?: string }) => <section id={id} className={`pub-section ${tone ?? ""} ${className}`}><div className="pub-wrap">{children}</div></section>;
export const PublicNotFound = () => <NotFoundPublic />;
const NotFoundPublic = ({ what = "page" }: { what?: string }) => { useSeo({ title: "Not found", noindex: true }); return <Section><Card><Empty title={`We couldn't find that ${what}`} action={<Link className="btn btn-primary" to="/discover">Browse businesses</Link>}>It may have been removed or made private.</Empty></Card></Section>; };
const Stars = ({ value }: { value: number }) => <span className="stars" role="img" aria-label={`${value} out of 5 stars`}>{"★".repeat(Math.round(value))}{"☆".repeat(5 - Math.round(value))}</span>;
const Loading = () => <Section><Spinner /></Section>;

// ---------------------------------------------------------------- marketing pages
const FEATURE_GROUPS: { title: string; blurb: string; items: string[] }[] = [
  { title: "Products & inventory", blurb: "Always know what you have and where it went.", items: ["Products with SKU, barcode, images, categories, tax and units", "Stock in, stock out, counts, damaged stock and returns", "Every change is recorded in a movement history that always adds up", "Low-stock alerts and inventory valuation"] },
  { title: "Orders & purchasing", blurb: "Sell and buy, with proof at the door.", items: ["Create and track orders from pending to delivered", "Delivery and pickup confirmed with a one-time code", "Purchase orders to suppliers: draft, send, accept and receive", "Discover and order from other businesses on Blinxot"] },
  { title: "Team & attendance", blurb: "From punch-in to payslip.", items: ["Each employee gets their own login", "Punch in and out with trustworthy server time", "Late arrival, early departure and monthly attendance reports", "Hourly, daily or monthly pay with overtime, bonuses and deductions", "Tasks, leave requests, performance reviews and private documents"] },
  { title: "Customers & CRM", blurb: "Never lose track of a conversation.", items: ["Customer records with orders, notes and conversation history", "Leads, contacts, companies and deals", "A pipeline with stages you can change", "Follow-ups and reminders"] },
  { title: "Jobs & people", blurb: "Hire, and be hired.", items: ["Publish job and work opportunities", "Review, shortlist, interview and select applicants", "Professional profiles and resumes with skills and experience", "Ratings and reviews that must be earned"] },
  { title: "Reports & control", blurb: "Decide with facts.", items: ["Sales, purchases, inventory, attendance, salary, customer and CRM reports", "Filter by date and export to CSV or PDF", "Roles and permissions down to individual actions", "Audit trail of important changes"] },
];

export function Home() {
  const { user } = useAuth();
  useSeo({ title: "Blinxot", description: "Run inventory, orders, purchasing, attendance, CRM, hiring and reports from one mobile-friendly platform built for growing businesses.", path: "/",
    ld: { "@context": "https://schema.org", "@graph": [
      { "@type": "Organization", name: "Blinxot", url: siteOrigin(), logo: `${siteOrigin()}/icon-512.png` },
      { "@type": "WebSite", name: "Blinxot", url: siteOrigin(), potentialAction: { "@type": "SearchAction", target: `${siteOrigin()}/discover?q={search_term_string}`, "query-input": "required name=search_term_string" } }] } });
  return (
    <>
      <Section className="hero">
        <h1>Run your whole business from one place</h1>
        <p className="lead">Blinxot brings inventory, orders, purchasing, your team, customers and hiring together — designed for phones first, so it works wherever your business happens.</p>
        <div className="actions hero-actions">
          {user ? <Link className="btn btn-primary" to="/app">Open your dashboard</Link> : <Link className="btn btn-primary" to="/register">Create a free account</Link>}
          <Link className="btn" to="/discover">Browse businesses</Link>
        </div>
        <p className="small muted">Free plan available. Works in your browser and installs like an app on Android, iPhone and desktop.</p>
      </Section>
      <Section tone="alt">
        <h2>Everything a growing business needs</h2>
        <div className="grid cols-3">
          {FEATURE_GROUPS.map((g) => <Card key={g.title}><h3>{g.title}</h3><p className="muted">{g.blurb}</p></Card>)}
        </div>
        <p><Link to="/features">See every feature →</Link></p>
      </Section>
      <Section>
        <h2>Built for everyone in the ecosystem</h2>
        <div className="grid cols-4">
          <Card><h3>Business owners</h3><p className="muted">Manage stock, sales, staff and customers.</p></Card>
          <Card><h3>Suppliers</h3><p className="muted">List products and receive orders from other businesses.</p></Card>
          <Card><h3>Employees</h3><p className="muted">Punch in, see tasks, and check your work summary.</p></Card>
          <Card><h3>Individuals</h3><p className="muted">Build a work profile, find jobs and track applications.</p></Card>
        </div>
      </Section>
      <Section tone="alt"><div className="cta"><h2>Ready to get organised?</h2><p>Set up your business in minutes. Upgrade only when you outgrow the free plan.</p>
        <div className="actions"><Link className="btn btn-primary" to={user ? "/app" : "/register"}>{user ? "Go to dashboard" : "Get started free"}</Link><Link className="btn" to="/pricing">View pricing</Link></div></div></Section>
    </>
  );
}

export function Features() {
  useSeo({ title: "Features", description: "Inventory, orders and purchasing, attendance and pay, CRM, jobs, reports and permissions — everything Blinxot includes.", path: "/features" });
  return (
    <Section>
      <h1>Features</h1>
      <p className="lead">One platform, many tools. Every module works together, so a sale updates stock and a punch-in feeds payroll.</p>
      <div className="grid cols-2">
        {FEATURE_GROUPS.map((g) => <Card key={g.title}><h2>{g.title}</h2><p className="muted">{g.blurb}</p><ul className="ticks">{g.items.map((i) => <li key={i}>{i}</li>)}</ul></Card>)}
      </div>
    </Section>
  );
}

const LIMIT_LABELS: [string, string][] = [["members", "Team members"], ["products", "Products"], ["ordersPerMonth", "Orders per month"], ["businesses", "Businesses"], ["storageMb", "File storage"]];
const limitText = (k: string, v: unknown) => (v == null ? "Unlimited" : k === "storageMb" ? (Number(v) >= 1024 ? `${Number(v) / 1024} GB` : `${v} MB`) : new Intl.NumberFormat("en-IN").format(Number(v)));

export function Pricing() {
  useSeo({ title: "Pricing", description: "Start free and upgrade as your team, catalogue and order volume grow. Simple plans with clear limits.", path: "/pricing" });
  const { data, error, loading, reload } = useFetch<{ plans: { key: string; name: string; priceMonthly: number | null; currency: string; limits: Record<string, number> }[] }>("/api/plans");
  return (
    <Section>
      <h1>Simple, scalable pricing</h1>
      <p className="lead">Start free. Move up when you need more people, products or orders.</p>
      {loading && <Spinner />}
      {error && <ErrorState error={error} retry={reload} />}
      {data && (
        <div className="grid cols-4 plans">
          {data.plans.map((p) => (
            <Card key={p.key} className="plan">
              <h2>{p.name}</h2>
              <p className="price">{p.priceMonthly == null ? "Custom" : p.priceMonthly === 0 ? "Free" : <>{money(p.priceMonthly, p.currency)}<span className="muted small"> / month</span></>}</p>
              <ul className="ticks">{LIMIT_LABELS.map(([k, text]) => <li key={k}><strong>{limitText(k, p.limits[k])}</strong> {text.toLowerCase()}</li>)}</ul>
              {p.priceMonthly === 0 ? <Link className="btn btn-primary" to="/register">Get started free</Link> : <Link className="btn" to="/contact">Talk to us</Link>}
            </Card>
          ))}
        </div>
      )}
      <p className="small muted" style={{ marginTop: "1rem" }}>Online checkout is not enabled yet — paid plans are activated by our team after you get in touch. Prices exclude applicable taxes.</p>
    </Section>
  );
}

export function About() {
  useSeo({ title: "About", description: "Blinxot connects businesses, employees, suppliers, customers and individuals in one ecosystem.", path: "/about" });
  return (
    <Section>
      <h1>About Blinxot</h1>
      <div className="prose">
        <p className="lead">Blinxot is a business and work-management platform that connects businesses, employees, suppliers, customers and individuals in one ecosystem.</p>
        <p>Small and growing businesses usually run on a patchwork of notebooks, chat groups and spreadsheets. Blinxot replaces that with one connected system: the stock you hold, the orders you take, the people who work for you and the customers you serve all live in the same place and stay consistent with each other.</p>
        <p>It is built mobile-first because that is where most of the work happens — on the shop floor, in the warehouse, on the road.</p>
        <p><Link className="btn btn-primary" to="/register">Create a free account</Link></p>
      </div>
    </Section>
  );
}

export function Contact() {
  useSeo({ title: "Contact", description: "Get in touch with the Blinxot team about plans, onboarding and support.", path: "/contact" });
  const { data, loading } = useFetch<{ supportEmail: string | null }>("/api/public/site");
  const [f, setF] = useState({ name: "", email: "", message: "", website: "" });
  const [errors, setErrors] = useState<Record<string, string>>({}); const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [sent, setSent] = useState(false);
  const set = (k: string) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(""); setErrors({});
    try { await post("/api/public/contact", f); setSent(true); }
    catch (err) { if (err instanceof ApiError) { setError(err.message); if (err.details && typeof err.details === "object") setErrors(err.details as Record<string, string>); } else setError("Something went wrong. Please try again."); }
    finally { setBusy(false); }
  };
  return (
    <Section>
      <h1>Contact us</h1>
      <Card>
        {loading ? <Spinner /> : !data?.supportEmail
          ? <p>Our support address is being set up. If you already have an account, sign in and your business admin or our team can help from there.</p>
          : sent ? <div className="banner ok" role="status">Thanks — your message has been sent. We'll reply to {f.email} as soon as we can.</div>
          : <form className="stack" onSubmit={submit} noValidate>
              <p>Questions about plans, onboarding or your account? Send us a message, or email <a href={`mailto:${data.supportEmail}`}>{data.supportEmail}</a>.</p>
              {error && <div className="banner error" role="alert">{error}</div>}
              <TextField label="Your name" autoComplete="name" required value={f.name} error={errors.name} onChange={set("name")} />
              <TextField label="Email" type="email" autoComplete="email" inputMode="email" required value={f.email} error={errors.email} onChange={set("email")} />
              <TextArea label="Message" required value={f.message} error={errors.message} onChange={set("message")} />
              <div aria-hidden="true" style={{ position: "absolute", left: "-9999px" }}><label>Leave this empty<input tabIndex={-1} autoComplete="off" value={f.website} onChange={set("website")} /></label></div>
              <Button type="submit" variant="primary" loading={busy}>Send message</Button>
            </form>}
        <p className="small muted">Please don't send passwords or one-time codes — we will never ask for them.</p>
      </Card>
    </Section>
  );
}

// ---------------------------------------------------------------- discovery
function AdStrip({ placement, businessId }: { placement: "discover" | "business_profile" | "product_discovery"; businessId?: string }) {
  const { data } = useFetch<{ ads: { id: string; title: string; description: string | null; imageUrl: string | null; ctaLabel: string | null; ctaUrl: string | null; business: { name: string; slug: string } }[] }>(`/api/public/ads${qs({ placement, businessId, limit: 3 })}`);
  if (!data?.ads.length) return null;
  return (
    <section aria-label="Sponsored" className="ads">
      {data.ads.map((a) => {
        const href = safeHref(a.ctaUrl);
        return (
          <article key={a.id} className="card ad">
            {a.imageUrl && <img src={a.imageUrl} alt="" loading="lazy" />}
            <div><Badge>Sponsored</Badge><h3>{a.title}</h3>{a.description && <p className="small muted">{a.description}</p>}
              <p className="small"><Link to={`/b/${a.business.slug}`}>{a.business.name}</Link>{href && <> · <a href={href} target="_blank" rel="noopener noreferrer sponsored" onClick={() => { void post(`/api/public/ads/${a.id}/click`).catch(() => {}); }}>{a.ctaLabel || "Learn more"}</a></>}</p></div>
          </article>
        );
      })}
    </section>
  );
}

const Thumb = ({ src, name }: { src?: string | null; name: string }) => src
  ? <img className="thumb" src={src} alt="" loading="lazy" />
  : <span className="thumb ph" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>;

function useListParams() {
  const [sp, setSp] = useSearchParams();
  const set = (patch: Record<string, string | number | undefined>) => setSp((cur) => {
    const n = new URLSearchParams(cur);
    for (const [k, v] of Object.entries(patch)) (v === undefined || v === "" ? n.delete(k) : n.set(k, String(v)));
    if (!("offset" in patch)) n.delete("offset");
    return n;
  }, { replace: true });
  return { sp, set, offset: Math.max(0, Number(sp.get("offset")) || 0) };
}

export function Discover() {
  const { sp, set, offset } = useListParams(); const [q, setQ] = useState(sp.get("q") ?? ""); const dq = useDebounce(q, 350);
  useEffect(() => { if (dq !== (sp.get("q") ?? "")) set({ q: dq }); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [dq]);
  useSeo({ title: "Discover businesses", description: "Find businesses and suppliers on Blinxot and browse the products they offer.", path: "/discover", noindex: !!sp.get("q") || offset > 0 });
  const category = sp.get("category") ?? ""; const LIMIT = 12;
  const cats = useFetch<{ categories: { id: string; name: string }[] }>("/api/public/categories?kind=business");
  const { data, error, loading, reload } = useFetch<{ total: number; businesses: any[] }>(`/api/public/marketplace/businesses${qs({ q: sp.get("q") ?? "", category, limit: LIMIT, offset })}`);
  return (
    <Section>
      <h1>Discover businesses</h1>
      <div className="filters">
        <div className="field"><label htmlFor="d-q">Search</label><input id="d-q" className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or what they sell" /></div>
        <div className="field"><label htmlFor="d-c">Category</label>
          <select id="d-c" className="select" value={category} onChange={(e) => set({ category: e.target.value })}><option value="">All categories</option>{cats.data?.categories.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}</select></div>
      </div>
      {!sp.get("q") && !category && offset === 0 && <AdStrip placement="discover" />}
      {error && <ErrorState error={error} retry={reload} />}
      {loading && !data ? <Spinner /> : data && (data.businesses.length === 0
        ? <Card><Empty title="No businesses found">Try a different search or category.</Empty></Card>
        : <div className="grid cols-3">{data.businesses.map((b) => (
            <Link key={b.id} to={`/b/${b.slug}`} className="card tile">
              <Thumb src={b.logoUrl} name={b.name} /><div className="grow"><h2>{b.name}</h2>{b.category && <Badge>{b.category}</Badge>}
                {b.description && <p className="small muted clamp">{b.description}</p>}<p className="small muted">{b.listedProducts} product{b.listedProducts === 1 ? "" : "s"} listed</p></div>
            </Link>))}</div>)}
      {data && <Pagination total={data.total} limit={LIMIT} offset={offset} onChange={(o) => set({ offset: o })} />}
    </Section>
  );
}

export function ProductDiscovery() {
  const { sp, set, offset } = useListParams(); const [q, setQ] = useState(sp.get("q") ?? ""); const dq = useDebounce(q, 350);
  useEffect(() => { if (dq !== (sp.get("q") ?? "")) set({ q: dq }); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [dq]);
  useSeo({ title: "Browse products", description: "Search products offered by businesses and suppliers on Blinxot.", path: "/products", noindex: sp.size > 0 });
  const LIMIT = 12; const category = sp.get("category") ?? ""; const sort = sp.get("sort") ?? "name";
  const cats = useFetch<{ categories: { id: string; name: string }[] }>("/api/public/categories?kind=product");
  const [dir, sortKey] = sort === "price_desc" ? ["desc", "price"] : sort === "price_asc" ? ["asc", "price"] : ["asc", "name"];
  const { data, error, loading, reload } = useFetch<{ total: number; products: any[] }>(`/api/public/marketplace/products${qs({ q: sp.get("q") ?? "", category, sort: sortKey, dir, minPrice: sp.get("minPrice"), maxPrice: sp.get("maxPrice"), limit: LIMIT, offset })}`);
  return (
    <Section>
      <h1>Browse products</h1>
      <div className="filters">
        <div className="field"><label htmlFor="p-q">Search</label><input id="p-q" className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Product name" /></div>
        <div className="field"><label htmlFor="p-c">Category</label><select id="p-c" className="select" value={category} onChange={(e) => set({ category: e.target.value })}><option value="">All categories</option>{cats.data?.categories.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}</select></div>
        <div className="field"><label htmlFor="p-min">Min price (₹)</label><input id="p-min" className="input" inputMode="decimal" value={sp.get("minPrice") ?? ""} onChange={(e) => set({ minPrice: e.target.value.replace(/[^\d.]/g, "") })} /></div>
        <div className="field"><label htmlFor="p-max">Max price (₹)</label><input id="p-max" className="input" inputMode="decimal" value={sp.get("maxPrice") ?? ""} onChange={(e) => set({ maxPrice: e.target.value.replace(/[^\d.]/g, "") })} /></div>
        <div className="field"><label htmlFor="p-s">Sort by</label><select id="p-s" className="select" value={sort} onChange={(e) => set({ sort: e.target.value })}><option value="name">Name</option><option value="price_asc">Price: low to high</option><option value="price_desc">Price: high to low</option></select></div>
      </div>
      {!sp.get("q") && !category && offset === 0 && <AdStrip placement="product_discovery" />}
      {error && <ErrorState error={error} retry={reload} />}
      {loading && !data ? <Spinner /> : data && (data.products.length === 0
        ? <Card><Empty title="No products found">Try a different search or filter.</Empty></Card>
        : <div className="grid cols-3">{data.products.map((p) => (
            <Link key={p.id} to={`/products/${p.id}`} className="card tile">
              <Thumb src={p.images?.[0]} name={p.name} /><div className="grow"><h2>{p.name}</h2><p className="price-sm">{money(p.price)} <span className="muted small">/ {p.unit}</span></p>
                <p className="small muted">{p.business.name}</p>{!p.inStock && <Badge tone="warn">Out of stock</Badge>}</div>
            </Link>))}</div>)}
      {data && <Pagination total={data.total} limit={LIMIT} offset={offset} onChange={(o) => set({ offset: o })} />}
    </Section>
  );
}

export function ProductDetail() {
  const { id = "" } = useParams(); const { user } = useAuth(); const nav = useNavigate();
  const { data, error, loading } = useFetch<{ product: any }>(`/api/public/marketplace/products/${encodeURIComponent(id)}`);
  const p = data?.product;
  useSeo(p ? { title: p.name, description: p.description?.slice(0, 160) || `${p.name} from ${p.business.name} on Blinxot.`, path: `/products/${p.id}`, image: p.images?.[0], type: "article",
    ld: { "@context": "https://schema.org", "@type": "Product", name: p.name, description: p.description ?? undefined, sku: p.sku, image: p.images?.map((i: string) => siteOrigin() + i),
      offers: { "@type": "Offer", price: p.price, priceCurrency: "INR", availability: p.inStock ? "https://schema.org/InStock" : "https://schema.org/OutOfStock", seller: { "@type": "Organization", name: p.business.name } } } }
    : { title: "Product", noindex: true });
  if (loading) return <Loading />;
  if (error?.status === 404 || !p) return error && error.status !== 404 ? <Section><ErrorState error={error} /></Section> : <NotFoundPublic what="product" />;
  return (
    <Section>
      <nav className="crumbs" aria-label="Breadcrumb"><Link to="/products">Products</Link> / <span>{p.name}</span></nav>
      <div className="grid cols-2">
        <div className="gallery">{p.images?.length ? p.images.slice(0, 4).map((src: string, i: number) => <img key={src} src={src} alt={i === 0 ? p.name : ""} loading={i ? "lazy" : "eager"} />) : <Thumb name={p.name} />}</div>
        <div className="stack">
          <h1>{p.name}</h1>
          <p className="price">{money(p.price)} <span className="muted small">/ {p.unit}{p.taxRate ? ` + ${p.taxRate}% tax` : ""}</span></p>
          <p>{p.inStock ? <Badge tone="ok">In stock</Badge> : <Badge tone="warn">Out of stock</Badge>} {p.categoryName && <Badge>{p.categoryName}</Badge>}</p>
          {p.description && <p>{p.description}</p>}
          <p className="small muted">Sold by <Link to={`/b/${p.business.slug}`}>{p.business.name}</Link>{p.sku && <> · SKU {p.sku}</>}</p>
          <div className="actions">
            {user?.accountType === "individual"
              ? (p.inStock ? <Button variant="primary" onClick={() => { const r = addToCart(p.business, { productId: p.id, name: p.name, price: p.price, taxRate: p.taxRate ?? 0, unit: p.unit, image: p.images?.[0] ?? null }); if (r === "other-seller") nav("/app/shop"); else nav("/app/cart"); }}>Add to cart</Button> : <Badge tone="warn">Out of stock</Badge>)
              : <Button variant="primary" onClick={() => nav(user ? "/app/marketplace" : "/login", { state: { from: user ? "/app/marketplace" : `/products/${p.id}` } })}>{!user ? "Log in to buy" : "Order from this business"}</Button>}
            <Link className="btn" to={`/b/${p.business.slug}`}>View business</Link>
          </div>
        </div>
      </div>
    </Section>
  );
}

const DAYS: [string, string][] = [["mon", "Monday"], ["tue", "Tuesday"], ["wed", "Wednesday"], ["thu", "Thursday"], ["fri", "Friday"], ["sat", "Saturday"], ["sun", "Sunday"]];
const SOCIAL_LABEL: Record<string, string> = { facebook: "Facebook", instagram: "Instagram", x: "X", linkedin: "LinkedIn", youtube: "YouTube", whatsapp: "WhatsApp" };
const DAY_SCHEMA: Record<string, string> = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };

export function BusinessProfile() {
  const { slug = "" } = useParams(); const s = encodeURIComponent(slug);
  const biz = useFetch<{ business: any }>(`/api/public/businesses/${s}`);
  const b = biz.data?.business;
  const reviews = useFetch<{ summary: { average: number | null; count: number }; reviews: any[] }>(b ? `/api/public/businesses/${s}/reviews?limit=5` : null);
  const products = useFetch<{ total: number; products: any[] }>(b ? `/api/public/marketplace/products${qs({ businessId: b.id, limit: 6 })}` : null);
  const jobs = useFetch<{ jobs: any[]; total: number }>(b ? `/api/public/jobs${qs({ businessId: b.id, limit: 5 })}` : null);
  const hours = (b?.businessHours ?? {}) as Record<string, { open?: string; close?: string; closed?: boolean }>;
  const social = Object.entries((b?.socialLinks ?? {}) as Record<string, string>).filter(([, u]) => safeHref(u));
  const sum = reviews.data?.summary;
  useSeo(b ? { title: b.name, description: b.description?.slice(0, 160) || `${b.name} on Blinxot — products, contact details and reviews.`, path: `/b/${b.slug}`, image: b.logoUrl, type: "profile",
    ld: { "@context": "https://schema.org", "@type": "LocalBusiness", name: b.name, description: b.description ?? undefined, url: `${siteOrigin()}/b/${b.slug}`, image: b.logoUrl ? siteOrigin() + b.logoUrl : undefined,
      telephone: b.phone ?? undefined, email: b.email ?? undefined, address: b.address ?? undefined, sameAs: social.map(([, u]) => u),
      openingHoursSpecification: Object.entries(hours).filter(([, h]) => h.open && h.close).map(([d, h]) => ({ "@type": "OpeningHoursSpecification", dayOfWeek: DAY_SCHEMA[d], opens: h.open, closes: h.close })),
      aggregateRating: sum?.count ? { "@type": "AggregateRating", ratingValue: sum.average, reviewCount: sum.count } : undefined } }
    : { title: "Business", noindex: true });
  if (biz.loading) return <Loading />;
  if (!b) return biz.error && biz.error.status !== 404 ? <Section><ErrorState error={biz.error} retry={biz.reload} /></Section> : <NotFoundPublic what="business" />;
  const website = safeHref(b.website);
  return (
    <Section>
      <nav className="crumbs" aria-label="Breadcrumb"><Link to="/discover">Businesses</Link> / <span>{b.name}</span></nav>
      <div className="row biz-head"><Thumb src={b.logoUrl} name={b.name} /><div className="grow"><h1>{b.name}</h1>
        <p>{b.category && <Badge>{b.category}</Badge>} {sum?.count ? <><Stars value={sum.average ?? 0} /> <span className="small muted">{sum.average} · {sum.count} review{sum.count === 1 ? "" : "s"}</span></> : <span className="small muted">No reviews yet</span>}</p></div></div>
      <div className="grid cols-2">
        <div className="stack">
          {b.description && <Card title="About"><p style={{ whiteSpace: "pre-line" }}>{b.description}</p></Card>}
          <Card title="Products">{products.data?.products.length ? <>
            <ul className="list">{products.data.products.map((p) => <li key={p.id}><Link to={`/products/${p.id}`}>{p.name}</Link><span>{money(p.price)}</span></li>)}</ul>
            {products.data.total > 6 && <p className="small"><Link to={`/products?q=${encodeURIComponent(b.name)}`}>Browse more products</Link></p>}</> : <p className="muted">No products listed yet.</p>}</Card>
          {!!jobs.data?.jobs.length && <Card title="Open positions"><ul className="list">{jobs.data.jobs.map((j) => <li key={j.id}><Link to={`/jobs/${j.id}`}>{j.title}</Link><span className="small muted">{label(j.workType)}{j.location ? ` · ${j.location}` : ""}</span></li>)}</ul></Card>}
          <Card title="Reviews">{reviews.data?.reviews.length ? <ul className="list">{reviews.data.reviews.map((r) => (
            <li key={r.id} className="review"><div><Stars value={r.rating} /> <strong>{r.reviewer}</strong> {r.badge && <Badge tone="info">{r.badge}</Badge>} <span className="small muted">{date(r.createdAt)}</span>{r.body && <p>{r.body}</p>}</div></li>))}</ul> : <p className="muted">No reviews yet.</p>}</Card>
        </div>
        <div className="stack">
          <Card title="Contact">
            <ul className="list">
              {b.address && <li><span>Address</span><span>{b.address}</span></li>}
              {b.phone && <li><span>Phone</span><a href={`tel:${b.phone.replace(/[^\d+]/g, "")}`}>{b.phone}</a></li>}
              {b.email && <li><span>Email</span><a href={`mailto:${b.email}`}>{b.email}</a></li>}
              {website && <li><span>Website</span><a href={website} target="_blank" rel="noopener noreferrer nofollow">{website.replace(/^https?:\/\//, "")}</a></li>}
            </ul>
            {!b.address && !b.phone && !b.email && !website && <p className="muted">No contact details published.</p>}
            {social.length > 0 && <p className="social">{social.map(([k, u]) => <a key={k} className="btn btn-sm" href={safeHref(u)} target="_blank" rel="noopener noreferrer nofollow">{SOCIAL_LABEL[k] ?? k}</a>)}</p>}
          </Card>
          {Object.keys(hours).length > 0 && <Card title="Opening hours"><table className="hours"><tbody>{DAYS.map(([k, name]) => (
            <tr key={k}><th scope="row">{name}</th><td>{!hours[k] || hours[k].closed ? "Closed" : `${hours[k].open} – ${hours[k].close}`}</td></tr>))}</tbody></table></Card>}
          <AdStrip placement="business_profile" businessId={b.id} />
        </div>
      </div>
    </Section>
  );
}

export function PersonProfile() {
  const { slug = "" } = useParams(); const s = encodeURIComponent(slug);
  const { data, error, loading, reload } = useFetch<{ person: any }>(`/api/public/people/${s}`);
  const reviews = useFetch<{ reviews: any[] }>(data ? `/api/public/people/${s}/reviews?limit=5` : null);
  const p = data?.person;
  useSeo(p ? { title: `${p.name}${p.headline ? ` — ${p.headline}` : ""}`, description: p.bio?.slice(0, 160) || `${p.name}'s professional profile on Blinxot.`, path: `/p/${p.slug}`, image: p.avatarUrl, type: "profile",
    ld: { "@context": "https://schema.org", "@type": "Person", name: p.name, jobTitle: p.headline ?? undefined, description: p.bio ?? undefined, image: p.avatarUrl ? siteOrigin() + p.avatarUrl : undefined, knowsAbout: p.skills } }
    : { title: "Profile", noindex: true });
  if (loading) return <Loading />;
  if (!p) return error && error.status !== 404 ? <Section><ErrorState error={error} retry={reload} /></Section> : <NotFoundPublic what="profile" />;
  const span = (a: string, z: string | null) => `${date(a)} – ${z ? date(z) : "Present"}`;
  return (
    <Section>
      <div className="row biz-head"><Thumb src={p.avatarUrl} name={p.name} /><div className="grow"><h1>{p.name}</h1>{p.headline && <p className="lead">{p.headline}</p>}
        <p className="small muted">{[p.city, p.totalExperience !== "0 yrs 0 mos" ? p.totalExperience + " experience" : null].filter(Boolean).join(" · ")} {p.availability && <Badge tone="ok">{label(p.availability)}</Badge>}</p></div></div>
      <div className="stack">
        {p.bio && <Card title="About"><p style={{ whiteSpace: "pre-line" }}>{p.bio}</p></Card>}
        {p.skills.length > 0 && <Card title="Skills"><p className="chips">{p.skills.map((k: string) => <Badge key={k} tone="brand">{k}</Badge>)}</p></Card>}
        {p.experience.length > 0 && <Card title="Experience"><ul className="list">{p.experience.map((e: any) => <li key={e.id}><div><strong>{e.role}</strong> · {e.company}<br /><span className="small muted">{span(e.startDate, e.endDate)}</span>{e.responsibilities && <p className="small">{e.responsibilities}</p>}{e.achievements && <p className="small"><em>{e.achievements}</em></p>}</div></li>)}</ul></Card>}
        {p.education.length > 0 && <Card title="Education"><ul className="list">{p.education.map((e: any) => <li key={e.id}><div><strong>{e.degree || e.institution}</strong>{e.degree && <> · {e.institution}</>}<br /><span className="small muted">{[e.fieldOfStudy, [e.startYear, e.endYear].filter(Boolean).join(" – ")].filter(Boolean).join(" · ")}</span></div></li>)}</ul></Card>}
        {p.certifications.length > 0 && <Card title="Certifications"><ul className="list">{p.certifications.map((c: any) => <li key={c.id}><div><strong>{c.name}</strong>{c.issuer && <> · {c.issuer}</>}{c.issuedOn && <><br /><span className="small muted">Issued {date(c.issuedOn)}</span></>}</div></li>)}</ul></Card>}
        {p.projects.length > 0 && <Card title="Projects"><ul className="list">{p.projects.map((j: any) => <li key={j.id}><div><strong>{safeHref(j.url) ? <a href={safeHref(j.url)} target="_blank" rel="noopener noreferrer nofollow">{j.title}</a> : j.title}</strong>{j.description && <p className="small">{j.description}</p>}</div></li>)}</ul></Card>}
        <Card title="Reviews">{p.rating?.count ? <p><Stars value={p.rating.average} /> <span className="small muted">{p.rating.average} · {p.rating.count} review{p.rating.count === 1 ? "" : "s"}</span></p> : null}
          {reviews.data?.reviews.length ? <ul className="list">{reviews.data.reviews.map((r) => <li key={r.id} className="review"><div><Stars value={r.rating} /> <strong>{r.reviewer}</strong> {r.badge && <Badge tone="info">{r.badge}</Badge>}{r.body && <p>{r.body}</p>}</div></li>)}</ul> : <p className="muted">No reviews yet.</p>}</Card>
      </div>
    </Section>
  );
}

const WORK_TYPES = ["full_time", "part_time", "contract", "temporary", "internship", "freelance"];
const pay = (j: any) => (j.payMin == null && j.payMax == null ? null : `${j.payMin != null ? money(j.payMin, j.currency) : ""}${j.payMin != null && j.payMax != null ? " – " : ""}${j.payMax != null ? money(j.payMax, j.currency) : ""}${j.payPeriod ? ` / ${j.payPeriod}` : ""}`);

export function PublicJobs() {
  const { sp, set, offset } = useListParams(); const [q, setQ] = useState(sp.get("q") ?? ""); const dq = useDebounce(q, 350);
  useEffect(() => { if (dq !== (sp.get("q") ?? "")) set({ q: dq }); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [dq]);
  useSeo({ title: "Jobs and work opportunities", description: "Find jobs and work opportunities posted by businesses on Blinxot.", path: "/jobs", noindex: sp.size > 0 });
  const LIMIT = 10;
  const { data, error, loading, reload } = useFetch<{ total: number; jobs: any[] }>(`/api/public/jobs${qs({ q: sp.get("q") ?? "", location: sp.get("location"), workType: sp.get("workType"), remote: sp.get("remote") === "true", limit: LIMIT, offset })}`);
  return (
    <Section>
      <h1>Jobs and work opportunities</h1>
      <div className="filters">
        <div className="field"><label htmlFor="j-q">Search</label><input id="j-q" className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Job title or keyword" /></div>
        <div className="field"><label htmlFor="j-l">Location</label><input id="j-l" className="input" value={sp.get("location") ?? ""} onChange={(e) => set({ location: e.target.value })} /></div>
        <div className="field"><label htmlFor="j-t">Work type</label><select id="j-t" className="select" value={sp.get("workType") ?? ""} onChange={(e) => set({ workType: e.target.value })}><option value="">Any</option>{WORK_TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}</select></div>
        <label className="check"><input type="checkbox" checked={sp.get("remote") === "true"} onChange={(e) => set({ remote: e.target.checked ? "true" : undefined })} /> Remote only</label>
      </div>
      {error && <ErrorState error={error} retry={reload} />}
      {loading && !data ? <Spinner /> : data && (data.jobs.length === 0 ? <Card><Empty title="No open positions match">Try different keywords or clear the filters.</Empty></Card>
        : <div className="stack">{data.jobs.map((j) => (
            <Link key={j.id} to={`/jobs/${j.id}`} className="card tile"><Thumb src={j.business?.logoUrl} name={j.business?.name ?? j.title} /><div className="grow"><h2>{j.title}</h2><p className="small">{j.business?.name}</p>
              <p className="small muted"><Badge>{label(j.workType)}</Badge> {j.isRemote ? "Remote" : j.location}{pay(j) ? ` · ${pay(j)}` : ""}</p></div></Link>))}</div>)}
      {data && <Pagination total={data.total} limit={LIMIT} offset={offset} onChange={(o) => set({ offset: o })} />}
    </Section>
  );
}

export function PublicJobDetail() {
  const { id = "" } = useParams(); const { user } = useAuth(); const nav = useNavigate();
  const { data, error, loading } = useFetch<{ job: any }>(`/api/public/jobs/${encodeURIComponent(id)}`);
  const j = data?.job;
  useSeo(j ? { title: `${j.title} at ${j.business?.name ?? "Blinxot"}`, description: j.description?.slice(0, 160), path: `/jobs/${j.id}`, type: "article",
    ld: { "@context": "https://schema.org", "@type": "JobPosting", title: j.title, description: j.description, datePosted: j.publishedAt, validThrough: j.deadline ?? undefined, employmentType: j.workType?.toUpperCase(),
      hiringOrganization: { "@type": "Organization", name: j.business?.name }, jobLocationType: j.isRemote ? "TELECOMMUTE" : undefined, jobLocation: j.location ? { "@type": "Place", address: j.location } : undefined,
      baseSalary: j.payMin != null ? { "@type": "MonetaryAmount", currency: j.currency, value: { "@type": "QuantitativeValue", minValue: j.payMin, maxValue: j.payMax ?? undefined, unitText: (j.payPeriod ?? "month").toUpperCase() } } : undefined } }
    : { title: "Job", noindex: true });
  if (loading) return <Loading />;
  if (!j) return error && error.status !== 404 ? <Section><ErrorState error={error} /></Section> : <NotFoundPublic what="job" />;
  return (
    <Section>
      <nav className="crumbs" aria-label="Breadcrumb"><Link to="/jobs">Jobs</Link> / <span>{j.title}</span></nav>
      <div className="stack">
        <h1>{j.title}</h1>
        <p>{j.business && <Link to={`/b/${j.business.slug}`}>{j.business.name}</Link>} · <Badge>{label(j.workType)}</Badge> {j.isRemote ? "Remote" : j.location}{pay(j) ? ` · ${pay(j)}` : ""}{j.deadline ? ` · Apply by ${date(j.deadline)}` : ""}</p>
        {j.skills?.length > 0 && <p className="chips">{j.skills.map((k: string) => <Badge key={k} tone="brand">{k}</Badge>)}</p>}
        <Card title="Description"><p style={{ whiteSpace: "pre-line" }}>{j.description}</p></Card>
        {j.requirements && <Card title="Requirements"><p style={{ whiteSpace: "pre-line" }}>{j.requirements}</p></Card>}
        <div className="actions"><Button variant="primary" onClick={() => nav(user ? "/app/jobs" : "/login", { state: { from: "/app/jobs" } })}>{user ? "Apply in your account" : "Log in to apply"}</Button></div>
      </div>
    </Section>
  );
}
