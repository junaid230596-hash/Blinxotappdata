import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { applyUpdate, dismissedRecently, dismissInstall, isInAppBrowser, isIos, isStandalone, promptInstall, usePwa } from "../lib/pwa";
import { Button, Logo } from "./ui";

const QUIET = ["/login", "/register", "/forgot-password", "/reset-password", "/verify-email"];     // never interrupt a form

/** Install state machine: installed -> nothing; native prompt available -> Install button; iOS Safari -> how-to; otherwise nothing (unsupported). */
export function InstallPrompt() {
  const pwa = usePwa(); const { pathname } = useLocation();
  const [ready, setReady] = useState(false); const [, bump] = useState(0);
  useEffect(() => { const t = setTimeout(() => setReady(true), 8000); return () => clearTimeout(t); }, []);   // let the page settle first

  const standalone = pwa.installed || isStandalone();
  const ios = isIos() && !pwa.deferred;
  const canShow = !standalone && (pwa.deferred || ios) && !dismissedRecently() && ready && !QUIET.includes(pathname);
  if (!canShow) return null;

  return (
    <section className="install" role="region" aria-label="Install Blinxot">
      <Logo size={40} />
      <div className="grow">
        <p className="install-title">Install Blinxot</p>
        {pwa.deferred
          ? <p className="small muted">Add it to your home screen for faster access, full-screen use and offline support.</p>
          : isInAppBrowser()
            ? <p className="small muted">Open this page in Safari first, then tap Share and choose “Add to Home Screen”.</p>
            : <p className="small muted">Tap the Share button <span aria-hidden="true">⎙</span> in Safari, then choose “Add to Home Screen”.</p>}
        <div className="actions">
          {pwa.deferred && <Button variant="primary" small onClick={async () => { await promptInstall(); bump((n) => n + 1); }}>Install app</Button>}
          <Button small onClick={() => { dismissInstall(); bump((n) => n + 1); }}>{pwa.deferred ? "Not now" : "Got it"}</Button>
        </div>
      </div>
    </section>
  );
}

/** Compact "Install app" entry for menus; only renders when the browser can really install. */
export function InstallButton() {
  const pwa = usePwa();
  if (!pwa.deferred || pwa.installed || isStandalone()) return null;
  return <Button small onClick={() => { void promptInstall(); }}>Install app</Button>;
}

export function UpdatePrompt() {
  const { updateReady } = usePwa();
  if (!updateReady) return null;
  return (
    <div className="update" role="status">
      <span>A new version of Blinxot is ready.</span>
      <Button small variant="primary" onClick={applyUpdate}>Update now</Button>
    </div>
  );
}

export function OfflineBanner() {
  const { online } = usePwa();
  if (online) return null;
  return <div className="offline-bar" role="status">You're offline. Changes can't be saved until you're back online.</div>;
}
