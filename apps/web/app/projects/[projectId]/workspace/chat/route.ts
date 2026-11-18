import { askAndPost, questionProblem } from "@/lib/chat";
import { createClient } from "@/lib/supabase/server";

/**
 * Streams the assistant's reply as it is written: newline-delimited JSON events {"type":"delta","text"} then
 * {"type":"done"} once the exchange is posted, or {"type":"error","message"}. The page refreshes on "done" and shows
 * the stored message, so what was streamed is never the record. Without JavaScript the form posts to the server
 * action instead.
 */
export async function POST(req: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const userId = data?.claims?.sub as string | undefined;
  if (!userId) return Response.json({ error: "Sign in first." }, { status: 401 });
  let question = "";
  try { question = String(((await req.json()) as { message?: unknown }).message ?? "").trim(); } catch { /* handled below */ }
  const problem = questionProblem(question);
  if (problem) return Response.json({ error: problem }, { status: 400 });
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: object) => controller.enqueue(enc.encode(`${JSON.stringify(e)}\n`));
      try {
        const err = await askAndPost(supabase, userId, projectId, question, (text) => send({ type: "delta", text }));
        send(err ? { type: "error", message: err } : { type: "done" });
      } catch (e) {
        send({ type: "error", message: (e as Error).message.slice(0, 300) });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
}
