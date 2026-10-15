import type { NextFunction, Request, Response } from "express";
import { AppError } from "../lib/errors.js";
import { logger } from "../logger.js";

export function notFoundHandler(_req: Request, _res: Response, next: NextFunction) {
  next(new AppError(404, "NOT_FOUND", "Route not found"));
}

export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err?.type === "entity.parse.failed") {
    return res.status(400).json({ error: { code: "BAD_REQUEST", message: "Malformed JSON body" } });
  }
  if (err?.type === "entity.too.large") {
    return res.status(413).json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Request body too large" } });
  }
  if (err?.status === 404 || err?.statusCode === 404) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "Not found" } });
  }
  if (err?.code === "23505") {
    return res.status(409).json({ error: { code: "CONFLICT", message: "A record with these details already exists" } });
  }
  if (err?.code === "23503" || err?.code === "23514") {
    return res.status(400).json({ error: { code: "BAD_REQUEST", message: "Invalid reference or value" } });
  }
  // Unknown error: log internally, never leak details.
  logger.error({ err: err?.message, stack: err?.stack, path: req.path }, "unhandled error");
  res.status(500).json({ error: { code: "INTERNAL", message: "Something went wrong. Please try again." } });
}
