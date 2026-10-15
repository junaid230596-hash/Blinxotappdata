// PWA runtime: service-worker registration + update flow, and the install flow.
//
// Install design: the custom popup NEVER creates its own shortcut/app. It only holds on to the browser's own
// `beforeinstallprompt` event and calls `.prompt()` on it, so the browser/OS performs the one real, manifest-based install
// (one app, one icon). On iOS (no such event) we can only explain "Share -> Add to Home Screen".
import { useSyncExternalStore } from "react";

interface BeforeInstallPromptEvent extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> }
interface PwaState { deferred: BeforeInstallPromptEvent | null; installed: boolean; updateReady: boolean; online: boolean }

const DISMISS_KEY = "bx_install_dismissed_at";
const SNOOZE_MS = 14 * 86_400_000;

export const isStandalone = () =>
  typeof window !== "undefined" && ((typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches) || (navigator as any).standalone === true);
export const isIos = () => typeof navigator !== "undefined" && (/iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));
/** iOS can only add to the home screen from a real browser; embedded in-app browsers (Instagram, Facebook...) cannot. */
export const isInAppBrowser = () => typeof navigator !== "undefined" && /FBAN|FBAV|Instagram|Line\/|Snapchat|; wv\)/i.test(navigator.userAgent);

let state: PwaState = { deferred: null, installed: isStandalone(), updateReady: false, online: typeof navigator === "undefined" ? true : navigator.onLine };
const listeners = new Set<() => void>();
const set = (patch: Partial<PwaState>) => { state = { ...state, ...patch }; listeners.forEach((l) => l()); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const usePwa = () => useSyncExternalStore(subscribe, () => state, () => state);

export function dismissedRecently(): boolean {
  try { const t = Number(localStorage.getItem(DISMISS_KEY)); return !!t && Date.now() - t < SNOOZE_MS; } catch { return false; }
}
export function dismissInstall() { try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch { /* storage unavailable: popup simply may reappear */ } set({}); }

/** Triggers the browser's native install dialog. Returns what happened so the UI can react. */
export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const ev = state.deferred;
  if (!ev) return "unavailable";
  set({ deferred: null });                      // an event can be used only once
  try {
    await ev.prompt();
    const { outcome } = await ev.userChoice;
    if (outcome === "dismissed") dismissInstall(); else set({ installed: true });
    return outcome;
  } catch { return "unavailable"; }
}

let reg: ServiceWorkerRegistration | undefined;
let reloading = false;
export function applyUpdate() {
  const waiting = reg?.waiting;
  if (!waiting) { location.reload(); return; }
  waiting.postMessage({ type: "SKIP_WAITING" });      // controllerchange (below) then reloads once
}

function watch(r: ServiceWorkerRegistration) {
  const flag = () => { if (r.waiting && navigator.serviceWorker.controller) set({ updateReady: true }); };
  flag();
  r.addEventListener("updatefound", () => {
    const w = r.installing; if (!w) return;
    w.addEventListener("statechange", () => { if (w.state === "installed") flag(); });
  });
}

/** Call once at startup (main.tsx). Safe in unsupported browsers and in tests (does nothing outside production builds for the worker). */
export function initPwa() {
  if (typeof window === "undefined") return;
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); set({ deferred: e as BeforeInstallPromptEvent }); });
  window.addEventListener("appinstalled", () => set({ installed: true, deferred: null }));
  window.addEventListener("online", () => set({ online: true }));
  window.addEventListener("offline", () => set({ online: false }));
  if (typeof window.matchMedia === "function") window.matchMedia("(display-mode: standalone)").addEventListener?.("change", (e) => e.matches && set({ installed: true }));

  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (!reloading) { reloading = true; location.reload(); } });
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).then((r) => {
      reg = r; watch(r);
      // Long-lived installed apps rarely reload: look for a new version whenever the app comes back to the foreground.
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") r.update().catch(() => {}); });
    }).catch(() => { /* registration failure only disables offline support */ });
  });
}
