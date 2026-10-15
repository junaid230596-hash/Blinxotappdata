import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

// Files are identified by their magic bytes, never by the client-supplied name or MIME type.
const SIGNATURES: { ext: string; mime: string; match: (b: Buffer) => boolean }[] = [
  { ext: ".png", mime: "image/png", match: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: ".jpg", mime: "image/jpeg", match: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: ".webp", mime: "image/webp", match: (b) => b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP" },
  { ext: ".pdf", mime: "application/pdf", match: (b) => b.subarray(0, 5).toString() === "%PDF-" },
];
export const detectFileType = (b: Buffer) => SIGNATURES.find((s) => s.match(b)) ?? null;

export const publicDir = path.resolve(config.UPLOAD_DIR);
// Private files live outside the statically served directory and are only reachable through authorised endpoints.
export const privateDir = path.resolve(config.UPLOAD_DIR, "..", `${path.basename(config.UPLOAD_DIR)}-private`);
fs.mkdirSync(publicDir, { recursive: true });
fs.mkdirSync(privateDir, { recursive: true });

export async function saveFile(dir: string, buf: Buffer, ext: string): Promise<string> {
  const name = `${crypto.randomUUID()}${ext}`;      // server-generated; the client's filename is ignored
  await fs.promises.writeFile(path.join(dir, name), buf, { flag: "wx" });
  return name;
}
