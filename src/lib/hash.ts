import { createHash } from "node:crypto";

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function contentHash(input: string | Buffer): string {
  return `0x${sha256Hex(input)}`;
}

export function shortId(prefix: string, input: string | Buffer): string {
  return `${prefix}_${sha256Hex(input).slice(0, 32)}`;
}
