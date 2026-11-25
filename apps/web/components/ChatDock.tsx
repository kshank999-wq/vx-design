"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ChatForm } from "@/components/ChatForm";
import { ReadAloud } from "@/components/VoiceTools";

interface Msg { id: number; author_kind: string; body: string }

/**
 * The design agent's chat on every project page: a button in the corner that opens a panel with the latest
 * conversation and a box to ask or comment (typed or dictated). Hidden on the pages that already show the chat
 * (the workspace and the run pages). Open or closed is remembered for the browser session.
 */
export function ChatDock({ projectId, messages, action }: {
  projectId: string; messages: Msg[]; action: (form: FormData) => void | Promise<void>;
}) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => { try { setOpen(sessionStorage.getItem("vx-chat-dock") === "open"); } catch { /* storage blocked */ } }, []);
  const toggle = () => setOpen((o) => { try { sessionStorage.setItem("vx-chat-dock", o ? "closed" : "open"); } catch { /* storage blocked */ } return !o; });
  if (/\/workspace(\/|$)/.test(path) || /\/runs\/[^/]+$/.test(path)) return null;
  return (
    <div className={`chat-dock${open ? " open" : ""}`} data-testid="chat-dock">
      {open && (
        <section className="chat-dock-panel card" aria-label="Chat with the design agent">
          <div className="row spread"><strong>Design agent</strong>
            <span className="row tight"><Link className="small" href={`/projects/${projectId}/workspace`}>Full chat</Link>
              <button type="button" className="btn btn-secondary" onClick={toggle} aria-label="Close the chat">✕</button></span></div>
          <p className="small muted">Ask a question or leave a comment for the design work, from any page.</p>
          <ol className="chat chat-dock-log">
            {[...messages].reverse().map((m) => (
              <li key={m.id} className={`msg msg-${m.author_kind}`}>
                <div className="msg-body">{m.body.replace(/^\[about question [0-9a-f-]{36}\]\s*/, "")}</div>
                {m.author_kind === "assistant" && <div className="msg-tools"><ReadAloud text={m.body} /></div>}
              </li>))}
            {!messages.length && <li className="muted small">No messages yet.</li>}
          </ol>
          <ChatForm projectId={projectId} action={action} />
        </section>
      )}
      {!open && <button type="button" className="btn chat-dock-button" onClick={toggle} data-testid="chat-dock-open">💬 Ask the design agent</button>}
    </div>
  );
}
