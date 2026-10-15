import type { NextFunction, Request, Response } from "express";
import type { ZodTypeAny, z } from "zod";
import { badRequest } from "../lib/errors.js";

export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const fields = Object.fromEntries(r.error.issues.map((i) => [i.path.join(".") || "_", i.message]));
    throw badRequest("Validation failed", fields);
  }
  return r.data;
}

export const body = <S extends ZodTypeAny>(schema: S) => (req: Request, _res: Response, next: NextFunction) => {
  try { req.body = parse(schema, req.body); next(); } catch (e) { next(e); }
};
