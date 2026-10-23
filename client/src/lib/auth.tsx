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
    async login(email, password) {
      await post<{ user: User }>("/api/auth/login", { email, password });
      // Confirm the browser actually kept the session cookie before going to the dashboard; otherwise the next request would bounce back to the login page.
      try { const me = await get<{ user: User }>("/api/auth/me"); setUser(me.user); return me.user; }
      catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          console.error("Login succeeded but the session cookie was not sent back. If the API is on a different domain than this site, route /api through this site's own domain (see docs/DEPLOY-VERCEL-RENDER.md), and make sure cookies are allowed.");
          throw new Error("You signed in, but your session could not be kept. Please make sure cookies are allowed for this site and try again. If it keeps happening, contact support.");
        }
        throw e;
      }
    },
    async register(i) { await post("/api/auth/register", i); },
    async logout() { try { await post("/api/auth/logout"); } finally { setUser(null); localStorage.removeItem("bx_biz"); } },
  }), [user, loading, refreshUser]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
