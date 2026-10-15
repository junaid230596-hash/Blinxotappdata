import { Router } from "express";
import { z } from "zod";
import { pool } from "../../db.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { requireAuth, requireBusinessAccess } from "../../middleware/auth.js";
import { parse } from "../../middleware/validate.js";
import { audit } from "../audit/audit.service.js";
import { toCsv, toPdf } from "./report.export.js";
import { catalog, isReport, reportNeeds, runReport } from "./report.service.js";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const iso = (d: Date) => d.toISOString().slice(0, 10);

export const reportRouter = Router({ mergeParams: true });
reportRouter.use(requireAuth);

reportRouter.get("/", requireBusinessAccess("reports.view"), (req, res) => res.json({ reports: catalog(req.permissions!) }));

reportRouter.get("/:type", requireBusinessAccess("reports.view"), async (req, res) => {
  const type = String(req.params.type);
  if (!isReport(type)) throw notFound("Unknown report");
  if (!reportNeeds(type)!.every((p) => req.permissions!.has(p))) throw forbidden();
  const q = parse(z.object({ from: date.optional(), to: date.optional(), format: z.enum(["json", "csv", "pdf"]).default("json") }), req.query);
  const to = q.to ?? iso(new Date()); const from = q.from ?? iso(new Date(Date.now() - 29 * 86_400_000));
  if (from > to) throw badRequest("The start date must be on or before the end date");
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 366) throw badRequest("Reports cover at most one year at a time");
  const businessId = String(req.params.businessId);
  const rep = await runReport(type, businessId, { from, to });
  if (q.format !== "json") await audit({ actorId: req.user!.id, businessId, action: "report.export", entity: "report", entityId: type, metadata: { format: q.format, from, to }, ip: req.ip });
  const file = `${type}_${from}_${to}`;
  if (q.format === "csv") {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${file}.csv"`);
    return void res.send(toCsv(rep));
  }
  if (q.format === "pdf") {
    const { rows } = await pool.query("SELECT name FROM businesses WHERE id=$1", [businessId]);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${file}.pdf"`);
    const doc = toPdf(rep, { business: rows[0].name, from, to });
    doc.pipe(res); doc.end();
    return;
  }
  res.json({ type, from, to, ...rep });
});
