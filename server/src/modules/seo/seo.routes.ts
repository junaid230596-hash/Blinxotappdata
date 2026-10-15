import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import { config } from "../../config.js";
import { pool } from "../../db.js";
import { AppError } from "../../lib/errors.js";
import { sendMail } from "../../lib/email.js";
import { publicLimiter } from "../../lib/limits.js";
import { body } from "../../middleware/validate.js";
import { allSettings } from "../settings/settings.service.js";

export const siteOrigin = () => (config.SITE_URL ?? config.APP_URL).replace(/\/+$/, "");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Public pages that exist as client routes (must match client/src/App.tsx). */
export const STATIC_PAGES: [path: string, priority: string][] = [
  ["/", "1.0"], ["/features", "0.8"], ["/pricing", "0.8"], ["/about", "0.5"], ["/contact", "0.5"],
  ["/discover", "0.8"], ["/products", "0.7"], ["/jobs", "0.7"],
];
const SITEMAP_LIMIT = 5000;           // per entity type; the protocol allows 50,000 URLs per file

export const seoRouter = Router();
seoRouter.use(publicLimiter(300));          // crawlers and shared links hit these; keep it generous

seoRouter.get("/robots.txt", (_req, res) => {
  res.type("text/plain").send([
    "User-agent: *",
    "Allow: /",
    "Disallow: /app",
    "Disallow: /api/",
    "Disallow: /uploads/",
    "Disallow: /login",
    "Disallow: /register",
    "Disallow: /forgot-password",
    "Disallow: /reset-password",
    "Disallow: /verify-email",
    "",
    `Sitemap: ${siteOrigin()}/sitemap.xml`, "",
  ].join("\n"));
});

seoRouter.get("/sitemap.xml", async (_req, res) => {
  const o = siteOrigin();
  const [biz, prod, ppl] = await Promise.all([
    pool.query(`SELECT slug, updated_at FROM businesses WHERE is_public AND status='active' ORDER BY updated_at DESC LIMIT ${SITEMAP_LIMIT}`),
    pool.query(`SELECT p.id, p.updated_at FROM products p JOIN businesses b ON b.id=p.business_id AND b.is_public AND b.status='active'
                 WHERE p.is_listed AND p.status='active' ORDER BY p.updated_at DESC LIMIT ${SITEMAP_LIMIT}`),
    pool.query(`SELECT slug, updated_at FROM profiles WHERE is_public AND slug IS NOT NULL ORDER BY updated_at DESC LIMIT ${SITEMAP_LIMIT}`),
  ]);
  const url = (loc: string, extra = "") => `<url><loc>${esc(o + loc)}</loc>${extra}</url>`;
  const mod = (d: Date | null) => (d ? `<lastmod>${d.toISOString().slice(0, 10)}</lastmod>` : "");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` + [
    ...STATIC_PAGES.map(([p, pr]) => url(p, `<priority>${pr}</priority>`)),
    ...biz.rows.map((r) => url(`/b/${encodeURIComponent(r.slug)}`, mod(r.updated_at))),
    ...prod.rows.map((r) => url(`/products/${r.id}`, mod(r.updated_at))),
    ...ppl.rows.map((r) => url(`/p/${encodeURIComponent(r.slug)}`, mod(r.updated_at))),
  ].join("\n") + "\n</urlset>\n";
  res.type("application/xml").set("Cache-Control", "public, max-age=3600").send(xml);
});

// ---- Per-page meta for link previews and non-JS crawlers -------------------------------------------------------
// The client is a single-page app, so shared links would otherwise show the home page's preview. For the three public
// entity pages the API returns the built index.html with that page's title/description/OG tags filled in; the React app
// then takes over exactly as before. Needs CLIENT_DIST (the built client folder) and nginx routing these paths here.
let shell: { html: string; at: number } | null = null;
function loadShell(): string | null {
  if (!config.CLIENT_DIST) return null;
  if (shell && Date.now() - shell.at < 60_000) return shell.html;
  try { shell = { html: fs.readFileSync(path.resolve(config.CLIENT_DIST, "index.html"), "utf8"), at: Date.now() }; return shell.html; } catch { return null; }
}
const attr = (s: string) => esc(s.replace(/\s+/g, " ").trim());
export interface PageMeta { title: string; description: string; path: string; image?: string | null; noindex?: boolean; type?: string }
export function injectMeta(html: string, m: PageMeta): string {
  const o = siteOrigin(); const title = attr(`${m.title} · Blinxot`); const desc = attr(m.description.slice(0, 200));
  const img = m.image ? (m.image.startsWith("http") ? m.image : o + m.image) : `${o}/og-image.png`;
  const cleaned = html
    .replace(/<title>[\s\S]*?<\/title>/i, "")
    .replace(/<meta\s+(?:name="(?:description|robots|twitter:title|twitter:description|twitter:image)"|property="(?:og:title|og:description|og:url|og:image|og:type)")[^>]*>\s*/gi, "")
    .replace(/<link\s+rel="canonical"[^>]*>\s*/gi, "");
  const tags = [
    `<title>${title}</title>`, `<meta name="description" content="${desc}" />`, `<meta name="robots" content="${m.noindex ? "noindex, nofollow" : "index, follow"}" />`,
    ...(m.noindex ? [] : [`<link rel="canonical" href="${esc(o + m.path)}" />`, `<meta property="og:url" content="${esc(o + m.path)}" />`]),
    `<meta property="og:type" content="${m.type ?? "website"}" />`, `<meta property="og:title" content="${title}" />`, `<meta property="og:description" content="${desc}" />`, `<meta property="og:image" content="${esc(img)}" />`,
    `<meta name="twitter:title" content="${title}" />`, `<meta name="twitter:description" content="${desc}" />`, `<meta name="twitter:image" content="${esc(img)}" />`,
  ].join("\n    ");
  return cleaned.replace("</head>", `    ${tags}\n  </head>`);
}
const NOT_FOUND_META: PageMeta = { title: "Not found", description: "This page could not be found.", path: "/", noindex: true };

function pageRoute(route: string, find: (req: any) => Promise<PageMeta | null>) {
  seoRouter.get(route, async (req, res, next) => {
    const html = loadShell();
    if (!html) return next();                                     // no built client configured (development): fall through
    const meta = await find(req).catch(() => null);
    res.status(meta ? 200 : 404).type("html").set("Cache-Control", "no-cache").send(injectMeta(html, meta ?? NOT_FOUND_META));
  });
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
pageRoute("/b/:slug", async (req) => {
  const { rows } = await pool.query("SELECT name, slug, description, category, logo_url FROM businesses WHERE slug=$1 AND is_public AND status='active'", [req.params.slug]);
  const b = rows[0]; return b ? { title: b.name, description: b.description || `${b.name}${b.category ? `, ${b.category}` : ""} on Blinxot — products, contact details and reviews.`, path: `/b/${encodeURIComponent(b.slug)}`, image: b.logo_url, type: "profile" } : null;
});
pageRoute("/products/:id", async (req) => {
  if (!UUID.test(req.params.id)) return null;
  const { rows } = await pool.query(`SELECT p.id, p.name, p.description, p.images, b.name AS business FROM products p JOIN businesses b ON b.id=p.business_id AND b.is_public AND b.status='active' WHERE p.id=$1 AND p.is_listed AND p.status='active'`, [req.params.id]);
  const p = rows[0]; return p ? { title: p.name, description: p.description || `${p.name} from ${p.business} on Blinxot.`, path: `/products/${p.id}`, image: Array.isArray(p.images) ? p.images[0] : null, type: "article" } : null;
});
pageRoute("/p/:slug", async (req) => {
  const { rows } = await pool.query("SELECT p.slug, p.headline, p.bio, p.avatar_url, u.full_name FROM profiles p JOIN users u ON u.id=p.user_id WHERE p.slug=$1 AND p.is_public", [req.params.slug]);
  const p = rows[0]; return p ? { title: `${p.full_name}${p.headline ? ` — ${p.headline}` : ""}`, description: p.bio || `${p.full_name}'s professional profile on Blinxot.`, path: `/p/${encodeURIComponent(p.slug)}`, image: p.avatar_url, type: "profile" } : null;
});

// Small public facts the marketing site needs (never anything private).
export const siteRouter = Router();
siteRouter.get("/site", publicLimiter(60), async (_req, res) => {
  const s = await allSettings();
  res.json({ supportEmail: s.support_email, registrationOpen: s.registration_open });
});

// Contact form: emails the configured support address. Abuse controls: strict per-IP limit, honeypot field, single-line header fields.
const oneLine = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\r\n]+$/, "Must be a single line");
siteRouter.post("/contact", publicLimiter(5), body(z.object({
  name: oneLine(100), email: z.string().trim().email().max(254), message: z.string().trim().min(10, "Please write a little more").max(4000),
  website: z.string().max(200).optional(),                       // honeypot: real people never fill it in
})), async (req, res) => {
  if (req.body.website) return void res.json({ ok: true });      // pretend success to bots
  const to = (await allSettings()).support_email as string | null;
  if (!to) throw new AppError(503, "CONTACT_UNAVAILABLE", "Contact is not available right now. Please try again later.");
  await sendMail({ to, replyTo: req.body.email, subject: `Blinxot contact form: ${req.body.name}`, text: `From: ${req.body.name} <${req.body.email}>\n\n${req.body.message}` });
  res.status(201).json({ ok: true });
});

