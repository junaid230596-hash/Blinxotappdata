import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import fs from "node:fs";
import path from "node:path";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pub = path.resolve(__dirname, "../public");
const UA = navigator.userAgent;
const setUA = (ua: string) => Object.defineProperty(navigator, "userAgent", { value: ua, configurable: true });
const setStandalone = (on: boolean) => { window.matchMedia = ((q: string) => ({ matches: on && q.includes("standalone"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as any; };

function installEvent(outcome: "accepted" | "dismissed" = "accepted") {
  const ev = new Event("beforeinstallprompt", { cancelable: true }) as any;
  ev.prompt = vi.fn(async () => {}); ev.userChoice = Promise.resolve({ outcome });
  return ev;
}
let Prompt: any, Offline: any;
/** A brand-new copy of the PWA modules (their state is module-level), wired to the window exactly as main.tsx does. */
async function fresh() { vi.resetModules(); const pwa = await import("../src/lib/pwa"); pwa.initPwa(); const m = await import("../src/components/InstallPrompt"); Prompt = m.InstallPrompt; Offline = m.OfflineBanner; }
const mount = (route = "/") => render(<MemoryRouter initialEntries={[route]}><Prompt /></MemoryRouter>);
const wait = async (ms = 8100) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

beforeEach(async () => { vi.useFakeTimers({ shouldAdvanceTime: true }); setStandalone(false); await fresh(); });
afterEach(() => { vi.useRealTimers(); setUA(UA); localStorage.clear(); });

describe("install popup", () => {
  it("stays hidden where the browser offers no install (unsupported browsers)", async () => {
    mount(); await wait();
    expect(screen.queryByRole("region", { name: "Install Blinxot" })).toBeNull();
  });

  it("appears after the page settles and triggers the browser's own install dialog exactly once", async () => {
    const ev = installEvent(); const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mount();
    act(() => { window.dispatchEvent(ev); });
    expect(ev.defaultPrevented).toBe(true);                                  // the browser's mini-infobar is replaced by our popup, not duplicated
    expect(screen.queryByRole("region", { name: "Install Blinxot" })).toBeNull();   // not immediately
    await wait();
    await user.click(await screen.findByRole("button", { name: "Install app" }));
    expect(ev.prompt).toHaveBeenCalledTimes(1);
    await wait(10);
    expect(screen.queryByRole("region", { name: "Install Blinxot" })).toBeNull();   // installed: gone
    mount(); await wait();
    expect(screen.queryByRole("button", { name: "Install app" })).toBeNull();       // the used event cannot be prompted again
  });

  it("remembers 'Not now' and does not nag again", async () => {
    const ev = installEvent("dismissed"); const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const a = mount(); act(() => { window.dispatchEvent(ev); }); await wait();
    await user.click(await screen.findByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("region", { name: "Install Blinxot" })).toBeNull();
    expect(localStorage.getItem("bx_install_dismissed_at")).not.toBeNull();
    a.unmount(); act(() => { window.dispatchEvent(installEvent()); });
    mount(); await wait();
    expect(screen.queryByRole("region", { name: "Install Blinxot" })).toBeNull();
  });

  it("never shows when already installed (standalone) or after the appinstalled event", async () => {
    setStandalone(true); act(() => { window.dispatchEvent(installEvent()); });
    const a = mount(); await wait();
    expect(screen.queryByRole("region", { name: "Install Blinxot" })).toBeNull(); a.unmount();
    setStandalone(false); act(() => { window.dispatchEvent(installEvent()); window.dispatchEvent(new Event("appinstalled")); });
    mount(); await wait();
    expect(screen.queryByRole("region", { name: "Install Blinxot" })).toBeNull();
  });

  it("does not interrupt sign-in forms", async () => {
    const ev = installEvent(); mount("/login"); act(() => { window.dispatchEvent(ev); }); await wait();
    expect(screen.queryByRole("region", { name: "Install Blinxot" })).toBeNull();
  });
});

describe("iOS", () => {
  it("explains Add to Home Screen (iOS has no install API) and offers no fake install button", async () => {
        setUA("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1");
    await fresh(); mount(); await wait();
    const box = await screen.findByRole("region", { name: "Install Blinxot" });
    expect(box.textContent).toMatch(/Add to Home Screen/);
    expect(screen.queryByRole("button", { name: "Install app" })).toBeNull();
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(screen.getByRole("button", { name: "Got it" }));
    expect(screen.queryByRole("region", { name: "Install Blinxot" })).toBeNull();
  });
});

describe("offline banner", () => {
  it("tells people when they lose and regain connection", async () => {
    render(<Offline />); expect(screen.queryByRole("status")).toBeNull();
    act(() => { window.dispatchEvent(new Event("offline")); });
    expect(await screen.findByRole("status")).toHaveTextContent(/offline/i);
    act(() => { window.dispatchEvent(new Event("online")); });
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("web app manifest and icons", () => {
  const m = JSON.parse(fs.readFileSync(path.join(pub, "manifest.webmanifest"), "utf8"));
  const png = (f: string) => { const b = fs.readFileSync(path.join(pub, f)); expect(b.subarray(1, 4).toString()).toBe("PNG"); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };

  it("is installable: names, standalone display, start URL inside scope, theme and splash colours", () => {
    expect(m).toMatchObject({ name: "Blinxot", short_name: "Blinxot", display: "standalone", scope: "/", id: "/app" });
    expect(m.start_url.startsWith("/app")).toBe(true);
    expect(m.theme_color).toMatch(/^#[0-9a-f]{6}$/i); expect(m.background_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(JSON.stringify(m)).not.toMatch(/Univora|Fynlo|Inventra|\{\{/);
  });
  it("ships real 192, 512 and maskable icons plus an Apple touch icon", () => {
    const by = (p: string, s: string) => m.icons.find((i: any) => i.purpose === p && i.sizes === s);
    expect(by("any", "192x192")).toBeTruthy(); expect(by("any", "512x512")).toBeTruthy(); expect(by("maskable", "512x512")).toBeTruthy();
    for (const i of m.icons) expect(png(i.src.slice(1))).toEqual(i.sizes.split("x").map(Number));
    expect(png("apple-touch-icon.png")).toEqual([180, 180]); expect(png("og-image.png")).toEqual([1200, 630]);
  });
  it("is linked exactly once from index.html (a second manifest would cause duplicate installs)", () => {
    const html = fs.readFileSync(path.resolve(__dirname, "../index.html"), "utf8");
    expect(html.match(/rel="manifest"/g)).toHaveLength(1);
    expect(html).toContain('href="/manifest.webmanifest"'); expect(html).toContain("apple-touch-icon");
  });
  it("shortcuts point at real in-scope routes", () => { for (const s of m.shortcuts) expect(s.url.startsWith("/app")).toBe(true); });
});

describe("service worker (run in a simulated worker scope)", () => {
  const src = fs.readFileSync(path.join(pub, "sw.js"), "utf8").replaceAll("__BUILD_ID__", "test");
  function boot(fetchImpl: (r: Request) => Promise<Response>) {
    const store = new Map<string, Map<string, Response>>(); const handlers: Record<string, (e: any) => void> = {};
    const key = (r: any) => (typeof r === "string" ? r : new URL(r.url).pathname);
    const caches = {
      open: async (n: string) => { const c = store.get(n) ?? new Map<string, Response>(); store.set(n, c); return { addAll: async (l: string[]) => { for (const u of l) c.set(u, new Response("x")); }, put: async (r: any, res: Response) => { c.set(key(r), res); }, match: async (r: any) => c.get(key(r))?.clone() }; },
      keys: async () => [...store.keys()], delete: async (n: string) => store.delete(n),
    };
    const self = { location: new URL("https://app.test/"), addEventListener: (t: string, h: any) => { handlers[t] = h; }, skipWaiting: vi.fn(), clients: { claim: vi.fn(async () => {}) } };
    new Function("self", "caches", "fetch", "Response", src)(self, caches, fetchImpl, Response);
    const run = async (type: string) => { let p: Promise<any> = Promise.resolve(); handlers[type]({ waitUntil: (x: Promise<any>) => { p = x; } }); await p; };
    const fetchEvent = (url: string, o: { mode?: string; method?: string } = {}) => { let res: Promise<Response> | undefined; const request = Object.assign(new Request(url, { method: o.method ?? "GET" }), { }); Object.defineProperty(request, "mode", { value: o.mode ?? "cors" }); handlers.fetch({ request, respondWith: (p: Promise<Response>) => { res = p; } }); return res; };
    return { self, store, handlers, run, fetchEvent };
  }
  const ok = (body = "ok", type = "text/html") => new Response(body, { headers: { "content-type": type } });

  it("precaches the shell on install but waits for the user before taking over", async () => {
    const w = boot(async () => ok()); await w.run("install");
    expect(w.store.get("bx-shell-test")!.has("/offline.html")).toBe(true);
    expect(w.self.skipWaiting).not.toHaveBeenCalled();
    w.handlers.message({ data: { type: "SKIP_WAITING" } }); expect(w.self.skipWaiting).toHaveBeenCalledTimes(1);
    w.handlers.message({ data: { type: "something-else" } }); expect(w.self.skipWaiting).toHaveBeenCalledTimes(1);
  });

  it("deletes caches from older builds on activate", async () => {
    const w = boot(async () => ok()); await w.store.set("bx-shell-old", new Map()); await w.store.set("unrelated", new Map());
    await w.run("activate");
    expect([...w.store.keys()].sort()).toEqual(["unrelated"]);                                 // only our own stale caches are removed
  });

  it("never touches API, upload or non-GET traffic", async () => {
    const calls: string[] = []; const w = boot(async (r) => { calls.push(r.url); return ok(); });
    for (const u of ["/api/me/profile", "/uploads/a.png", "/sitemap.xml", "/robots.txt"]) expect(w.fetchEvent(`https://app.test${u}`)).toBeUndefined();
    expect(w.fetchEvent("https://app.test/assets/x.js", { method: "POST" })).toBeUndefined();
    expect(w.fetchEvent("https://other.test/lib.js")).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("serves pages fresh from the network, then falls back to the cached shell, then the offline page", async () => {
    let online = true; const w = boot(async () => { if (!online) throw new Error("offline"); return ok("<html>fresh</html>"); });
    await w.run("install");
    expect(await (await w.fetchEvent("https://app.test/app/orders", { mode: "navigate" })!).text()).toBe("<html>fresh</html>");
    online = false;
    expect(await (await w.fetchEvent("https://app.test/app/orders", { mode: "navigate" })!).text()).toBe("<html>fresh</html>");   // cached shell
    w.store.get("bx-shell-test")!.delete("/index.html");
    expect(await (await w.fetchEvent("https://app.test/app/orders", { mode: "navigate" })!).text()).toBe("x");                     // offline.html
  });

  it("caches hashed build assets after the first load", async () => {
    let hits = 0; const w = boot(async () => { hits++; return ok("js", "text/javascript"); });
    await w.fetchEvent("https://app.test/assets/app-abc.js"); await w.fetchEvent("https://app.test/assets/app-abc.js");
    expect(hits).toBe(1);
  });
});
