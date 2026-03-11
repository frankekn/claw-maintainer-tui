import crypto from "node:crypto";
import fs from "node:fs";

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function hashText(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
