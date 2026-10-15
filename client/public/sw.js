/* Blinxot service worker.
 *  - Caches only the static app shell and hashed build assets. API responses, uploads and anything user-specific are NEVER cached.
 *  - Updates: a new worker installs in the background and WAITS; the app shows "Update available" and sends SKIP_WAITING when the user agrees,
 *    so a deploy never swaps code under someone who is halfway through a form.
 *  - __BUILD_ID__ is replaced at build time (vite.config.ts) so every deploy gets fresh caches and old ones are deleted on activate. */
const BUILD = "__BUILD_ID__";
const SHELL_CACHE = `bx-shell-${BUILD}`;
const ASSET_CACHE = `bx-assets-${BUILD}`;
const PRECACHE = ["/offline.html", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/favicon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(PRECACHE)));      // no skipWaiting(): the page decides when to switch
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, ASSET_CACHE]);
    for (const k of await caches.keys()) if (k.startsWith("bx-") && !keep.has(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => { if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting(); });

const NEVER_CACHE = [/^\/api\//, /^\/uploads\//, /^\/sitemap\.xml$/, /^\/robots\.txt$/, /^\/sw\.js$/];

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || NEVER_CACHE.some((re) => re.test(url.pathname))) return;   // browser handles it normally

  // Page loads: network first (always fresh), fall back to the cached shell, then the offline page.
  if (req.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok && (res.headers.get("content-type") || "").includes("text/html")) {
          const cache = await caches.open(SHELL_CACHE); cache.put("/index.html", res.clone());
        }
        return res;
      } catch {
        const cache = await caches.open(SHELL_CACHE);
        return (await cache.match("/index.html")) || (await cache.match("/offline.html")) || Response.error();
      }
    })());
    return;
  }

  // Hashed build output never changes for a given URL: cache first.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith((async () => {
      const cache = await caches.open(ASSET_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    })());
    return;
  }

  // Icons, manifest, etc.: serve the cached copy immediately, refresh it in the background.
  event.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const hit = await cache.match(req);
    const refresh = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => hit);
    return hit || refresh;
  })());
});
