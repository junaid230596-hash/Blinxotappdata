import { z } from "zod";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { businessDashboard } from "../dashboard/dashboard.service.js";
import { lowStock } from "../inventory/inventory.service.js";
import { catalog, isReport, reportNeeds, runReport } from "../reports/report.service.js";
import { search } from "../search/search.service.js";
import { audit } from "../audit/audit.service.js";
import type { AiToolSpec } from "./ai.provider.js";

export interface ToolContext { businessId: string; userId: string; permissions: Set<string>; ip?: string }
interface Tool<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string; description: string;
  needs: string[];                       // every permission the caller must hold (same ones the matching screen/endpoint needs)
  input: S; run: (ctx: ToolContext, input: z.infer<S>) => Promise<unknown>;
}
const tool = <S extends z.ZodTypeAny>(t: Tool<S>) => t as unknown as Tool;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const MAX_ROWS = 200;

/**
 * The complete, closed list of things an AI agent may do. All tools are READ-ONLY and scoped to one business.
 * There is deliberately no generic "run SQL", no write tool, and no cross-business tool. Adding a capability means
 * adding an entry here with explicit permissions and a validated input schema.
 */
const TOOLS: Tool[] = [
  tool({ name: "business_dashboard", description: "Summary of sales, orders, stock, people and CRM that the user is allowed to see.",
    needs: [], input: z.object({}).strict(),
    run: (c) => businessDashboard(c.businessId, c.userId, c.permissions) }),
  tool({ name: "low_stock_products", description: "Active products at or below their minimum stock level.",
    needs: ["inventory.view"], input: z.object({}).strict(),
    run: async (c) => ({ products: (await lowStock(c.businessId)).slice(0, MAX_ROWS) }) }),
  tool({ name: "list_reports", description: "Reports the user may run, with their ids.",
    needs: ["reports.view"], input: z.object({}).strict(),
    run: async (c) => ({ reports: catalog(c.permissions) }) }),
  tool({ name: "run_report", description: "Run one report for a date range (max one year) and return up to 200 rows plus the summary.",
    needs: ["reports.view"], input: z.object({ type: z.string().min(1).max(40), from: day, to: day }).strict(),
    run: async (c, i) => {
      if (!isReport(i.type)) throw notFound("Unknown report");
      if (!reportNeeds(i.type)!.every((p) => c.permissions.has(p))) throw forbidden();      // e.g. salary reports need salary.view
      if (i.from > i.to) throw badRequest("The start date must be on or before the end date");
      if ((Date.parse(i.to) - Date.parse(i.from)) / 86_400_000 > 366) throw badRequest("Reports cover at most one year at a time");
      const r = await runReport(i.type, c.businessId, { from: i.from, to: i.to });
      return { title: r.title, columns: r.columns, summary: r.summary, rows: r.rows.slice(0, MAX_ROWS), truncated: r.rows.length > MAX_ROWS };
    } }),
  tool({ name: "search", description: "Permission-aware search across this business's products, customers, orders and people.",
    needs: [], input: z.object({ q: z.string().trim().min(2).max(100), limit: z.number().int().min(1).max(20).default(5) }).strict(),
    run: (c, i) => search(c.userId, { q: i.q, businessId: c.businessId, limit: i.limit }) }),
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));
const allowed = (t: Tool, perms: Set<string>) => t.needs.every((p) => perms.has(p));

/** Tool descriptions to hand to a model: only the ones this user could call themselves. */
export function toolsFor(perms: Set<string>): AiToolSpec[] {
  return TOOLS.filter((t) => allowed(t, perms)).map((t) => ({ name: t.name, description: t.description, inputSchema: z.toJSONSchema(t.input) as Record<string, unknown> }));
}

export async function runTool(ctx: ToolContext, name: string, rawInput: unknown) {
  const t = byName.get(name);
  if (!t) throw notFound("Unknown tool");
  if (!allowed(t, ctx.permissions)) throw forbidden();
  const parsed = t.input.safeParse(rawInput ?? {});
  if (!parsed.success) throw badRequest("Validation failed", Object.fromEntries(parsed.error.issues.map((i) => [i.path.join(".") || "_", i.message])));
  const result = await t.run(ctx, parsed.data);
  await audit({ actorId: ctx.userId, businessId: ctx.businessId, action: "ai.tool", entity: "ai_tool", entityId: name, ip: ctx.ip });
  return result;
}
