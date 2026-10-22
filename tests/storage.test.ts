import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
// @ts-expect-error s3rver ships no type declarations
import S3rver from "s3rver";

// A real S3-compatible server on localhost (s3rver) so the actual AWS SDK code path is exercised end to end.
const BUCKET = "blinxot-test"; const KEY_ID = "S3RVER"; const SECRET = "S3RVER";
const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), crypto.randomBytes(64)]);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");
let s3: any; let port = 0; let dataDir = ""; const savedEnv = { ...process.env };

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bx-s3-")); port = 41000 + Math.floor(Math.random() * 8000);
  s3 = new S3rver({ address: "127.0.0.1", port, silent: true, directory: dataDir, configureBuckets: [{ name: BUCKET }] }); await s3.run();
});
afterAll(async () => { await s3?.close(); fs.rmSync(dataDir, { recursive: true, force: true }); process.env = savedEnv; });

const opts = (extra: object = {}) => ({ bucket: BUCKET, region: "us-east-1", endpoint: `http://127.0.0.1:${port}`, accessKeyId: KEY_ID, secretAccessKey: SECRET, forcePathStyle: true, ...extra });
const read = async (body: { stream: NodeJS.ReadableStream } | null) => { if (!body) return null; const parts: Buffer[] = []; for await (const c of body.stream) parts.push(Buffer.from(c as Buffer)); return Buffer.concat(parts); };
const objects = () => fs.readdirSync(path.join(dataDir, BUCKET), { recursive: true } as any).map(String).filter((f) => !/\.s3rver_|_S3rver_object/.test(f));

describe("S3 driver", () => {
  it("writes, reads, checks and deletes objects under public/ and private/ prefixes", async () => {
    const { s3Driver } = await import("../server/src/lib/storage.js"); const d = s3Driver(opts({ prefix: "prod" }));
    const key = `${crypto.randomUUID()}.png`;
    expect(await d.exists("public", key)).toBe(false); expect(await d.get("public", key)).toBeNull();
    await d.put("public", key, PNG, "image/png"); await d.put("private", key, PDF, "application/pdf");
    expect(await d.exists("public", key)).toBe(true);
    const pub = await d.get("public", key); expect(pub!.size).toBe(PNG.length); expect((await read(pub))!.equals(PNG)).toBe(true);
    expect((await read(await d.get("private", key)))!.equals(PDF)).toBe(true);                        // same key, different scope, different object
    expect(objects().some((o) => o.includes(`prod/public/${key}`) || o.includes(`prod${path.sep}public${path.sep}${key}`))).toBe(true);
    await d.remove("public", key); expect(await d.exists("public", key)).toBe(false); expect(await d.exists("private", key)).toBe(true);
    await d.remove("private", key);
    await expect(d.check()).resolves.toBeUndefined();
  });

  it("explains the mistakes people make when setting up a bucket", async () => {
    const { s3Driver, explainStorageError } = await import("../server/src/lib/storage.js");
    const fail = async (o: object) => { try { await s3Driver(opts(o)).check(); return null; } catch (e) { return e; } };
    expect(explainStorageError({ name: "SignatureDoesNotMatch" })).toMatch(/secret access key/);          // the emulator does not check signatures, so these two are exercised directly
    expect(explainStorageError({ name: "InvalidAccessKeyId" })).toMatch(/access key ID/);
    const badBucket = await fail({ bucket: "does-not-exist" }); expect(badBucket).toBeTruthy(); expect(explainStorageError(badBucket)).toMatch(/bucket does not exist/);
    const down = await fail({ endpoint: "http://127.0.0.1:1" }); expect(down).toBeTruthy(); expect(explainStorageError(down)).toMatch(/Could not reach|endpoint/);
    expect(explainStorageError({ name: "AccessDenied" })).toMatch(/not allowed to use this bucket/);
    expect(explainStorageError({ name: "PermanentRedirect" })).toMatch(/region or endpoint/);
    expect(explainStorageError({ message: "getaddrinfo ENOTFOUND bucket.example" })).toMatch(/could not be found/);
  });
});

describe("the app running on cloud storage", () => {
  let api: any, pool: any, factory: any, pdfUploads: any;
  beforeAll(async () => {
    Object.assign(process.env, { STORAGE_DRIVER: "s3", S3_BUCKET: BUCKET, S3_REGION: "us-east-1", S3_ENDPOINT: `http://127.0.0.1:${port}`, S3_ACCESS_KEY_ID: KEY_ID, S3_SECRET_ACCESS_KEY: SECRET, S3_FORCE_PATH_STYLE: "true", S3_PREFIX: "test",
      UPLOAD_DIR: path.join(dataDir, "local-uploads") });
    vi.resetModules();                                                                                  // the app reads its config at import time: load a fresh copy that sees the S3 settings
    const h = await import("./helpers.js"); api = h; pool = h.pool; factory = await import("./factory.js"); await h.resetDb(); pdfUploads = await import("../server/src/lib/storage.js");
  });
  afterAll(async () => { await pool?.end(); });
  const png = (a: any, auth: any, q = "") => a.api().post(`/api/uploads${q}`).set(auth).attach("file", PNG, "logo.png");

  it("uses the cloud driver, keeps files out of the local disk, and serves them through the API with safe headers", async () => {
    expect(pdfUploads.storage.name).toBe("s3");
    const c = await factory.setup(); const up = await png(api, c.owner.auth, `?businessId=${c.id}`).expect(201);
    expect(up.body.url).toMatch(/^\/uploads\/[0-9a-f-]{36}\.png$/); expect(up.body.mime).toBe("image/png");
    const key = up.body.url.split("/").pop();
    expect(fs.existsSync(path.join(dataDir, "local-uploads", key))).toBe(false);                      // nothing written to this server's disk
    expect(objects().join("\n")).toContain(key);                                                         // it is in the bucket
    const got = await api.api().get(up.body.url).expect(200);
    expect(got.headers["content-type"]).toBe("image/png"); expect(got.headers["x-content-type-options"]).toBe("nosniff");
    expect(got.headers["cache-control"]).toMatch(/immutable/); expect(got.headers["content-disposition"]).toBe("inline");
    expect(Buffer.from(got.body).equals(PNG)).toBe(true);
    const rec = await pool.query("SELECT bytes, is_private FROM stored_files WHERE file_key=$1", [key]); expect(rec.rows[0]).toMatchObject({ bytes: String(PNG.length), is_private: false });
  });

  it("refuses bad keys, missing files and unsupported types without touching the bucket", async () => {
    const c = await factory.setup();
    for (const p of ["/uploads/not-a-key", "/uploads/..%2f..%2fetc%2fpasswd", `/uploads/${crypto.randomUUID()}.png`, `/uploads/${crypto.randomUUID()}.exe`]) await api.api().get(p).expect(404);
    await api.api().post("/api/uploads").set(c.owner.auth).attach("file", Buffer.from("MZ\x90\x00 not an image"), "evil.exe").expect(400);
    await api.api().post("/api/uploads").attach("file", PNG, "x.png").expect(401);
  });

  it("falls back to a file still on local disk (not yet migrated), then the migration copies it across", async () => {
    const key = `${crypto.randomUUID()}.png`; const dir = path.join(dataDir, "local-uploads"); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, key), PNG);
    const got = await api.api().get(`/uploads/${key}`).expect(200); expect(Buffer.from(got.body).equals(PNG)).toBe(true);
    expect(await pdfUploads.storage.exists("public", key)).toBe(false);
  });

  it("stores employee documents privately in the bucket, serves them only to authorised people, and deletes them from the bucket", async () => {
    const c = await factory.setup(); const e = await factory.addEmployee(c); const stranger = await factory.setup();
    const up = await api.api().post(`${c.base}/employees/${e.employeeId}/documents`).set(c.owner.auth).field("name", "Contract").field("category", "contract").field("visibleToEmployee", "true").attach("file", PDF, "contract.pdf").expect(201);
    const doc = up.body.document; const key = (await pool.query("SELECT file_key FROM employee_documents WHERE id=$1", [doc.id])).rows[0].file_key;
    expect(objects().join("\n")).toMatch(new RegExp(`private.*${key}`));                               // under the private/ prefix
    expect(fs.existsSync(path.join(dataDir, "local-uploads-private", key))).toBe(false);
    await api.api().get(`/uploads/${key}`).expect(404);                                                   // private files are never reachable as public uploads
    const file = await api.api().get(`${c.base}/employees/${e.employeeId}/documents/${doc.id}/file`).set(c.owner.auth).expect(200);
    expect(file.headers["content-disposition"]).toMatch(/attachment/); expect(file.headers["cache-control"]).toMatch(/no-store/); expect(Buffer.from(file.body).equals(PDF)).toBe(true);
    await api.api().get(`/api/businesses/${c.id}/employees/${e.employeeId}/documents/${doc.id}/file`).expect(401);
    await api.api().get(`${stranger.base}/employees/${e.employeeId}/documents/${doc.id}/file`).set(stranger.owner.auth).expect(404);   // another business cannot read it
    await api.api().get(`${c.base}/me/documents/${doc.id}/file`).set(e.auth).expect(200);                       // the employee, because it was shared with them
    await api.api().delete(`${c.base}/employees/${e.employeeId}/documents/${doc.id}`).set(c.owner.auth).expect(200);
    expect(await pdfUploads.storage.exists("private", key)).toBe(false);
    await api.api().get(`${c.base}/employees/${e.employeeId}/documents/${doc.id}/file`).set(c.owner.auth).expect(404);
  });

  it("reports a storage outage as a clean 502 and leaves no database record or file behind", async () => {
    const c = await factory.setup(); const before = (await pool.query("SELECT count(*)::int AS n FROM stored_files")).rows[0].n;
    await s3.close();                                                                                       // the bucket goes away
    try {
      const r = await png(api, c.owner.auth).expect(502);
      expect(r.body.error.code).toBe("STORAGE_UNAVAILABLE"); expect(JSON.stringify(r.body)).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|stack/);
      expect((await pool.query("SELECT count(*)::int AS n FROM stored_files")).rows[0].n).toBe(before);
    } finally { await s3.run(); }                                                                           // restore for later tests / cleanup
  }, 60000);
});
