"use client";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

/**
 * The workspace chat box. With JavaScript, the question is sent to the streaming endpoint and the reply appears as
 * it is written; the page then refreshes to show the stored exchange. Without it, the form posts to the server action.
 */
export function ChatForm({ projectId, action }: { projectId: string; action: (form: FormData) => void | Promise<void> }) {
  const router = useRouter();
  const box = useRef<HTMLTextAreaElement>(null);
  const [pending, setPending] = useState<{ question: string; answer: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    const question = (box.current?.value ?? "").trim();
    if (!question || typeof ReadableStream === "undefined") return;   // the browser's own validation, or the plain form post
    e.preventDefault();
    setError(null);
    setPending({ question, answer: "" });
    try {
      const res = await fetch(`/projects/${projectId}/workspace/chat`, { method: "POST", headers: { "Content-Type": "application/json" },
                                                                        body: JSON.stringify({ message: question }) });
      if (!res.ok || !res.body) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "", done = false;
      while (!done) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buf += dec.decode(chunk.value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const ev = JSON.parse(buf.slice(0, nl)) as { type: string; text?: string; message?: string };
          buf = buf.slice(nl + 1);
          if (ev.type === "delta") setPending((p) => p && { ...p, answer: p.answer + (ev.text ?? "") });
          else if (ev.type === "error") throw new Error(ev.message);
          else if (ev.type === "done") done = true;
        }
      }
      if (box.current) box.current.value = "";
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      // The refreshed page shows the stored exchange; drop the live copy once it has had time to arrive.
      setTimeout(() => setPending(null), 600);
    }
  }

  return (
    <>
      {pending && (
        <ol className="chat" data-testid="chat-live" aria-live="polite">
          <li className="msg msg-user"><div className="msg-body">{pending.question}</div></li>
          <li className="msg msg-assistant"><div className="msg-body" data-testid="chat-streaming">{pending.answer || "…"}</div></li>
        </ol>
      )}
      <form action={action} onSubmit={onSubmit} className="stack">
        <textarea ref={box} name="message" rows={3} required maxLength={4000} placeholder="Ask about the project…" aria-label="Message" />
        {error && <p role="alert" className="banner banner-error">{error}</p>}
        <div><button className="btn btn-primary" type="submit" disabled={!!pending}>{pending ? "Answering…" : "Send"}</button></div>
      </form>
    </>
  );
}
