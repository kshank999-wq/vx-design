import "server-only";
import { inspectUpload, type UploadPolicy } from "@vx/security";

/** What each upload form accepts (G6): checked on the bytes, not the file name. */
export const POLICIES = {
  document: { maxBytes: 20 * 1048576, accept: ["pdf", "docx", "text"] },
  model: { maxBytes: 24 * 1048576, accept: ["step", "zip", "text"] },
  source: { maxBytes: 20 * 1048576, accept: ["pdf", "docx", "text", "html"] },
  /** Mock-ups, sketches, drawings and files from other tools (project inputs). SVG is refused: it can carry script. */
  reference: { maxBytes: 50 * 1048576, accept: ["png", "jpeg", "webp", "gif", "pdf", "docx", "xlsx", "zip", "step", "stl", "text"] },
} satisfies Record<string, UploadPolicy>;

/** Null when the file may be stored; otherwise a sentence for the person who uploaded it. */
export function uploadProblem(name: string, bytes: Uint8Array, policy: UploadPolicy): string | null {
  const r = inspectUpload(name, bytes, policy);
  return r.ok ? null : `This file was not accepted: ${r.problems.join("; ")}.`;
}
