// Usage: npm run storage:migrate [-- --delete-local]
// Copies files already on this server's disk (public uploads and private employee documents) into the configured bucket.
// Safe to re-run: files already in the bucket are skipped. URLs in the database do not change (/uploads/<key> keeps working).
// With --delete-local, each local file is removed only after the bucket is confirmed to hold it.
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
const { config } = await import("./config.js");
const { storage, KEY_RE, MIME_BY_EXT, localDriver, explainStorageError } = await import("./lib/storage.js");
const { publicDir, privateDir } = await import("./lib/upload.js");
if (storage.name !== "s3") { console.error("STORAGE_DRIVER is not s3, so there is nowhere to migrate to. Set STORAGE_DRIVER=s3 and the S3_* values first."); process.exit(1); }
const deleteLocal = process.argv.includes("--delete-local");
try { await storage.check(); } catch (e) { console.error(`Bucket check failed: ${(e as Error).message}\n=> ${explainStorageError(e)}`); process.exit(2); }

const local = localDriver(); let copied = 0, skipped = 0, failed = 0, removed = 0, ignored = 0;
for (const [scope, dir] of [["public", publicDir], ["private", privateDir]] as const) {
  if (!fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir)) {
    if (!KEY_RE.test(name)) { ignored++; continue; }
    try {
      if (await storage.exists(scope, name)) skipped++;
      else { await storage.put(scope, name, await fs.promises.readFile(path.join(dir, name)), MIME_BY_EXT[path.extname(name)]); copied++; }
      if (deleteLocal && (await storage.exists(scope, name))) { await local.remove(scope, name); removed++; }
    } catch (e) { failed++; console.error(`FAILED ${scope}/${name}: ${(e as Error).message}`); }
  }
}
console.log(`Done. copied ${copied}, already in bucket ${skipped}, failed ${failed}${deleteLocal ? `, local copies removed ${removed}` : ""}${ignored ? `, ignored ${ignored} unrelated files` : ""}.`);
process.exit(failed ? 3 : 0);
