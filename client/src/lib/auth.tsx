import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError, get, post } from "./api";

export interface User { id: string; email: string; fullName: string; accountType: "individual" | "business_owner" | "employee" | "supplier" | "super_admin"; emailVerified: boolean }
interface AuthState { user: User | null; loading: boolean; login(email: string, password: string): Promise<User>; register(i: { fullName: string; email: string; password: string; accountType: string }): Promise<void>; logout(): Promise<void>; refreshUser(): Promise<void> }
const Ctx = createContext<AuthState>(null as any);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshUser = useCallback(async () => {
    try { setUser((await get<{ user: User }>("/api/auth/me")).user); }
    catch (e) { if (e instanceof ApiError && e.status === 401) setUser(null); else throw e; }
  }, []);

  useEffect(() => { refreshUser().catch(() => setUser(null)).finally(() => setLoading(false)); }, [refreshUser]);
  useEffect(() => { const h = () => setUser(null); window.addEventListener("auth:expired", h); return () => window.removeEventListener("auth:expired", h); }, []);

  const value = useMemo<AuthState>(() => ({
    user, loading, refreshUser,
    async login(email, password) { const r = await post<{ user: User }>("/api/auth/login", { email, password }); setUser(r.user); return r.user; },
    async register(i) { await post("/api/auth/register", i); },
    async logout() { try { await post("/api/auth/logout"); } finally { setUser(null); localStorage.removeItem("bx_biz"); } },
  }), [user, loading, refreshUser]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
