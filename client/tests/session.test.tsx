import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import fs from "node:fs";
import path from "node:path";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "../src/lib/auth";

const USER = { id: "u1", email: "me@example.com", fullName: "Me", accountType: "individual", emailVerified: true };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function Probe() {
  const a = useAuth(); const [msg, setMsg] = useState("");
  return <><button onClick={() => a.login("me@example.com", "pw").catch((e) => setMsg(e.message))}>go</button><p data-testid="msg">{msg}</p><p data-testid="who">{a.loading ? "loading" : a.user?.email ?? "anonymous"}</p></>;
}
afterEach(() => vi.restoreAllMocks());

describe("signing in when the session cookie may not stick", () => {
  it("tells the user, and does not enter the app, when the session cookie is not kept after login", async () => {
    let meCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const u = String(input);
      if (u.endsWith("/api/auth/login")) return json(200, { user: USER });          // the API accepted the password...
      if (u.endsWith("/api/auth/me")) { meCalls++; return json(401, { error: { code: "UNAUTHENTICATED", message: "Sign in required" } }); }   // ...but the browser never sends the cookie back
      return json(401, { error: { code: "UNAUTHENTICATED", message: "x" } });
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId("who")).toHaveTextContent("anonymous"));
    await userEvent.setup().click(screen.getByRole("button", { name: "go" }));
    expect(await screen.findByText(/session could not be kept/)).toBeInTheDocument();
    expect(screen.getByTestId("who")).toHaveTextContent("anonymous");               // not treated as signed in
    expect(meCalls).toBeGreaterThanOrEqual(2);
  });

  it("signs in normally when the session is kept", async () => {
    let signedIn = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const u = String(input);
      if (u.endsWith("/api/auth/login")) { signedIn = true; return json(200, { user: USER }); }
      if (u.endsWith("/api/auth/me")) return signedIn ? json(200, { user: USER }) : json(401, { error: { code: "UNAUTHENTICATED", message: "x" } });
      return json(404, {});
    });
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId("who")).toHaveTextContent("anonymous"));
    await userEvent.setup().click(screen.getByRole("button", { name: "go" }));
    await waitFor(() => expect(screen.getByTestId("who")).toHaveTextContent("me@example.com"));
    expect(screen.getByTestId("msg")).toHaveTextContent("");
  });
});

describe("vercel.json (frontend on Vercel, API on Render)", () => {
  const cfg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../vercel.json"), "utf8"));
  const rewrites: { source: string; destination: string }[] = cfg.rewrites;
  it("sends API, upload, sitemap and robots requests to the backend so the browser only ever talks to one domain (cookies then work)", () => {
    for (const s of ["/api/:path*", "/uploads/:path*", "/sitemap.xml", "/robots.txt"]) {
      const r = rewrites.find((x) => x.source === s); expect(r, s).toBeTruthy(); expect(r!.destination).toMatch(/^https:\/\/[a-z0-9.-]+\.onrender\.com\//);
    }
    expect(rewrites.find((x) => x.source === "/api/:path*")!.destination).toBe("https://blinxotappdata.onrender.com/api/:path*");
  });
  it("falls back to index.html for client-side routes, but only after the backend rewrites", () => {
    const i = rewrites.findIndex((x) => x.destination === "/index.html"); expect(i).toBe(rewrites.length - 1);
    expect(rewrites.slice(0, i).every((x) => x.destination.startsWith("https://"))).toBe(true);
  });
  it("keeps the service worker fresh, caches built assets forever, and sets security headers", () => {
    const h = (src: string) => Object.fromEntries((cfg.headers.find((x: any) => x.source === src)?.headers ?? []).map((x: any) => [x.key, x.value]));
    expect(h("/sw.js")["Cache-Control"]).toBe("no-cache"); expect(h("/assets/(.*)")["Cache-Control"]).toMatch(/immutable/);
    const all = h("/(.*)"); expect(all["X-Content-Type-Options"]).toBe("nosniff"); expect(all["Content-Security-Policy"]).toMatch(/connect-src 'self'/); expect(all["Content-Security-Policy"]).toMatch(/frame-ancestors 'none'/);
  });
});
