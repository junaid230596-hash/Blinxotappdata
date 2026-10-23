import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET must be at least 32 chars"),
  ACCESS_TOKEN_TTL_MIN: z.coerce.number().default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(30),
  APP_URL: z.string().url().default("http://localhost:5173"),
  SITE_URL: z.string().url().optional(),                      // public marketing origin used in sitemap/canonical links; defaults to APP_URL
  CLIENT_DIST: z.string().optional(),                         // built client folder (client/dist); enables per-page link-preview meta tags
  CORS_ORIGINS: z.string().default("http://localhost:5173"),
  COOKIE_DOMAIN: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_PASS: z.string().optional(),                        // accepted as an alias of SMTP_PASSWORD
  SMTP_CA_FILE: z.string().optional(),                     // PEM file of an extra certificate authority to trust (private relay, antivirus/proxy root)
  SMTP_TLS_INSECURE: z.enum(["true", "false"]).optional(),  // development only: skip certificate checks. Ignored in production.
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(1),   // proxies in front of the app: Render only = 1; Vercel rewrite -> Render = 2; nginx only = 1
  EMAIL_PROVIDER: z.enum(["smtp", "brevo", "resend"]).optional(),  // default: brevo if BREVO_API_KEY is set, else resend if RESEND_API_KEY is set, else smtp if SMTP_HOST is set
  BREVO_API_KEY: z.string().optional(), RESEND_API_KEY: z.string().optional(),
  BREVO_API_URL: z.string().url().default("https://api.brevo.com"), RESEND_API_URL: z.string().url().default("https://api.resend.com"),
  SMTP_SECURE: z.enum(["true", "false"]).optional(),        // default: true only for port 465 (SSL); 587 uses STARTTLS
  SMTP_FROM: z.string().default("Blinxot <no-reply@blinxot.com>"),
  UPLOAD_DIR: z.string().default("./uploads"),
  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),  // "s3" = any S3-compatible bucket (AWS S3, Cloudflare R2, Backblaze B2, DigitalOcean Spaces, MinIO...)
  S3_BUCKET: z.string().optional(), S3_REGION: z.string().default("us-east-1"), S3_ENDPOINT: z.string().url().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(), S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z.enum(["true", "false"]).optional(), S3_PREFIX: z.string().regex(/^[A-Za-z0-9._\-\/]*$/).default(""),
  MAX_UPLOAD_MB: z.coerce.number().default(5),
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(12).optional(),
}).superRefine((c, ctx) => {
  if (c.STORAGE_DRIVER !== "s3") return;
  for (const k of ["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const) if (!c[k]) ctx.addIssue({ code: "custom", path: [k], message: `${k} is required when STORAGE_DRIVER=s3` });
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}
export const config = parsed.data;
export const isProd = config.NODE_ENV === "production";
export const isTest = config.NODE_ENV === "test";
