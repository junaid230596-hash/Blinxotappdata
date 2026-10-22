import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { pool } from "../../db.js";
import { config } from "../../config.js";
import { AppError, badRequest, notFound } from "../../lib/errors.js";
import { detectFileType, publicDir } from "../../lib/upload.js";
import { KEY_RE, MIME_BY_EXT, openFile, removeFile, storeFile } from "../../lib/storage.js";
import { requireAuth } from "../../middleware/auth.js";
import { parse } from "../../middleware/validate.js";
import { assertWithin, recordFile } from "../plans/plan.service.js";

export const uploadDir = publicDir;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 1 } });

// Public uploads (logos, product images, profile photos). Pass ?businessId= to count the file against that business's storage plan.
export const uploadRouter = Router();
uploadRouter.post("/", requireAuth, upload.single("file"), async (req, res) => {
  const f = req.file;
  if (!f) throw badRequest("No file uploaded (field name: file)");
  const type = detectFileType(f.buffer);
  if (!type) throw badRequest("Unsupported file type. Allowed: PNG, JPEG, WebP, PDF");
  const { businessId } = parse(z.object({ businessId: z.string().uuid().optional() }), req.query);
  if (businessId) {
    const { rows } = await pool.query("SELECT 1 FROM business_members WHERE business_id=$1 AND user_id=$2 AND status='active'", [businessId, req.user!.id]);
    if (!rows[0]) throw notFound();
    await assertWithin(businessId, "storageMb", f.size / 1048576);
  }
  const name = await storeFile("public", f.buffer, type.ext);
  try { await recordFile(businessId ?? null, req.user!.id, name, f.size, false); } catch (e) { await removeFile("public", name); throw e; }      // no orphaned file if the record fails
  res.status(201).json({ url: `/uploads/${name}`, mime: type.mime, size: f.size });
});

/** Serves public uploads from cloud storage (local storage uses express.static). Keys are random UUIDs so responses are immutable and cacheable for a year. */
export const uploadServeRouter = Router();
uploadServeRouter.get("/:key", async (req, res) => {
  const key = String(req.params.key);
  const file = KEY_RE.test(key) ? await openFile("public", key).catch(() => { throw new AppError(502, "STORAGE_UNAVAILABLE", "File storage is temporarily unavailable."); }) : null;
  if (!file) throw notFound("File not found");
  const ext = key.slice(key.lastIndexOf("."));
  res.setHeader("Content-Type", MIME_BY_EXT[ext]); res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Content-Disposition", "inline");
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  if (file.size != null) res.setHeader("Content-Length", String(file.size)); if (file.etag) res.setHeader("ETag", file.etag);
  file.stream.on("error", () => res.destroy()); file.stream.pipe(res);
});
