import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { pool } from "../../db.js";
import { config } from "../../config.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { detectFileType, publicDir, saveFile } from "../../lib/upload.js";
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
  const name = await saveFile(publicDir, f.buffer, type.ext);
  await recordFile(businessId ?? null, req.user!.id, name, f.size, false);
  res.status(201).json({ url: `/uploads/${name}`, mime: type.mime, size: f.size });
});
