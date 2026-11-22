import Link from "next/link";
import { StageBar } from "@/components/StageBar";
import { STAGES, STAGE_NAME, type StageRow } from "@/lib/stages";
import { notFound } from "next/navigation";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Banner } from "@/components/Banner";
import { SubmitButton } from "@/components/SubmitButton";
import { loadContext, type Citation } from "@/lib/assistant";
import { requireUser } from "@/lib/auth";
import { decideFromWorkspace, draftPlanChange, sendMessage } from "./actions";
import { ChatForm } from "@/components/ChatForm";
import { describePlanChange, type PlanChange } from "@vx/planning";

export const maxDuration = 120;

const ICON: Record<string, string> = {
  complete: "✓", awaiting_approval: "!", running: "◐", validating: "◐", ready: "○", draft: "○",
  blocked: "✕", failed: "✕", canceled: "–", superseded: "–",
};
const LABEL: Record<string, string> = {
  complete: "Done", awaiting_approval: "Approval needed", running: "Working", validating: "Checking", ready: "Queued",
  draft: "Not started", blocked: "Blocked", failed: "Needs the team", canceled: "Canceled", superseded: "Replaced",
};

interface MessageData {
  model?: string; offline?: boolean; references?: string[]; suggested_requirement_change?: string | null; error?: boolean;
  citations?: Citation[]; suggested_plan_change?: PlanChange | null;
}

export default async function WorkspacePage({ params, searchParams }: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ view?: string; error?: string; notice?: string }>;
}) {
  const { projectId } = await params;
  const { view, error, notice } = await searchParams;
  const { supabase, userId } = await requireUser();
  const ctx = await loadContext(supabase, projectId);
  if (!ctx) notFound();
  const [{ data: me }, { data: messages }, { data: verification }, { data: openFaults }, { data: stageBoard }] = await Promise.all([
    supabase.from("project_members").select("role").eq("project_id", projectId).eq("user_id", userId).maybeSingle(),
    supabase.from("project_messages").select("id, author_kind, body, data, created_at").eq("project_id", projectId).order("id").limit(200),
    supabase.rpc("requirement_verification", { p_project_id: projectId }),
    supabase.from("faults").select("id").eq("project_id", projectId).in("status", ["open", "corrected"]),
    supabase.rpc("stage_status", { p_project: projectId }),
  ]);
  // Stage gates: the current stage and what stands before its sign-off.
  const board = (stageBoard ?? []) as StageRow[];
  const cur = board.find((x) => x.current);
  const signed = board.filter((x) => x.status === "signed_off").length;
  const stageStep = !cur ? "complete" : cur.blockers.length ? "awaiting_approval" : "running";
  // S6: build and validation, summarised from the verification matrix.
  const vm = (verification ?? []) as { status: string }[];
  const vVerified = vm.filter((x) => x.status === "verified").length, vFailing = vm.filter((x) => x.status === "failing").length;
  const vTested = vm.some((x) => x.status !== "no_procedure" && x.status !== "not_tested");
  const valStep = !vm.length || !vTested ? "draft" : vFailing || (openFaults ?? []).length ? "blocked" : vVerified === vm.length ? "complete" : "running";
  const role = me?.role ?? "viewer";
  const canDraft = role === "owner" || role === "engineer";
  // Plans already drafted from a chat message, so the button turns into a link.
  const { data: chatPlans } = canDraft ? await supabase.from("plans").select("id, generator").eq("project_id", projectId).not("generator->>chat_message_id", "is", null) : { data: [] };
  const drafted = new Map((chatPlans ?? []).map((p) => [String((p.generator as { chat_message_id?: string }).chat_message_id), p.id as string]));
  const canDecide = ["owner", "reviewer", "client"].includes(role);
  const approvalFor = new Map(ctx.approvals.map((a) => [a.task_id, a]));
  const outputsOf = (key: string) => ctx.outputs.filter((o) => o.task_key === key);
  const outputName = new Map(ctx.outputs.map((o) => [o.id, o.name]));
  const done = ctx.tasks.filter((t) => t.status === "complete").length;
  const live = ctx.tasks.some((t) => ["running", "validating", "ready"].includes(t.status))
    || ctx.concepts.rounds.some((r) => r.status === "queued" || r.status === "generating");
  const selected = view && ctx.outputs.find((o) => o.id === view);
  const showConcepts = view === "concepts";
  const c = ctx.concepts;
  const conceptsBusy = c.rounds.some((r) => r.status === "queued" || r.status === "generating");
  const conceptsReady = c.rounds.some((r) => r.status === "ready" || r.status === "partial");
  // The first checklist step: concept and design freeze (S1), ahead of the engineering plan.
  const conceptStep = c.freeze ? "complete" : conceptsBusy ? "running" : conceptsReady ? "awaiting_approval" : "draft";
  const href = (v?: string) => `/projects/${projectId}/workspace${v ? `?view=${v}` : ""}`;
  // Prefer the reports people read (power budget, fit report, BOM, DRC) over raw files when pointing at a task's result.
  const PREFERRED = ["power-budget", "fit-report", "sourced-bom", "fab-package", "drc-report", "kicad-project", "erc-report", "design", "brief"];
  const mainOutput = (key: string) => {
    const outs = outputsOf(key);
    return PREFERRED.map((p) => outs.find((o) => o.name.endsWith(`/${p}`))).find(Boolean) ?? outs[0];
  };

  return (
    <main className="workspace">
      <div className="ws-head">
        <p className="crumbs">{role === "client" ? <Link href="/projects">Projects</Link> : <><Link href="/projects">Projects</Link> / <Link href={`/projects/${projectId}`}>{ctx.project.name}</Link></>} /</p>
        <h1>{ctx.project.name} <span className="muted small">workspace</span></h1>
        {role !== "client" && <StageBar supabase={supabase} projectId={projectId} />}
        <Banner error={error} notice={notice} />
      </div>

      <section className="ws-chat card panel" aria-label="Project chat">
        <h2 className="panel-head">Design agent</h2>
        <ol className="chat" data-testid="chat">
          {(messages ?? []).map((m) => {
            const d = (m.data ?? {}) as MessageData;
            return (
              <li key={m.id} className={`msg msg-${m.author_kind}`}>
                <div className="msg-body">{m.body}</div>
                {d.suggested_requirement_change && (
                  <div className="small warn-text">Suggested requirement change, for the team to review: {d.suggested_requirement_change}</div>
                )}
                {d.suggested_plan_change && (
                  <div className="small warn-text" data-testid="plan-change">Proposed plan change: {describePlanChange(d.suggested_plan_change)}.
                    {drafted.get(String(m.id)) ? <> <Link href={`/projects/${projectId}/plans/${drafted.get(String(m.id))}`}>Drafted as a plan version</Link>.</>
                      : canDraft ? <form action={draftPlanChange.bind(null, projectId, m.id)} className="inline">{" "}<SubmitButton variant="secondary" pendingText="Drafting…">Draft this plan change</SubmitButton></form>
                      : " The team can draft it as a new plan version."}
                  </div>
                )}
                {!!d.references?.length && (
                  <div className="small">{d.references.filter((r) => outputName.has(r)).map((r) => (
                    <Link key={r} href={href(r)} className="ref">{outputName.get(r)!.split("/").pop()}</Link>
                  ))}</div>
                )}
                {!!d.citations?.length && (
                  <ul className="small cites" data-testid="citations">{d.citations.map((c) => (
                    <li key={c.ref}>[{c.ref}] {c.source_id ? <Link href={`/knowledge/sources/${c.source_id}`}>{c.text}</Link> : c.text}
                      {c.url && <> · <a href={c.url} target="_blank" rel="noreferrer">official</a></>}</li>
                  ))}</ul>
                )}
                {m.author_kind === "assistant" && d.model && <div className="muted small">{d.model}</div>}
              </li>
            );
          })}
          {!messages?.length && <li className="muted small">Ask about progress, a report, or what needs your approval.</li>}
        </ol>
        <ChatForm projectId={projectId} action={sendMessage.bind(null, projectId, selected ? selected.id : null)} />
      </section>

      <section className="ws-view card panel" aria-label="Results">
        <h2 className="panel-head panel-head-blue">Design viewer</h2>
        {showConcepts ? (
          <>
            <div className="row spread">
              <Link href={href()}>← Overview</Link>
              <Link href={`/projects/${projectId}/concepts`} target="_blank">Open in a new tab</Link>
            </div>
            <iframe className="ws-frame" src={`/projects/${projectId}/concepts?embed=1`} title="Concepts" data-testid="concepts-viewer" />
          </>
        ) : selected ? (
          <>
            <div className="row spread">
              <Link href={href()}>← Overview</Link>
              <Link href={`/projects/${projectId}/artifacts/${selected.id}`} target="_blank">Open in a new tab</Link>
            </div>
            <iframe className="ws-frame" src={`/projects/${projectId}/artifacts/${selected.id}?embed=1`} title={selected.name} data-testid="viewer" />
          </>
        ) : (
          <div data-testid="overview">
            <h3>Overview</h3>
            {ctx.plan ? (
              <>
                <p>{ctx.plan.summary}</p>
                <div className="progress" aria-label={`${done} of ${ctx.tasks.length} tasks done`}>
                  <span style={{ width: `${ctx.tasks.length ? (100 * done) / ctx.tasks.length : 0}%` }} />
                </div>
                <p className="small muted">{done} of {ctx.tasks.length} steps done · {ctx.approvals.length} waiting for approval · {ctx.requirements.length} requirements</p>
              </>
            ) : <p className="muted">The team is still turning the specification into a plan. Results will appear here as work completes.</p>}
            <h3>Results</h3>
            <div className="tiles">
              <Link href={href("concepts")} className="tile" data-testid="concepts-tile">
                <strong>Concepts</strong>
                <span className="small">{c.freeze ? `Design frozen: ${c.freeze.name}` : c.rounds.length ? `${c.rounds.length} round(s); no design freeze yet` : "No concepts yet: ask for a first round"}</span>
                <span className={`pill pill-${c.freeze ? "complete" : "awaiting_approval"}`}>{c.freeze ? "frozen" : conceptsBusy ? "generating" : "open"}</span>
              </Link>
              {ctx.tasks.filter((t) => mainOutput(t.key)).map((t) => {
                const o = mainOutput(t.key)!;
                return (
                  <Link key={t.id} href={href(o.id)} className="tile">
                    <strong>{t.title}</strong>
                    <span className="small">{o.summary ?? o.name}</span>
                    <span className={`pill pill-${o.status === "committed" ? "complete" : "awaiting_approval"}`}>{o.status === "committed" ? "approved" : "for review"}</span>
                  </Link>
                );
              })}
              {!ctx.outputs.length && <p className="muted small">No engineering results yet.</p>}
            </div>
          </div>
        )}
      </section>

      <aside className="ws-checklist card panel" aria-label="Checklist" data-testid="checklist">
        <div className="row spread panel-head"><h2>Agent activity</h2>{live && <AutoRefresh intervalMs={4000} />}</div>
        <ol className="checklist">
          <li className={`check check-${stageStep}`} data-status={stageStep} data-testid="stage-step">
            <span className="check-icon" aria-hidden>{ICON[stageStep]}</span>
            <div>
              <div><Link href={`/projects/${projectId}/stages`}>{cur ? `Stage ${cur.stage}: ${STAGE_NAME[cur.stage]}` : "All stages signed off"}</Link></div>
              {cur?.stage === "S0" && <div className="small"><Link href={`/projects/${projectId}/wizard`} data-testid="wizard-link">Answer the requirement wizard</Link></div>}
              <div className="small muted">{signed} of 9 stages signed off{cur ? (cur.blockers.length ? ` · ${cur.blockers.length} item(s) before sign-off` : " · ready to sign off") : ""}</div>
            </div>
          </li>
          <li className={`check check-${conceptStep}`} data-status={conceptStep} data-testid="concept-step">
            <span className="check-icon" aria-hidden>{ICON[conceptStep]}</span>
            <div>
              <div><Link href={href("concepts")}>Concept and design freeze</Link></div>
              <div className="small muted">{c.freeze ? `Frozen: ${c.freeze.name}` : conceptsBusy ? "Generating concepts" : conceptsReady ? "Approval needed: choose a concept and freeze the design" : "Not started"}</div>
            </div>
          </li>
          {STAGES.map((stage) => {
            const ts = ctx.tasks.filter((t) => t.stage === stage);
            if (!ts.length) return null;
            const done = ts.filter((t) => t.status === "complete").length;
            const active = ts.some((t) => t.status !== "complete");
            return (
              <li key={stage} className="check-stage" data-stage={stage}>
                <details open={active}>
                  <summary><span className="stage-code">{stage}</span> {STAGE_NAME[stage]} <span className="muted small">{done}/{ts.length}</span></summary>
                  <ol className="checklist">
                  {ts.map((t) => {
            const a = approvalFor.get(t.id);
            const o = mainOutput(t.key);
            return (
              <li key={t.id} className={`check check-${t.status}`} data-status={t.status}>
                <span className="check-icon" aria-hidden>{ICON[t.status] ?? "○"}</span>
                <div>
                  <div>{o ? <Link href={href(o.id)}>{t.title}</Link> : t.title}</div>
                  <div className="small muted">{LABEL[t.status] ?? t.status}</div>
                  {a && (
                    <div className="approval-stop" data-testid="approval-stop">
                      <div className="small"><strong>Approval stop.</strong> {a.reason}</div>
                      {canDecide ? (
                        <form className="stack" action={decideFromWorkspace.bind(null, projectId, t.id, true)}>
                          <textarea name="note" rows={2} placeholder="Note (required to return)" aria-label={`Note for ${t.title}`} />
                          <div className="row tight">
                            <SubmitButton pendingText="Approving…">Approve</SubmitButton>
                            <SubmitButton variant="danger" formAction={decideFromWorkspace.bind(null, projectId, t.id, false)} pendingText="Returning…">Return</SubmitButton>
                          </div>
                        </form>
                      ) : <div className="small muted">Waiting for the client or a reviewer.</div>}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
                  </ol>
                </details>
              </li>
            );
          })}
          {!ctx.tasks.length && <li className="muted small">The engineering steps appear once the plan is approved.</li>}
          <li className={`check check-${valStep}`} data-status={valStep} data-testid="validation-step">
            <span className="check-icon" aria-hidden>{ICON[valStep]}</span>
            <div>
              <div><Link href={`/projects/${projectId}/validation`}>Build and validation</Link></div>
              <div className="small muted">{!vTested ? "No hardware tests recorded yet"
                : `${vVerified} of ${vm.length} requirement(s) verified by test${vFailing ? `; ${vFailing} failing` : ""}${(openFaults ?? []).length ? `; ${(openFaults ?? []).length} fault(s) open` : ""}`}</div>
            </div>
          </li>
        </ol>
      </aside>
    </main>
  );
}
