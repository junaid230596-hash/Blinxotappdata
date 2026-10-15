import pino from "pino";
import { config, isTest } from "./config.js";

export const logger = pino({
  level: isTest ? "silent" : config.NODE_ENV === "production" ? "info" : "debug",
  redact: ["req.headers.authorization", "req.headers.cookie", "password", "*.password", "*.token"],
});
