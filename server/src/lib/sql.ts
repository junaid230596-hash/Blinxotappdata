import type { PoolClient } from "pg";
import type { Db } from "../db.js";

// Builds "col=$n" fragments from a camelCase patch and a whitelist map (never interpolates values).
export function buildSets(map: Record<string, string>, patch: Record<string, any>, startAt = 0) {
  const sets: string[] = []; const vals: any[] = [];
  for (const [k, col] of Object.entries(map)) {
    if (k in patch) { vals.push(patch[k] === "" ? null : patch[k]); sets.push(`${col}=$${startAt + vals.length}`); }
  }
  return { sets, vals };
}

// Atomic per-business sequence numbers (PO-000001, ORD-000001, ...)
export async function nextNumber(db: Db | PoolClient, businessId: string, key: string, prefix: string) {
  const { rows } = await db.query(
    `INSERT INTO counters (business_id, key, value) VALUES ($1,$2,1)
     ON CONFLICT (business_id, key) DO UPDATE SET value = counters.value + 1 RETURNING value`, [businessId, key]);
  return `${prefix}-${String(rows[0].value).padStart(6, "0")}`;
}

export const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);
