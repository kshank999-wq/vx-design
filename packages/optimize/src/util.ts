import { createHash } from "node:crypto";
import type { OptimizeInput } from "./types.ts";

export const fingerprint = (...parts: string[]) => createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 16);

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Requirements whose text names any of the given designators, part numbers or rail ids (as whole words). */
export function requirementTouches(reqs: OptimizeInput["requirements"], names: string[]): OptimizeInput["requirements"] {
  const words = names.filter((n) => n.length >= 2);
  if (!words.length) return [];
  const re = new RegExp(`(^|[^A-Za-z0-9])(${words.map(esc).join("|")})([^A-Za-z0-9]|$)`, "i");
  return reqs.filter((r) => re.test(r.text));
}
