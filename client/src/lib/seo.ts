import { useEffect } from "react";

const SITE = "Blinxot";
const DEFAULT_DESC = "Blinxot is a business and work-management platform: inventory, orders, purchasing, attendance, CRM, jobs and reports in one place.";
export const siteOrigin = () => ((import.meta.env.VITE_SITE_URL as string | undefined) || window.location.origin).replace(/\/+$/, "");

function meta(attr: "name" | "property", key: string, content: string | null) {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
  if (content === null) { el?.remove(); return; }
  if (!el) { el = document.createElement("meta"); el.setAttribute(attr, key); document.head.appendChild(el); }
  el.setAttribute("content", content);
}
function canonical(href: string | null) {
  let el = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (href === null) { el?.remove(); return; }
  if (!el) { el = document.createElement("link"); el.rel = "canonical"; document.head.appendChild(el); }
  el.href = href;
}
function jsonLd(data: unknown) {
  document.getElementById("bx-jsonld")?.remove();
  if (!data) return;
  const s = document.createElement("script"); s.type = "application/ld+json"; s.id = "bx-jsonld";
  s.textContent = JSON.stringify(data).replace(/</g, "\\u003c");           // cannot close the script tag early
  document.head.appendChild(s);
}

export interface Seo { title: string; description?: string; path?: string; image?: string | null; noindex?: boolean; ld?: unknown; type?: "website" | "article" | "profile" }

/** Sets title, description, canonical, Open Graph, Twitter and JSON-LD for the current page; restores neutral defaults on leave. */
export function useSeo(s: Seo) {
  const key = JSON.stringify([s.title, s.description, s.path, s.image, s.noindex, s.ld, s.type]);
  useEffect(() => {
    const full = s.title === SITE ? `${SITE} — Business and work management` : `${s.title} · ${SITE}`;
    const desc = (s.description ?? DEFAULT_DESC).slice(0, 300);
    const url = s.path ? siteOrigin() + s.path : null;
    const img = s.image ? (s.image.startsWith("http") ? s.image : siteOrigin() + s.image) : `${siteOrigin()}/og-image.png`;
    document.title = full;
    meta("name", "description", desc);
    meta("name", "robots", s.noindex ? "noindex, nofollow" : "index, follow");
    canonical(s.noindex ? null : url);
    meta("property", "og:title", full); meta("property", "og:description", desc); meta("property", "og:type", s.type ?? "website");
    meta("property", "og:url", s.noindex ? null : url); meta("property", "og:image", img);
    meta("name", "twitter:title", full); meta("name", "twitter:description", desc); meta("name", "twitter:image", img);
    jsonLd(s.ld);
    // Leaving a page: drop its page-specific tags. Anything that does not call useSeo again (the signed-in app) stays noindex.
    return () => { jsonLd(null); canonical(null); meta("property", "og:url", null); meta("name", "robots", "noindex, nofollow"); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
