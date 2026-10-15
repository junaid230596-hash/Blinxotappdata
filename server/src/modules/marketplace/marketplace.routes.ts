import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { isTest } from "../../config.js";
import { pool } from "../../db.js";
import { notFound } from "../../lib/errors.js";
import { pageQuery } from "../../lib/pagination.js";
import { escapeLike } from "../../lib/sql.js";
import { parse } from "../../middleware/validate.js";

// Public discovery. Exposes only opt-in listings of public businesses; never cost prices or exact stock.
export const marketplaceRouter = Router();
marketplaceRouter.use(rateLimit({ windowMs: 60_000, max: 120, skip: () => isTest, standardHeaders: true, legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "Too many requests. Please slow down." } } }));

const pubProduct = (r: any) => ({
  id: r.id, name: r.name, sku: r.sku, description: r.description, images: r.images, price: Number(r.selling_price),
  taxRate: Number(r.tax_rate), unit: r.unit, inStock: r.stock_qty > 0, categoryName: r.category_name ?? null,
  business: { id: r.business_id, name: r.business_name, slug: r.business_slug },
});
const PSEL = `SELECT p.*, c.name AS category_name, b.name AS business_name, b.slug AS business_slug FROM products p
                JOIN businesses b ON b.id=p.business_id AND b.is_public AND b.status='active' LEFT JOIN categories c ON c.id=p.category_id
               WHERE p.is_listed AND p.status='active'`;

marketplaceRouter.get("/businesses", async (req, res) => {
  const q = parse(pageQuery.extend({ q: z.string().trim().max(100).optional(), category: z.string().trim().max(80).optional() }), req.query);
  const where = ["b.is_public", "b.status='active'"]; const v: any[] = [];
  if (q.q) { v.push(`%${escapeLike(q.q)}%`); where.push(`(b.name ILIKE $${v.length} OR b.description ILIKE $${v.length})`); }
  if (q.category) { v.push(q.category); where.push(`lower(b.category)=lower($${v.length})`); }
  const w = where.join(" AND ");
  const { rows: t } = await pool.query(`SELECT count(*)::int AS n FROM businesses b WHERE ${w}`, v);
  v.push(q.limit, q.offset);
  const { rows } = await pool.query(
    `SELECT b.id, b.name, b.slug, b.description, b.category, b.logo_url,
            (SELECT count(*)::int FROM products p WHERE p.business_id=b.id AND p.is_listed AND p.status='active') AS listed_products
       FROM businesses b WHERE ${w} ORDER BY lower(b.name) LIMIT $${v.length - 1} OFFSET $${v.length}`, v);
  res.json({ total: t[0].n, businesses: rows.map((r) => ({ id: r.id, name: r.name, slug: r.slug, description: r.description, category: r.category,
    logoUrl: r.logo_url, listedProducts: r.listed_products })) });
});

marketplaceRouter.get("/products", async (req, res) => {
  const q = parse(pageQuery.extend({
    q: z.string().trim().max(100).optional(), businessId: z.string().uuid().optional(), category: z.string().trim().max(80).optional(),
    minPrice: z.coerce.number().min(0).optional(), maxPrice: z.coerce.number().min(0).optional(),
    sort: z.enum(["name", "price"]).optional(), dir: z.enum(["asc", "desc"]).optional(),
  }), req.query);
  const where: string[] = []; const v: any[] = [];
  if (q.q) { v.push(`%${escapeLike(q.q)}%`); where.push(`(p.name ILIKE $${v.length} OR p.description ILIKE $${v.length})`); }
  if (q.businessId) { v.push(q.businessId); where.push(`p.business_id=$${v.length}`); }
  if (q.category) { v.push(q.category); where.push(`lower(c.name::text)=lower($${v.length})`); }
  if (q.minPrice != null) { v.push(q.minPrice); where.push(`p.selling_price >= $${v.length}`); }
  if (q.maxPrice != null) { v.push(q.maxPrice); where.push(`p.selling_price <= $${v.length}`); }
  const extra = where.length ? ` AND ${where.join(" AND ")}` : "";
  const order = `${q.sort === "price" ? "p.selling_price" : "lower(p.name)"} ${q.dir === "desc" ? "DESC" : "ASC"}`;
  const { rows: t } = await pool.query(`SELECT count(*)::int AS n FROM (${PSEL}${extra}) x`, v);
  v.push(q.limit, q.offset);
  const { rows } = await pool.query(`${PSEL}${extra} ORDER BY ${order}, p.id LIMIT $${v.length - 1} OFFSET $${v.length}`, v);
  res.json({ total: t[0].n, products: rows.map(pubProduct) });
});

marketplaceRouter.get("/products/:id", async (req, res) => {
  const id = parse(z.string().uuid(), req.params.id);
  const { rows } = await pool.query(`${PSEL} AND p.id=$1`, [id]);
  if (!rows[0]) throw notFound();
  res.json({ product: pubProduct(rows[0]) });
});
