import { Router } from "express";
import { z } from "zod";
import { publicLimiter } from "../../lib/limits.js";
import { requireAuth } from "../../middleware/auth.js";
import { parse } from "../../middleware/validate.js";
import { SEARCH_TYPES, search } from "./search.service.js";

export const searchRouter = Router();
searchRouter.use(requireAuth, publicLimiter(120));
searchRouter.get("/", async (req, res) => {
  const q = parse(z.object({
    q: z.string().trim().min(2, "Type at least 2 characters").max(100),
    businessId: z.string().uuid().optional(),
    types: z.string().optional().transform((v) => v?.split(",").map((s) => s.trim()).filter(Boolean)).pipe(z.array(z.enum(SEARCH_TYPES)).max(9).optional()),
    limit: z.coerce.number().int().min(1).max(20).default(5),
  }), req.query);
  res.json(await search(req.user!.id, q));
});
