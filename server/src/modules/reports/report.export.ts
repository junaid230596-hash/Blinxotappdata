import PDFDocument from "pdfkit";
import type { Report } from "./report.service.js";

// Spreadsheet apps execute cells beginning with = + - @ as formulas, so untrusted text is neutralised.
const guard = (s: string) => (/^[=+\-@\t\r]/.test(s) ? `'${s}` : s);
const csvCell = (v: unknown): string => {
  const s = typeof v === "number" ? String(v) : guard(String(v ?? ""));
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(r: Report): string {
  const lines = [r.columns.map((c) => csvCell(c.label)).join(",")];
  for (const row of r.rows) lines.push(r.columns.map((c) => csvCell(row[c.key])).join(","));
  if (r.summary) { lines.push(""); for (const [k, v] of Object.entries(r.summary)) lines.push(`${csvCell(k)},${csvCell(v)}`); }
  return "\ufeff" + lines.join("\r\n") + "\r\n";      // BOM so Excel reads UTF-8 (₹, accents) correctly
}

const fmt = (v: any, type: string) => {
  if (v == null || v === "") return "";
  if (type === "money") return Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (type === "percent") return `${v}%`;
  return String(v);
};

export function toPdf(r: Report, meta: { business: string; from?: string; to?: string }): InstanceType<typeof PDFDocument> {
  const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 32, info: { Title: r.title, Producer: "Blinxot" } });
  const width = doc.page.width - 64;
  const weights = r.columns.map((c) => (c.type === "text" ? 2.4 : 1.2));
  const total = weights.reduce((a, b) => a + b, 0);
  const widths = weights.map((w) => (w / total) * width);
  const rowH = 18;

  const header = () => {
    let x = 32; const y = doc.y;
    doc.rect(32, y, width, rowH).fill("#1f2937");
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(8);
    r.columns.forEach((c, i) => { doc.text(c.label, x + 4, y + 5, { width: widths[i] - 8, height: rowH, lineBreak: false, ellipsis: true, align: ["text", "date"].includes(c.type) ? "left" : "right" }); x += widths[i]; });
    doc.fillColor("#000000").font("Helvetica").y = y + rowH;
  };

  doc.font("Helvetica-Bold").fontSize(16).text(r.title);
  doc.font("Helvetica").fontSize(9).fillColor("#555555").text(`${meta.business}${meta.from ? `  |  ${meta.from} to ${meta.to}` : ""}  |  Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`).fillColor("#000000").moveDown(0.8);
  header();
  r.rows.forEach((row, n) => {
    if (doc.y + rowH > doc.page.height - 48) { doc.addPage(); header(); }
    const y = doc.y; let x = 32;
    if (n % 2) doc.rect(32, y, width, rowH).fill("#f3f4f6").fillColor("#000000");
    doc.fontSize(8);
    r.columns.forEach((c, i) => { doc.text(fmt(row[c.key], c.type), x + 4, y + 5, { width: widths[i] - 8, height: rowH, lineBreak: false, ellipsis: true, align: ["text", "date"].includes(c.type) ? "left" : "right" }); x += widths[i]; });
    doc.y = y + rowH;
  });
  if (!r.rows.length) doc.moveDown().fontSize(10).text("No data for this period.", 32);
  if (r.summary) {
    doc.moveDown(1).font("Helvetica-Bold").fontSize(10).text("Summary", 32);
    doc.font("Helvetica").fontSize(9);
    for (const [k, v] of Object.entries(r.summary)) doc.text(`${k.replace(/([A-Z])/g, " $1").replace(/_/g, " ").toLowerCase()}: ${typeof v === "number" ? v.toLocaleString("en-IN") : v}`, 32);
  }
  return doc;
}
