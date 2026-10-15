import { Router } from "express";
import { z } from "zod";
import { pageQuery } from "../../lib/pagination.js";
import { requireAuth, requireBusinessAccess } from "../../middleware/auth.js";
import { parse } from "../../middleware/validate.js";
import * as svc from "./invoice.service.js";

const uuid = z.string().uuid();
export const invoiceRouter = Router({ mergeParams: true });
invoiceRouter.use(requireAuth, requireBusinessAccess("orders.view"));
const bid = (r: any) => String(r.params.businessId);

invoiceRouter.get("/", async (req, res) => {
  const q = parse(pageQuery.extend({ q: z.string().trim().max(50).optional(), status: z.enum(["issued", "void"]).optional() }), req.query);
  res.json(await svc.listInvoices(bid(req), q));
});
invoiceRouter.get("/by-order/:orderId", async (req, res) => res.json({ invoice: await svc.getInvoiceByOrder(bid(req), parse(uuid, req.params.orderId)) }));
invoiceRouter.get("/:invoiceId", async (req, res) => res.json({ invoice: await svc.getInvoice(bid(req), parse(uuid, req.params.invoiceId)) }));
