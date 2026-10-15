import rateLimit from "express-rate-limit";
import { isTest } from "../config.js";

export const publicLimiter = (perMinute: number) => rateLimit({
  windowMs: 60_000, max: perMinute, skip: () => isTest, standardHeaders: true, legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "Too many requests. Please slow down." } },
});

export const httpUrlRe = /^https?:\/\/[^\s]+$/i;                                     // blocks javascript:, data:, etc.
export const uploadedImageRe = /^\/uploads\/[0-9a-f-]{36}\.(png|jpg|webp)$/;
export const uploadedPdfRe = /^\/uploads\/[0-9a-f-]{36}\.pdf$/;
