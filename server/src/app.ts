import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { config } from "./config.js";
import { pool } from "./db.js";
import { csrfGuard, loadUser } from "./middleware/auth.js";
import { maintenanceGuard } from "./middleware/maintenance.js";
import { errorHandler, notFoundHandler } from "./middleware/error.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { businessRouter, publicBusinessRouter } from "./modules/businesses/business.routes.js";
import { adminRouter } from "./modules/admin/admin.routes.js";
import { applyRouter } from "./modules/jobs/job.routes.js";
import { meRouter } from "./modules/profiles/me.routes.js";
import { publicRouter } from "./modules/profiles/public.routes.js";
import { plansRouter } from "./modules/plans/plan.routes.js";
import { searchRouter } from "./modules/search/search.routes.js";
import { reviewRouter } from "./modules/reviews/review.routes.js";
import { marketplaceRouter } from "./modules/marketplace/marketplace.routes.js";
import { notificationRouter } from "./modules/notifications/notification.routes.js";
import { seoRouter, siteRouter } from "./modules/seo/seo.routes.js";
import { uploadDir, uploadRouter, uploadServeRouter } from "./modules/uploads/upload.routes.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  app.use(cors({ origin: config.CORS_ORIGINS.split(",").map((s) => s.trim()), credentials: true }));
  app.use(express.json({ limit: "100kb" }));
  app.use(cookieParser());

  app.get("/api/health", async (_req, res) => {
    await pool.query("SELECT 1");
    res.json({ status: "ok", service: "blinxot-api" });
  });

  if (config.STORAGE_DRIVER === "s3") app.use("/uploads", uploadServeRouter);        // bucket stays private; the API streams public files
  else app.use("/uploads", express.static(uploadDir, { setHeaders: (r) => { r.setHeader("X-Content-Type-Options", "nosniff"); r.setHeader("Content-Disposition", "inline"); } }));

  app.use(seoRouter);                                         // /robots.txt and /sitemap.xml (no session, no maintenance gate)

  app.use("/api", loadUser, maintenanceGuard, csrfGuard);
  app.use("/api/auth", authRouter);
  app.use("/api/businesses", businessRouter);
  app.use("/api/public", siteRouter);
  app.use("/api/public", publicBusinessRouter);
  app.use("/api/public/marketplace", marketplaceRouter);
  app.use("/api/public", publicRouter);
  app.use("/api/me", meRouter);
  app.use("/api/reviews", reviewRouter);
  app.use("/api/jobs", applyRouter);
  app.use("/api/plans", plansRouter);
  app.use("/api/search", searchRouter);
  app.use("/api/admin", adminRouter);
  app.use("/api/notifications", notificationRouter);
  app.use("/api/uploads", uploadRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
