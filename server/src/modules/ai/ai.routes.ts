import { Router } from "express";
import { publicLimiter } from "../../lib/limits.js";
import { requireAuth, requireBusinessAccess } from "../../middleware/auth.js";
import { getProvider } from "./ai.provider.js";
import { runTool, toolsFor } from "./ai.tools.js";

// AI-readiness boundary. These endpoints are what a future assistant (in-app or external) calls; they are ordinary,
// permission-checked, audited, rate-limited API calls made as the signed-in user. No provider is connected by default.
export const aiRouter = Router({ mergeParams: true });
aiRouter.use(requireAuth, requireBusinessAccess(), publicLimiter(60));

aiRouter.get("/status", (_req, res) => res.json({ provider: getProvider().name, enabled: getProvider().name !== "none" }));
aiRouter.get("/tools", (req, res) => res.json({ tools: toolsFor(req.permissions!) }));
aiRouter.post("/tools/:name", async (req, res) => {
  const result = await runTool({ businessId: String((req.params as Record<string, string>).businessId), userId: req.user!.id, permissions: req.permissions!, ip: req.ip }, String(req.params.name), req.body);
  res.json({ result });
});
