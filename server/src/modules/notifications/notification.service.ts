import type { Db } from "../../db.js";
import { pool } from "../../db.js";

export async function notify(userId: string, n: { type: string; title: string; body?: string; data?: object }, db: Db = pool) {
  await db.query("INSERT INTO notifications (user_id, type, title, body, data) VALUES ($1,$2,$3,$4,$5)",
    [userId, n.type, n.title, n.body ?? null, n.data ?? {}]);
}

// Notifies every active member of a business whose role includes the given permission.
export async function notifyMembersWith(businessId: string, permission: string, n: { type: string; title: string; body?: string; data?: object }, exceptUserId?: string) {
  const { rows } = await pool.query(
    `SELECT DISTINCT m.user_id FROM business_members m JOIN role_permissions rp ON rp.role_id=m.role_id
      WHERE m.business_id=$1 AND m.status='active' AND rp.permission_key=$2`, [businessId, permission]);
  for (const r of rows) if (r.user_id !== exceptUserId) await notify(r.user_id, n);
}
