import { Router } from "express";
import { STATE_CODES, validGstin } from "../../lib/gst.js";
import { z } from "zod";
import { pageQuery } from "../../lib/pagination.js";
import { requireAuth, requireBusinessAccess } from "../../middleware/auth.js";
import { body, parse } from "../../middleware/validate.js";
import * as svc from "./customer.service.js";

const uuid = z.string().uuid();
const bid = (r: any) => String(r.params.businessId);
const cid = (r: any) => parse(uuid, r.params.customerId);
const fields = {
  gstin: z.union([z.literal(""), z.string().trim().toUpperCase().refine(validGstin, "Enter a valid 15-character GSTIN")]).optional(),
  stateCode: z.union([z.literal(""), z.enum(STATE_CODES)]).optional(),
  name: z.string().trim().min(1).max(160), phone: z.string().trim().max(30).optional(), email: z.string().trim().email().max(254).optional(),
  address: z.string().trim().max(300).optional(), notes: z.string().trim().max(2000).optional(),
};

export const customerRouter = Router({ mergeParams: true });
customerRouter.use(requireAuth);
customerRouter.post("/", requireBusinessAccess("customers.manage"), body(z.object(fields)),
  async (req, res) => res.status(201).json({ customer: await svc.createCustomer(bid(req), req.user!.id, req.body, req.ip) }));
customerRouter.get("/", requireBusinessAccess("customers.view"), async (req, res) => {
  const q = parse(pageQuery.extend({ q: z.string().trim().max(100).optional(), status: z.enum(["active", "inactive"]).optional(),
    sort: z.enum(["name", "spent", "last", "created"]).optional(), dir: z.enum(["asc", "desc"]).optional() }), req.query);
  res.json(await svc.listCustomers(bid(req), q));
});
customerRouter.get("/:customerId", requireBusinessAccess("customers.view"), async (req, res) => res.json({ customer: await svc.getCustomer(bid(req), cid(req), true) }));
customerRouter.patch("/:customerId", requireBusinessAccess("customers.manage"), body(z.object({ ...fields, status: z.enum(["active", "inactive"]).optional() }).partial()),
  async (req, res) => res.json({ customer: await svc.updateCustomer(bid(req), cid(req), req.user!.id, req.body, req.ip) }));
customerRouter.post("/:customerId/communications", requireBusinessAccess("customers.manage"),
  body(z.object({ type: z.enum(["call", "email", "meeting", "sms", "note"]), summary: z.string().trim().min(1).max(2000) })),
  async (req, res) => res.status(201).json({ customer: await svc.logCommunication(bid(req), cid(req), req.user!.id, req.body) }));
