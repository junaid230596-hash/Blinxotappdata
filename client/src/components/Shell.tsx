import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { get, post } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useBusiness } from "../lib/business";
import { useToast } from "../lib/toast";
import { NAV } from "../nav";
import { InstallButton } from "./InstallPrompt";
import { Button, Logo } from "./ui";

export function Shell() {
  const { user, logout } = useAuth(); const biz = useBusiness(); const { toast } = useToast();
  const loc = useLocation(); const nav = useNavigate();
  const [open, setOpen] = useState(false); const [unread, setUnread] = useState(0);

  useEffect(() => { setOpen(false); }, [loc.pathname]);                                   // navigating closes the drawer
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", esc); document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", esc); document.body.style.overflow = ""; };
  }, [open]);
  useEffect(() => {
    let live = true;
    const poll = () => get<{ unreadCount: number }>("/api/notifications?unread=true&limit=1").then((r) => live && setUnread(r.unreadCount)).catch(() => {});
    poll(); const t = setInterval(poll, 60_000); return () => { live = false; clearInterval(t); };
  }, [loc.pathname]);

  if (!user) return null;
  const ctx = { user, can: biz.can, hasBusiness: !!biz.current };
  const groups = NAV.map((g) => ({ ...g, items: g.items.filter((i) => i.show(ctx)) })).filter((g) => g.items.length);

  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <header className="topbar">
        <Button variant="ghost" className="burger" aria-label={open ? "Close menu" : "Open menu"} aria-expanded={open} aria-controls="sidebar" onClick={() => setOpen((o) => !o)}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">{open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M3 6h18M3 12h18M3 18h18" />}</svg>
        </Button>
        <Link to="/app" className="brand"><Logo /><span>Blinxot</span></Link>
        <span className="spacer" />
        {biz.businesses.length > 1 && (
          <select className="select biz" aria-label="Switch business" value={biz.current?.id ?? ""} onChange={(e) => { biz.select(e.target.value); nav("/app"); }}>
            {biz.businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        )}
        {biz.businesses.length === 1 && <span className="hide-sm muted small">{biz.current?.name}</span>}
        <Link to="/app/notifications" className="btn btn-ghost bell" aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10 21a2 2 0 0 0 4 0" /></svg>
          {unread > 0 && <span className="dot" aria-hidden="true">{unread > 99 ? "99+" : unread}</span>}
        </Link>
        <span className="hide-sm small">{user.fullName}</span>
        <Button small onClick={async () => { await logout(); nav("/login"); }}>Log out</Button>
      </header>

      {!user.emailVerified && (
        <div className="banner" role="status" style={{ borderRadius: 0 }}>
          <span>Please verify your email address to unlock publishing and business features.</span>
          <Button small onClick={async () => { await post("/api/auth/resend-verification"); toast("Verification email sent"); }}>Resend email</Button>
        </div>
      )}

      <div className="shell">
        <aside id="sidebar" className={`sidebar ${open ? "open" : ""}`} aria-label="Sidebar">
          <nav className="nav" aria-label="Main">
            {groups.map((g, i) => (
              <div key={g.label ?? i}>
                {g.label && <h3>{g.label}</h3>}
                {g.items.map((it) => <NavLink key={it.to} to={it.to} end>{it.label}</NavLink>)}
              </div>
            ))}
          </nav>
          <div className="nav-foot"><InstallButton /></div>
        </aside>
        <div className={`scrim ${open ? "open" : ""}`} onClick={() => setOpen(false)} aria-hidden="true" />
        <main id="main" className="main" tabIndex={-1}><Outlet /></main>
      </div>
    </>
  );
}
