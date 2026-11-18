import "server-only";
import { createHash, createHmac } from "node:crypto";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * Signs an assistant answer for post_message (G6): only the web server holds VX_ASSISTANT_SIGNING_KEY, so a member
 * calling the database directly cannot post text as the assistant. Must match post_message's message layout.
 */
export function signAssistantAnswer(a: { projectId: string; userId: string; question: string; answer: string; data: string }) {
  const key = process.env.VX_ASSISTANT_SIGNING_KEY;
  if (!key) throw new Error("VX_ASSISTANT_SIGNING_KEY is not set on the web server");
  const signedAt = Date.now();
  const msg = ["vx-assistant-v1", a.projectId, a.userId, String(signedAt), sha(a.question), sha(a.answer), sha(a.data)].join("\n");
  return { p_signed_at_ms: signedAt, p_signature: createHmac("sha256", key).update(msg, "utf8").digest("hex") };
}
