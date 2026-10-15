import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, qs, setFetch } from "../src/lib/api";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
beforeEach(() => setFetch((...a) => fetch(...a)));

describe("api client", () => {
  it("sends credentials, the CSRF header and JSON, and returns parsed data", async () => {
    const f = vi.fn(async () => json(200, { ok: 1 })); setFetch(f as any);
    expect(await api("POST", "/api/things", { a: 1 })).toEqual({ ok: 1 });
    const [url, init] = f.mock.calls[0] as any;
    expect(url).toBe("/api/things"); expect(init.credentials).toBe("include"); expect(init.headers["X-Requested-With"]).toBe("blinxot"); expect(init.headers["Content-Type"]).toBe("application/json"); expect(init.body).toBe('{"a":1}');
  });

  it("normalises server errors, including field details", async () => {
    setFetch((async () => json(400, { error: { code: "BAD_REQUEST", message: "Validation failed", details: { sku: "Required" } } })) as any);
    const e = await api("POST", "/x", {}).catch((x) => x);
    expect(e).toBeInstanceOf(ApiError); expect(e).toMatchObject({ status: 400, code: "BAD_REQUEST", message: "Validation failed", details: { sku: "Required" } });
    setFetch((async () => new Response("<html>gateway</html>", { status: 502 })) as any);
    expect(await api("GET", "/x").catch((x) => x)).toMatchObject({ status: 502, message: expect.stringMatching(/Something went wrong/) });   // non-JSON failures stay friendly
  });

  it("reports a network failure clearly", async () => {
    setFetch((async () => { throw new TypeError("Failed to fetch"); }) as any);
    expect(await api("GET", "/x").catch((x) => x)).toMatchObject({ status: 0, code: "NETWORK", message: expect.stringMatching(/Cannot reach Blinxot/) });
  });

  it("refreshes an expired session once and retries, even when several requests fail together", async () => {
    let fresh = false; let refreshes = 0;
    setFetch((async (url: string) => {
      if (url === "/api/auth/refresh") { refreshes++; await new Promise((r) => setTimeout(r, 20)); fresh = true; return json(200, {}); }
      return fresh ? json(200, { url }) : json(401, { error: { code: "UNAUTHORIZED", message: "Authentication required" } });
    }) as any);
    const out = await Promise.all([api("GET", "/api/a"), api("GET", "/api/b"), api("GET", "/api/c")]);
    expect(out.map((o: any) => o.url)).toEqual(["/api/a", "/api/b", "/api/c"]); expect(refreshes).toBe(1);
  });

  it("signals session expiry when refreshing fails, and never loops", async () => {
    const calls: string[] = []; const expired = vi.fn(); window.addEventListener("auth:expired", expired);
    setFetch((async (url: string) => { calls.push(url); return json(401, { error: { code: "UNAUTHORIZED", message: "Authentication required" } }); }) as any);
    const e = await api("GET", "/api/me").catch((x) => x);
    expect(e).toMatchObject({ status: 401 }); expect(expired).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["/api/me", "/api/auth/refresh"]);
    window.removeEventListener("auth:expired", expired);
  });

  it("does not try to refresh for login-style endpoints (a 401 there just means wrong credentials)", async () => {
    const calls: string[] = [];
    setFetch((async (url: string) => { calls.push(url); return json(401, { error: { code: "UNAUTHORIZED", message: "Invalid email or password" } }); }) as any);
    expect(await api("POST", "/api/auth/login", {}).catch((x) => x)).toMatchObject({ message: "Invalid email or password" });
    expect(calls).toEqual(["/api/auth/login"]);
  });

  it("builds query strings without empty values", () => {
    expect(qs({ q: "rice", status: "", page: 0, low: false, tag: undefined, n: null, ok: true })).toBe("?q=rice&page=0&ok=true");
    expect(qs({})).toBe(""); expect(qs({ q: "a&b c" })).toBe("?q=a%26b+c");
  });
});
