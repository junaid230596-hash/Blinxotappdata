# Progressive Web App

| Piece | File |
|---|---|
| Manifest (name, icons incl. maskable, shortcuts, scope, `id`) | `client/public/manifest.webmanifest` |
| Icons (192, 512, maskable 512, Apple touch 180, favicon) | `client/public/*.png`, `favicon.svg` |
| Service worker | `client/public/sw.js` (build id stamped by `vite.config.ts`) |
| Offline page | `client/public/offline.html` |
| Runtime (install + update state) | `client/src/lib/pwa.ts` |
| Popup, update bar, offline bar | `client/src/components/InstallPrompt.tsx` |

## One app, one icon
The custom popup never creates a shortcut or a second app. It captures the browser's own `beforeinstallprompt` event, and **Install app** calls `.prompt()` on it, so the browser performs the single manifest-based install. There is exactly one `<link rel="manifest">`, and the manifest has a stable `id`, so the browser treats every install as the same app.

States: already installed (standalone display mode or `appinstalled`) → nothing shown · native prompt available → popup with *Install app* / *Not now* (8 s after load, never on sign-in screens; "Not now" snoozes 14 days) · iOS Safari → instructions for Share → *Add to Home Screen* (iOS has no install API) · in-app browsers → "open in Safari" hint · unsupported browsers → nothing. A small *Install app* button also appears in the menu/footer when the browser can install.

## Caching and updates
Only the app shell and hashed `/assets/*` files are cached. `/api/*`, `/uploads/*` and anything personal are never cached. Pages load network-first, falling back to the cached shell, then `offline.html`. A new deploy installs the new worker in the background and **waits**; the app shows "A new version of Blinxot is ready — Update now", so a deploy never swaps code under someone filling in a form. Installed apps check for updates whenever they return to the foreground.

nginx must serve `sw.js` and the manifest with `Cache-Control: no-cache` (already in `deploy/nginx.conf`) and the site must use HTTPS.

## Manual checks (need real devices)
Android Chrome: install from the popup, confirm one icon, launches full-screen · iPhone Safari: follow the on-screen steps · desktop Chrome/Edge: install from popup and address-bar icon, confirm only one app · airplane mode: offline page / cached shell loads · deploy a new build and confirm the update bar appears.
