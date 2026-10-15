// Thin fetch wrapper: cookie sessions, CSRF header, one automatic refresh-and-retry on 401, and normalised errors.
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) { super(message); }
}

const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? "";
let fetchImpl: typeof fetch = (...a) => fetch(...a);
export const setFetch = (f: typeof fetch) => { fetchImpl = f; };       // tests inject a cookie-aware fetch

const AUTH_PATHS = ["/api/auth/login", "/api/auth/register", "/api/auth/refresh", "/api/auth/logout", "/api/auth/forgot-password", "/api/auth/reset-password", "/api/auth/verify-email"];
let refreshing: Promise<boolean> | null = null;

function refreshSession(): Promise<boolean> {
  refreshing ??= fetchImpl(`${BASE}/api/auth/refresh`, { method: "POST", credentials: "include", headers: { "X-Requested-With": "blinxot", "Content-Type": "application/json" }, body: "{}" })
    .then((r) => r.ok).catch(() => false).finally(() => { refreshing = null; });
  return refreshing;
}

async function send(method: string, path: string, body?: unknown, retry = true): Promise<Response> {
  const isForm = typeof FormData !== "undefined" && body instanceof FormData;
  let res: Response;
  try {
    res = await fetchImpl(`${BASE}${path}`, {
      method, credentials: "include",
      headers: { "X-Requested-With": "blinxot", ...(body !== undefined && !isForm ? { "Content-Type": "application/json" } : {}) },
      body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "NETWORK", "Cannot reach Blinxot. Check your connection and try again.");
  }
  if (res.status === 401 && retry && !AUTH_PATHS.includes(path.split("?")[0])) {
    if (await refreshSession()) return send(method, path, body, false);
    window.dispatchEvent(new Event("auth:expired"));
  }
  return res;
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await send(method, path, body);
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
  if (!res.ok) {
    const e = data?.error;
    throw new ApiError(res.status, e?.code ?? "ERROR", e?.message ?? "Something went wrong. Please try again.", e?.details);
  }
  return data as T;
}

export const get = <T = any>(path: string) => api<T>("GET", path);
export const post = <T = any>(path: string, body: unknown = {}) => api<T>("POST", path, body);
export const patch = <T = any>(path: string, body: unknown) => api<T>("PATCH", path, body);
export const put = <T = any>(path: string, body: unknown) => api<T>("PUT", path, body);
export const del = <T = any>(path: string) => api<T>("DELETE", path);

export async function uploadFile(file: File, businessId?: string): Promise<{ url: string }> {
  const fd = new FormData(); fd.append("file", file);
  return api("POST", `/api/uploads${businessId ? `?businessId=${businessId}` : ""}`, fd);
}

export const qs = (o: Record<string, unknown>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "" && v !== false) p.set(k, String(v));
  const s = p.toString(); return s ? `?${s}` : "";
};

/** Downloads a file the API serves behind authentication (reports, private documents) using the cookie session. */
export async function download(path: string, fallbackName: string): Promise<void> {
  const res = await send("GET", path);
  if (!res.ok) {
    let msg = "Could not download the file."; try { msg = (await res.json())?.error?.message ?? msg; } catch { /* keep default */ }
    throw new ApiError(res.status, "DOWNLOAD", msg);
  }
  const m = /filename="?([^";]+)"?/i.exec(res.headers.get("Content-Disposition") ?? "");
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a"); a.href = url; a.download = m?.[1] ?? fallbackName; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
