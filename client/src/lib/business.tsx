import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { get } from "./api";
import { useAuth } from "./auth";

export interface BizSummary { id: string; name: string; slug: string; role: string; logoUrl?: string | null }
interface BizState {
  businesses: BizSummary[]; current: BizSummary | null; permissions: Set<string>; loading: boolean; permissionsReady: boolean;
  select(id: string): void; reload(): Promise<void>; can(...perms: string[]): boolean;
}
const Ctx = createContext<BizState>(null as any);
export const useBusiness = () => useContext(Ctx);

export function BusinessProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [businesses, setBusinesses] = useState<BizSummary[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(() => localStorage.getItem("bx_biz"));
  const [permissions, setPermissions] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [readyFor, setReadyFor] = useState<string | null>(null);   // the user:business pair whose permissions have been loaded

  const reload = useCallback(async () => {
    if (!user) { setBusinesses([]); setPermissions(new Set()); setLoading(false); return; }
    const list = (await get<{ businesses: BizSummary[] }>("/api/businesses/mine")).businesses;
    setBusinesses(list);
    setCurrentId((id) => (list.some((b) => b.id === id) ? id : list[0]?.id ?? null));
    if (!list.length) setPermissions(new Set());
    setLoading(false);
  }, [user]);

  useEffect(() => { setLoading(true); reload().catch(() => setLoading(false)); }, [reload]);

  // Permissions belong to (user, business). Load them only for a signed-in user, and again whenever either changes
  // (a stale saved business id must not trigger a request before login completes, and must not keep the empty result afterwards).
  const key = user && currentId ? `${user.id}:${currentId}` : null;
  useEffect(() => {
    if (!key || !currentId) { setPermissions(new Set()); return; }
    localStorage.setItem("bx_biz", currentId);
    let live = true;
    get<{ permissions: string[] }>(`/api/businesses/${currentId}`)
      .then((r) => { if (live) { setPermissions(new Set(r.permissions)); setReadyFor(key); } })
      .catch(() => { if (live) { setPermissions(new Set()); setReadyFor(key); } });
    return () => { live = false; };
  }, [key, currentId]);

  const value = useMemo<BizState>(() => ({
    businesses, current: businesses.find((b) => b.id === currentId) ?? null, permissions, loading, permissionsReady: !key || readyFor === key,
    select: setCurrentId, reload, can: (...p) => p.every((x) => permissions.has(x)),
  }), [businesses, currentId, permissions, loading, readyFor, reload]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
