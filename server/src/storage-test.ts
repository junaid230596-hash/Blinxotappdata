// Usage: npm run storage:test
// Verifies the configured file storage by writing, reading and deleting a small test object, and explains any problem.
import "dotenv/config";
const { config } = await import("./config.js");
const { storage, explainStorageError } = await import("./lib/storage.js");
console.log(storage.name === "s3"
  ? `Driver: S3-compatible  bucket: ${config.S3_BUCKET}  region: ${config.S3_REGION}  endpoint: ${config.S3_ENDPOINT ?? "(AWS default)"}  prefix: ${config.S3_PREFIX || "(none)"}  access key: ${config.S3_ACCESS_KEY_ID?.slice(0, 4)}…`
  : `Driver: local disk (${config.UPLOAD_DIR}). Set STORAGE_DRIVER=s3 and the S3_* values to use cloud storage.`);
try { await storage.check(); console.log("OK: wrote, read back and deleted a test file. Uploads will work."); }
catch (e) { console.error(`\nFAILED: ${(e as any)?.name ?? ""} ${(e as Error).message}\n=> ${explainStorageError(e)}`); process.exit(2); }
