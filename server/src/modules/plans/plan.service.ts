import { pool, tx } from "../../db.js";
import { AppError, badRequest, conflict, notFound } from "../../lib/errors.js";
import { audit } from "../audit/audit.service.js";

export type Resource = "members" | "products" | "ordersPerMonth" | "storageMb" | "businesses";
export type Limits = Partial<Record<Resource, number>>;

export const listPlans = async () => {
  const { rows } = await pool.query("SELECT * FROM plans WHERE is_public ORDER BY sort_order");
  return rows.map((p) => ({ key: p.key, name: p.name, priceMonthly: p.price_monthly == null ? null : Number(p.price_monthly), currency: p.currency, limits: p.limits as Limits }));
};

export async function getSubscription(businessId: string) {
  const { rows } = await pool.query(
    `SELECT s.*, p.name AS plan_name, p.limits, p.price_monthly, p.currency FROM subscriptions s JOIN plans p ON p.key=s.plan_key WHERE s.business_id=$1`, [businessId]);
  if (!rows[0]) throw notFound("No subscription found");
  return rows[0];
}

export async function usage(businessId: string): Promise<Record<Resource, number>> {
  const q = async (sql: string) => Number((await pool.query(sql, [businessId])).rows[0].n);
  const [members, products, orders, bytes, owner] = await Promise.all([
    q("SELECT count(*) AS n FROM business_members WHERE business_id=$1 AND status IN ('active','invited')"),
    q("SELECT count(*) AS n FROM products WHERE business_id=$1"),
    q("SELECT count(*) AS n FROM orders WHERE business_id=$1 AND created_at >= date_trunc('month', now())"),
    q("SELECT COALESCE(sum(bytes),0) AS n FROM stored_files WHERE business_id=$1"),
    q("SELECT count(*) AS n FROM businesses WHERE owner_id=(SELECT owner_id FROM businesses WHERE id=$1) AND status='active'"),
  ]);
  return { members, products, ordersPerMonth: orders, storageMb: bytes / 1048576, businesses: owner };   // exact; rounded only for display
}

export async function subscriptionView(businessId: string) {
  const s = await getSubscription(businessId);
  const u = await usage(businessId);
  return { plan: { key: s.plan_key, name: s.plan_name, priceMonthly: s.price_monthly == null ? null : Number(s.price_monthly), currency: s.currency },
    status: s.status, currentPeriodEnd: s.current_period_end, limits: s.limits as Limits, usage: { ...u, storageMb: Math.round(u.storageMb * 10000) / 10000 } };
}

const LABEL: Record<Resource, string> = { members: "team members", products: "products", ordersPerMonth: "orders this month", storageMb: "MB of storage", businesses: "businesses" };

/** Throws PLAN_LIMIT when adding `adding` more of `resource` would exceed the business's plan. Unlimited when the limit is absent. */
export async function assertWithin(businessId: string, resource: Exclude<Resource, "businesses">, adding = 1) {
  const s = await getSubscription(businessId);
  if (s.status === "cancelled") throw new AppError(403, "PLAN_INACTIVE", "This subscription is cancelled. Choose a plan to continue.");
  const limit = (s.limits as Limits)[resource];
  if (limit == null) return;
  const current = (await usage(businessId))[resource];
  if (current + adding > limit) {
    throw new AppError(403, "PLAN_LIMIT", `Your ${s.plan_name} plan allows ${limit} ${LABEL[resource]}. Upgrade to add more.`, { resource, limit, current, plan: s.plan_key });
  }
}

// A user's business allowance comes from the best plan among the businesses they already own (new ones start on Free).
export async function assertCanCreateBusiness(userId: string) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n, COALESCE(max(CASE WHEN p.limits ? 'businesses' THEN (p.limits->>'businesses')::int ELSE 1000000 END), 1) AS allowed
       FROM businesses b JOIN subscriptions s ON s.business_id=b.id JOIN plans p ON p.key=s.plan_key WHERE b.owner_id=$1 AND b.status='active'`, [userId]);
  const { n, allowed } = rows[0];
  const freeAllowed = Number((await pool.query("SELECT limits->>'businesses' AS l FROM plans WHERE key='free'")).rows[0].l ?? 1000000);
  const cap = n === 0 ? freeAllowed : Number(allowed);
  if (n + 1 > cap) throw new AppError(403, "PLAN_LIMIT", `Your plan allows ${cap} business${cap === 1 ? "" : "es"}. Upgrade one of your businesses to add more.`, { resource: "businesses", limit: cap, current: n });
}

export async function recordFile(businessId: string | null, userId: string, key: string, bytes: number, isPrivate: boolean, db: any = pool) {
  const { rows } = await db.query("INSERT INTO stored_files (business_id, user_id, file_key, bytes, is_private) VALUES ($1,$2,$3,$4,$5) RETURNING id", [businessId, userId, key, bytes, isPrivate]);
  return rows[0].id as string;
}

/** Admin action; this is the integration point a payment webhook would call once a payment is confirmed. */
export async function setPlan(businessId: string, planKey: string, actorId: string, meta: { provider?: string; providerRef?: string; periodEnd?: Date } = {}, ip?: string) {
  const { rows: p } = await pool.query("SELECT key FROM plans WHERE key=$1", [planKey]);
  if (!p[0]) throw badRequest("Unknown plan");
  const r = await pool.query(
    `UPDATE subscriptions SET plan_key=$2, status='active', provider=COALESCE($3,provider), provider_ref=COALESCE($4,provider_ref), current_period_end=COALESCE($5,current_period_end), updated_at=now()
      WHERE business_id=$1`, [businessId, planKey, meta.provider ?? null, meta.providerRef ?? null, meta.periodEnd ?? null]);
  if (!r.rowCount) throw notFound("Business not found");
  await audit({ actorId, businessId, action: "subscription.plan_change", entity: "subscription", entityId: businessId, metadata: { planKey }, ip });
  return subscriptionView(businessId);
}

// Owners may only move *down*, and only when current usage already fits the target plan.
export async function selfChangePlan(businessId: string, planKey: string, actorId: string, ip?: string) {
  return tx(async (c) => {
    const { rows: cur } = await c.query("SELECT p.price_monthly FROM subscriptions s JOIN plans p ON p.key=s.plan_key WHERE s.business_id=$1 FOR UPDATE OF s", [businessId]);
    const { rows: target } = await c.query("SELECT * FROM plans WHERE key=$1", [planKey]);
    if (!target[0] || !cur[0]) throw badRequest("Unknown plan");
    const price = (x: any) => (x.price_monthly == null ? Infinity : Number(x.price_monthly));
    if (price(target[0]) > price(cur[0])) throw new AppError(403, "PAYMENT_REQUIRED", "Upgrading needs payment. Contact support to upgrade this plan.");
    const used = await usage(businessId);
    const limits = target[0].limits as Limits;
    const over = (Object.keys(limits) as Resource[]).filter((k) => k !== "businesses" && used[k] > (limits[k] as number));
    if (over.length) throw conflict(`Current usage exceeds the ${target[0].name} plan: ${over.map((k) => `${used[k]} ${LABEL[k]} (limit ${limits[k]})`).join(", ")}`);
    await c.query("UPDATE subscriptions SET plan_key=$2, updated_at=now() WHERE business_id=$1", [businessId, planKey]);
    await audit({ actorId, businessId, action: "subscription.downgrade", entity: "subscription", entityId: businessId, metadata: { planKey }, ip }, c);
  }).then(() => subscriptionView(businessId));
}
