import { Router } from "express";
import { z } from "zod";
import { pool } from "../../db.js";
import { requireAuth } from "../../middleware/auth.js";
import { parse } from "../../middleware/validate.js";
import { notFound } from "../../lib/errors.js";

export const notificationRouter = Router();
notificationRouter.use(requireAuth);

notificationRouter.get("/", async (req, res) => {
  const q = parse(z.object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
    unread: z.enum(["true", "false"]).optional(),
  }), req.query);
  const { rows } = await pool.query(
    `SELECT id, type, title, body, data, read_at, created_at FROM notifications
      WHERE user_id=$1 AND ($2::boolean IS NOT TRUE OR read_at IS NULL)
      ORDER BY created_at DESC LIMIT $3 OFFSET $4`, [req.user!.id, q.unread === "true", q.limit, q.offset]);
  const { rows: c } = await pool.query("SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND read_at IS NULL", [req.user!.id]);
  res.json({ notifications: rows, unreadCount: c[0].n });
});

notificationRouter.post("/read-all", async (req, res) => {
  await pool.query("UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL", [req.user!.id]);
  res.json({ ok: true });
});

notificationRouter.post("/:id/read", async (req, res) => {
  const id = parse(z.string().uuid(), req.params.id);
  const { rowCount } = await pool.query("UPDATE notifications SET read_at=COALESCE(read_at, now()) WHERE id=$1 AND user_id=$2", [id, req.user!.id]);
  if (!rowCount) throw notFound();
  res.json({ ok: true });
});
