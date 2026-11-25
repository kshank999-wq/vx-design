import Link from "next/link";
import { SubmitButton } from "@/components/SubmitButton";
import type { ProposalState } from "@/lib/plan-proposals";
import { DictateButton, ReadAloud } from "@/components/VoiceTools";
import { PlanChangeCard, type ChangeData } from "@/components/PlanChangeCard";

export interface RunChatStep { id: string; key: string; title: string; why: string }
interface Msg { id: number; author_kind: string; body: string; data?: unknown }

/** The run page's chat: ask the design agent, or give a step guidance for its next attempt. */
export function RunChat({ projectId, steps, messages, selected, action, canWrite, proposals = {}, canDraft = false }: {
  projectId: string; steps: RunChatStep[]; messages: Msg[]; selected: string | null;
  action: (form: FormData) => void | Promise<void>; canWrite: boolean; proposals?: Record<string, ProposalState>; canDraft?: boolean;
}) {
  return (
    <aside className="card run-chat" id="run-chat" data-testid="run-chat" aria-label="Chat with the design agent">
      <h2>Talk to the design agent</h2>
      <p className="small muted">Ask what went wrong, give a step guidance, or give <strong>new orders</strong>. New information (a decision, a change of
        direction) pauses the run: the agent compares it with the plan, the concepts and the mock-ups, lists any differences and proposes the
        updated plan for you to confirm before anything continues.</p>
      <ol className="chat run-chat-log">
        {[...messages].reverse().map((m) => (
          <li key={m.id} className={`msg msg-${m.author_kind}`}>
            <div className="msg-body">{m.body}</div>
            {m.author_kind === "assistant" && <div className="msg-tools"><ReadAloud text={m.body} /></div>}
            {m.author_kind === "assistant" && !!m.data && <PlanChangeCard projectId={projectId} messageId={m.id} data={m.data as ChangeData} state={proposals[String(m.id)] ?? null} canDraft={canDraft} />}
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
