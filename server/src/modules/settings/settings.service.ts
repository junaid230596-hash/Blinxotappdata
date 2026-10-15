import { z } from "zod";
import { pool } from "../../db.js";
import { badRequest } from "../../lib/errors.js";
import { audit } from "../audit/audit.service.js";

// Known platform settings, their validators and defaults. Unknown keys are rejected.
export const SETTINGS = {
  registration_open: { schema: z.boolean(), default: true as unknown },
  maintenance_mode: { schema: z.boolean(), default: false as unknown },
  support_email: { schema: z.string().email().max(254).nullable(), default: null as unknown },
} as const;
export type SettingKey = keyof typeof SETTINGS;

let cache: { at: number; values: Record<string, unknown> } | null = null;
const TTL_MS = 5_000;
export const invalidateSettings = () => { cache = null; };

export async function allSettings(): Promise<Record<SettingKey, any>> {
  if (!cache || Date.now() - cache.at > TTL_MS) {
    const { rows } = await pool.query("SELECT key, value FROM settings");
    cache = { at: Date.now(), values: Object.fromEntries(rows.map((r) => [r.key, r.value])) };
  }
  return Object.fromEntries((Object.keys(SETTINGS) as SettingKey[]).map((k) => [k, k in cache!.values ? cache!.values[k] : SETTINGS[k].default])) as any;
}
export const getSetting = async <K extends SettingKey>(k: K) => (await allSettings())[k];

export async function setSetting(adminId: string, key: string, value: unknown, ip?: string) {
  if (!(key in SETTINGS)) throw badRequest("Unknown setting");
  const parsed = SETTINGS[key as SettingKey].schema.safeParse(value);
  if (!parsed.success) throw badRequest("Invalid value for this setting");
  await pool.query("INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=now()", [key, JSON.stringify(parsed.data)]);
  invalidateSettings();
  await audit({ actorId: adminId, action: "admin.setting_change", entity: "setting", entityId: key, metadata: { value: parsed.data }, ip });
  return allSettings();
}
