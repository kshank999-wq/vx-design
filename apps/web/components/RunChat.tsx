import Link from "next/link";
import { SubmitButton } from "@/components/SubmitButton";
import { DictateButton, ReadAloud } from "@/components/VoiceTools";

export interface RunChatStep { id: string; key: string; title: string; why: string }
interface Msg { id: number; author_kind: string; body: string }

/** The run page's chat: ask the design agent, or give a step guidance for its next attempt. */
export function RunChat({ projectId, steps, messages, selected, action, canWrite }: {
  projectId: string; steps: RunChatStep[]; messages: Msg[]; selected: string | null;
  action: (form: FormData) => void | Promise<void>; canWrite: boolean;
}) {
  return (
    <aside className="card run-chat" id="run-chat" data-testid="run-chat" aria-label="Chat with the design agent">
      <h2>Talk to the design agent</h2>
      <p className="small muted">Ask what went wrong, or tell a step how to do it differently. Guidance for a step is saved with it and its next attempt follows it.</p>
      <ol className="chat run-chat-log">
        {[...messages].reverse().map((m) => (
          <li key={m.id} className={`msg msg-${m.author_kind}`}>
            <div className="msg-body">{m.body}</div>
            {m.author_kind === "assistant" && <div className="msg-tools"><ReadAloud text={m.body} /></div>}
          </li>
        ))}
        {!messages.length && <li className="muted small">No messages yet.</li>}
      </ol>
      {canWrite ? (
        <form className="stack" action={action}>
          <label className="small">About
            <select name="task" defaultValue={steps.find((s) => s.key === selected)?.id ?? ""} data-testid="run-chat-step">
              <option value="">The run in general (a question)</option>
              {steps.map((s) => <option key={s.id} value={s.id}>{s.title} ({s.why})</option>)}
            </select>
          </label>
          <textarea id="run-chat-message" name="message" rows={4} required maxLength={4000}
            placeholder={selected ? "How should this step do it differently? e.g. use a 4-layer board, move the SoM to the centre…" : "Ask the design agent…"}
            aria-label="Message to the design agent" />
          <div className="row tight wrap">
            <SubmitButton pendingText="Sending…">Send</SubmitButton>
            <DictateButton target="run-chat-message" />
          </div>
        </form>
      ) : <p className="small muted">Only project members can write here.</p>}
      <p className="small"><Link href={`/projects/${projectId}/workspace`}>Full chat in the Workspace</Link></p>
    </aside>
  );
}
