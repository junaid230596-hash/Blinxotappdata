import type { Db } from "../../db.js";
import { pool } from "../../db.js";
import { logger } from "../../logger.js";

export interface AuditEntry {
  actorId?: string | null;
  businessId?: string | null;
  action: string;
  entity?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
  ip?: string;
}

export async function audit(e: AuditEntry, db: Db = pool): Promise<void> {
  try {
    await db.query(
      `INSERT INTO audit_logs (actor_id, business_id, action, entity, entity_id, metadata, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [e.actorId ?? null, e.businessId ?? null, e.action, e.entity ?? null, e.entityId ?? null, e.metadata ?? {}, e.ip ?? null],
    );
  } catch (err) {
    logger.error({ err: (err as Error).message, action: e.action }, "audit write failed");
  }
}
