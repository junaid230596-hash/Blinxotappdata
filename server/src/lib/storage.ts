import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { AppError } from "./errors.js";
import { privateDir, publicDir } from "./upload.js";

// File storage behind one interface. "public" files (logos, product images, avatars) are served at /uploads/<key> by the API;
// "private" files (employee documents) are only ever streamed after an authorisation check. With the S3 driver the bucket itself
// stays completely private: nothing links to it, so there is no public-bucket misconfiguration to get wrong, and every download
// still passes through the app's access rules and security headers.

export type Scope = "public" | "private";
export interface ObjectBody { stream: Readable; size?: number; etag?: string }
export interface StorageDriver {
  readonly name: "local" | "s3";
  put(scope: Scope, key: string, buf: Buffer, mime: string): Promise<void>;
  get(scope: Scope, key: string): Promise<ObjectBody | null>;
  exists(scope: Scope, key: string): Promise<boolean>;
  remove(scope: Scope, key: string): Promise<void>;
  /** Writes, reads and deletes a small test object so a bad bucket, key or region is found at startup, not on the first upload. */
  check(): Promise<void>;
}

export const MIME_BY_EXT: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".pdf": "application/pdf" };
/** Keys are server-generated UUID + extension. Anything else is rejected before touching the disk or the bucket (no path tricks, no key guessing). */
export const KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp|pdf)$/;
export const newKey = (ext: string) => `${crypto.randomUUID()}${ext}`;
const dirOf = (scope: Scope) => (scope === "public" ? publicDir : privateDir);

export function localDriver(): StorageDriver {
  return {
    name: "local",
    async put(scope, key, buf) { await fs.promises.writeFile(path.join(dirOf(scope), key), buf, { flag: "wx" }); },
    async get(scope, key) {
      const full = path.join(dirOf(scope), key);
      try { const st = await fs.promises.stat(full); return { stream: fs.createReadStream(full), size: st.size, etag: `"${st.size}-${Math.round(st.mtimeMs)}"` }; }
      catch { return null; }
    },
    async exists(scope, key) { return fs.existsSync(path.join(dirOf(scope), key)); },
    async remove(scope, key) { await fs.promises.rm(path.join(dirOf(scope), key), { force: true }); },
    async check() { fs.accessSync(publicDir, fs.constants.W_OK); fs.accessSync(privateDir, fs.constants.W_OK); },
  };
}

export interface S3Options { bucket: string; region: string; endpoint?: string; accessKeyId: string; secretAccessKey: string; forcePathStyle?: boolean; prefix?: string }

export function s3Driver(o: S3Options): StorageDriver {
  const prefix = o.prefix ? o.prefix.replace(/^\/+|\/+$/g, "") + "/" : "";
  const objectKey = (scope: Scope, key: string) => `${prefix}${scope}/${key}`;
  let sdk: Promise<{ lib: typeof import("@aws-sdk/client-s3"); client: InstanceType<typeof import("@aws-sdk/client-s3").S3Client> }> | undefined;
  const load = () => (sdk ??= import("@aws-sdk/client-s3").then((lib) => ({
    lib, client: new lib.S3Client({
      region: o.region, endpoint: o.endpoint, forcePathStyle: o.forcePathStyle ?? !!o.endpoint,
      credentials: { accessKeyId: o.accessKeyId, secretAccessKey: o.secretAccessKey },
      // Newer SDK versions add checksum headers that Cloudflare R2, Backblaze B2 and several other S3-compatible services reject.
      requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED", maxAttempts: 3,
    }),
  })));
  const timeout = () => ({ abortSignal: AbortSignal.timeout(30_000) });
  const missing = (e: any) => e?.name === "NoSuchKey" || e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404;

  return {
    name: "s3",
    async put(scope, key, buf, mime) {
      const { lib, client } = await load();
      await client.send(new lib.PutObjectCommand({ Bucket: o.bucket, Key: objectKey(scope, key), Body: buf, ContentType: mime, ContentLength: buf.length,
        CacheControl: scope === "public" ? "public, max-age=31536000, immutable" : "private, no-store" }), timeout());
    },
    async get(scope, key) {
      const { lib, client } = await load();
      try {
        const r = await client.send(new lib.GetObjectCommand({ Bucket: o.bucket, Key: objectKey(scope, key) }), timeout());
        return r.Body ? { stream: r.Body as Readable, size: r.ContentLength, etag: r.ETag } : null;
      } catch (e) { if (missing(e)) return null; throw e; }
    },
    async exists(scope, key) {
      const { lib, client } = await load();
      try { await client.send(new lib.HeadObjectCommand({ Bucket: o.bucket, Key: objectKey(scope, key) }), timeout()); return true; }
      catch (e) { if (missing(e)) return false; throw e; }
    },
    async remove(scope, key) { const { lib, client } = await load(); await client.send(new lib.DeleteObjectCommand({ Bucket: o.bucket, Key: objectKey(scope, key) }), timeout()); },
    async check() {
      const { lib, client } = await load(); const Key = `${prefix}healthcheck/${crypto.randomUUID()}.txt`; const payload = Buffer.from("blinxot storage check");
      await client.send(new lib.PutObjectCommand({ Bucket: o.bucket, Key, Body: payload, ContentType: "text/plain", ContentLength: payload.length }), timeout());
      const r = await client.send(new lib.GetObjectCommand({ Bucket: o.bucket, Key }), timeout());
      const back = Buffer.concat(await (async () => { const parts: Buffer[] = []; for await (const c of r.Body as Readable) parts.push(Buffer.from(c)); return parts; })());
      await client.send(new lib.DeleteObjectCommand({ Bucket: o.bucket, Key }), timeout());
      if (!back.equals(payload)) throw new Error("The bucket returned different data than was written");
    },
  };
}

/** Plain-words explanation for the errors people actually hit when setting up a bucket. */
export function explainStorageError(e: any): string {
  const name: string = e?.name ?? e?.code ?? ""; const status = e?.$metadata?.httpStatusCode; const text = `${name} ${e?.message ?? ""}`;
  if (/InvalidAccessKeyId|NoSuchAccessKey/i.test(text)) return "The access key ID is not recognised by this provider. Check S3_ACCESS_KEY_ID (and that S3_ENDPOINT belongs to the same account).";
  if (/SignatureDoesNotMatch/i.test(text)) return "The secret access key is wrong (or has stray spaces). Check S3_SECRET_ACCESS_KEY.";
  if (/NoSuchBucket/i.test(text)) return "The bucket does not exist. Check S3_BUCKET (it is case-sensitive) and create it in your provider's dashboard.";
  if (/AccessDenied|Forbidden/i.test(text) || status === 403) return "The key is valid but not allowed to use this bucket. Give the key read, write and delete permission on the bucket (for R2: an API token with Object Read & Write).";
  if (/PermanentRedirect|AuthorizationHeaderMalformed|IllegalLocationConstraint/i.test(text) || status === 301) return "Wrong region or endpoint for this bucket. Check S3_REGION (AWS) or S3_ENDPOINT (other providers).";
  if (/ENOTFOUND|EAI_AGAIN/i.test(text)) return "The endpoint host could not be found. Check S3_ENDPOINT for typos and this server's internet access.";
  if (/ECONNREFUSED|ETIMEDOUT|TimeoutError|AbortError/i.test(text)) return "Could not reach the storage endpoint in time. Check S3_ENDPOINT, the network and any firewall.";
  if (/self[- ]signed|certificate/i.test(text)) return "The endpoint's TLS certificate is not trusted (antivirus/proxy interception or a private service). See docs/STORAGE.md.";
  return "See the message above.";
}

function build(): StorageDriver {
  if (config.STORAGE_DRIVER !== "s3") return localDriver();
  return s3Driver({ bucket: config.S3_BUCKET!, region: config.S3_REGION, endpoint: config.S3_ENDPOINT, accessKeyId: config.S3_ACCESS_KEY_ID!, secretAccessKey: config.S3_SECRET_ACCESS_KEY!,
    forcePathStyle: config.S3_FORCE_PATH_STYLE ? config.S3_FORCE_PATH_STYLE === "true" : undefined, prefix: config.S3_PREFIX });
}
export const storage: StorageDriver = build();

/** Stores a validated file and returns its key. Storage outages become a clean 502, never a 500 with internals. */
export async function storeFile(scope: Scope, buf: Buffer, ext: string): Promise<string> {
  const key = newKey(ext);
  try { await storage.put(scope, key, buf, MIME_BY_EXT[ext] ?? "application/octet-stream"); return key; }
  catch (e) {
    logger.error({ err: (e as Error).message, driver: storage.name, hint: explainStorageError(e) }, "file storage write failed");
    throw new AppError(502, "STORAGE_UNAVAILABLE", "File storage is temporarily unavailable. Please try again in a moment.");
  }
}
/** Best-effort delete (used for cleanup and when a record is removed); a failure is logged, never thrown. Removes any leftover local copy as well. */
export async function removeFile(scope: Scope, key: string): Promise<void> {
  if (!KEY_RE.test(key)) return;
  try { await storage.remove(scope, key); } catch (e) { logger.error({ err: (e as Error).message, key }, "file storage delete failed"); }
  if (storage.name !== "local") await localDriver().remove(scope, key).catch(() => {});
}
/** Reads a file. With the cloud driver, a file that is not in the bucket yet (not migrated) is served from local disk if it is still there. */
export async function openFile(scope: Scope, key: string): Promise<ObjectBody | null> {
  if (!KEY_RE.test(key)) return null;
  const found = await storage.get(scope, key);
  if (found || storage.name === "local") return found;
  return localDriver().get(scope, key);
}

export async function checkStorageOnBoot() {
  try { await storage.check(); logger.info({ driver: storage.name, bucket: storage.name === "s3" ? config.S3_BUCKET : undefined }, "file storage verified: uploads are working"); }
  catch (e) { logger.error({ driver: storage.name, err: (e as Error).message, name: (e as any)?.name }, `file storage is NOT working: ${explainStorageError(e)}`); }
}
