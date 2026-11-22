import Link from "next/link";
import { StageBar } from "@/components/StageBar";
import { STAGES, STAGE_NAME, type StageRow } from "@/lib/stages";
import { notFound } from "next/navigation";
import { AutoRefresh } from "@/components/AutoRefresh";
import { plainCheck, verdict } from "@/lib/plain-checks";
import { Banner } from "@/components/Banner";
import { SubmitButton } from "@/components/SubmitButton";
import { loadContext, type Citation } from "@/lib/assistant";
import { requireUser } from "@/lib/auth";
import { answerQuestion, approvePassed, decideFromWorkspace, draftPlanChange, sendMessage } from "./actions";
import { PlainSummary } from "@/components/PlainSummary";
import { ChatForm } from "@/components/ChatForm";
import { CostHint } from "@/components/CostHint";
import { costHistory, estimate } from "@/lib/cost-estimate";
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
  // The latest steps the workers logged (staff only; clients see the checklist).
  const { data: activity } = await supabase.from("execution_logs").select("id, level, message, created_at, executions(tasks(key, title))")
    .eq("project_id", projectId).neq("level", "debug").order("id", { ascending: false }).limit(15);
  const [{ data: lastRun }, { data: plansAll }, { data: releases }, { data: reqStatus }] = await Promise.all([
    supabase.from("runs").select("id, status").eq("project_id", projectId).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("plans").select("id, version, status").eq("project_id", projectId).order("version", { ascending: false }).limit(1),
    supabase.from("releases").select("id, status").eq("project_id", projectId).limit(5),
    supabase.from("requirements").select("status").eq("project_id", projectId),
  ]);
  // VX Design's checks on each result waiting for approval (its latest attempt), shown in plain language.
  const waitIds = ctx.tasks.filter((t) => t.status === "awaiting_approval").map((t) => t.id);
  const { data: waitVals } = waitIds.length ? await supabase.from("validations").select("task_id, execution_id, kind, result, summary, created_at").in("task_id", waitIds).order("created_at", { ascending: false }) : { data: [] };
  const checksOf = (taskId: string) => {
    const rows = (waitVals ?? []).filter((v) => v.task_id === taskId);
    const exec = rows[0]?.execution_id;
    return rows.filter((v) => v.execution_id === exec);
  };
  // Questions only the owner can answer, raised by finished work; runs carry on with the recommendation meanwhile.
  const { data: questions } = await supabase.from("project_questions").select("id, question, why, recommendation, options, status, answer, answered_at, tasks(title)")
    .eq("project_id", projectId).order("created_at", { ascending: false }).limit(40);
  const openQs = (questions ?? []).filter((q) => q.status === "open");
  const answeredQs = (questions ?? []).filter((q) => q.status === "answered").slice(0, 8);
  const role = me?.role ?? "viewer";
  const canDraft = role === "owner" || role === "engineer";
  const chatCost = role !== "client" ? estimate(await costHistory(supabase, projectId), "chat") : null;
  // Plans already drafted from a chat message, so the button turns into a link.
  const { data: chatPlans } = canDraft ? await supabase.from("plans").select("id, generator").eq("project_id", projectId).not("generator->>chat_message_id", "is", null) : { data: [] };
  const drafted = new Map((chatPlans ?? []).map((p) => [String((p.generator as { chat_message_id?: string }).chat_message_id), p.id as string]));
  const canDecide = ["owner", "reviewer", "client"].includes(role);
  const canAnswer = ["owner", "engineer", "reviewer", "client"].includes(role);
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
        {role !== "client" && (() => {
          const P = `/projects/${projectId}`;
          const reqs = reqStatus ?? [];
          const open = reqs.filter((r) => r.status === "extracted" || r.status === "ambiguous").length;
          const latest = plansAll?.[0];
          const waitingN = ctx.tasks.filter((t) => t.status === "awaiting_approval").length;
          const doneN = ctx.tasks.filter((t) => t.status === "complete").length;
          const runActive = !!lastRun && ["pending", "running", "paused"].includes(lastRun.status);
          const steps: { key: string; label: string; state: "done" | "now" | "you" | "todo"; detail: string; href: string }[] = [
            { key: "inputs", label: "Inputs", state: reqs.length ? (open ? "you" : "done") : "now", detail: reqs.length ? (open ? `${open} requirement(s) to confirm` : `${reqs.length} requirements`) : "add specifications", href: `${P}/inputs` },
            { key: "concept", label: "Concept", state: c.freeze ? "done" : "you", detail: c.freeze ? `frozen: ${c.freeze.name}` : "freeze the mock-up or a concept", href: href("concepts") },
            { key: "plan", label: "Plan", state: ctx.plan ? "done" : latest ? "you" : "todo", detail: ctx.plan ? `v${ctx.plan.version} approved` : latest ? `v${latest.version} ${latest.status.replace("_", " ")}: approve it` : "not made yet", href: latest ? `${P}/plans/${latest.id}` : `${P}?tab=plans` },
            { key: "design", label: "Design run", state: !ctx.tasks.length ? "todo" : doneN === ctx.tasks.length ? "done" : runActive ? "now" : "you", detail: ctx.tasks.length ? `${doneN} of ${ctx.tasks.length} done${runActive ? ", running" : lastRun ? `, ${lastRun.status}` : ", not started"}` : "after the plan", href: lastRun ? `${P}/runs/${lastRun.id}` : `${P}/runs` },
            { key: "approvals", label: "Your approvals", state: waitingN || openQs.length ? "you" : "done", detail: [waitingN ? `${waitingN} waiting` : "", openQs.length ? `${openQs.length} question(s)` : ""].filter(Boolean).join(", ") || "none waiting", href: openQs.length && !waitingN ? "#questions" : "#approvals" },
            { key: "release", label: "Manufacturer package", state: (releases ?? []).some((r) => r.status === "released") ? "done" : (releases ?? []).length ? "you" : "todo", detail: (releases ?? []).length ? "draft release ready to check" : "at the end of the run", href: `${P}/releases` },
          ];
          return (
            <ol className="flow" data-testid="flow" aria-label="Where the project is">
              {steps.map((st, i) => (
                <li key={st.key} className={`flow-step flow-${st.state}`} data-state={st.state}>
                  <Link href={st.href}><span className="flow-n">{st.state === "done" ? "✓" : i + 1}</span>
                    <span><span className="flow-label">{st.label}</span><small>{st.state === "you" ? "Your turn: " : st.state === "now" ? "Working: " : ""}{st.detail}</small></span></Link>
                </li>
              ))}
            </ol>
          );
        })()}
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
        <CostHint e={chatCost} what="each question" />
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
                    <span className="small">{t.plain_summary ?? o.summary ?? o.name}</span>
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
        <div className="row spread panel-head"><h2>Agent activity</h2>{live && <><AutoRefresh intervalMs={4000} quiet />
          <span className="ws-live" data-testid="ws-live"><span className="live-strip-dot" aria-hidden="true" />{ctx.tasks.some((t) => ["running", "validating"].includes(t.status)) ? "Working" : "Live"}</span></>}</div>
        {(() => {
          const now = ctx.tasks.filter((t) => ["running", "validating"].includes(t.status));
          const wait = ctx.tasks.filter((t) => t.status === "awaiting_approval");
          const ago = (iso: string) => { const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000); return m < 1 ? "now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };
          return (
            <>
              {openQs.length > 0 && (
                <div className="ws-questions" id="questions" data-testid="ws-questions">
                  <p className="ws-approvals-head">{openQs.length} question{openQs.length > 1 ? "s" : ""} for you</p>
                  <p className="small">The work does not wait: VX Design follows its recommendation until you answer, and every later step uses your answer.</p>
                  {openQs.map((q) => (
                    <div key={q.id} className="ws-question" data-testid="question">
                      <div><strong>{q.question}</strong></div>
                      {q.why && <div className="small">{q.why}</div>}
                      <div className="small q-rec">Recommended: {q.recommendation}</div>
                      {(q.tasks as unknown as { title: string } | null)?.title && <div className="small muted">Raised by: {(q.tasks as unknown as { title: string }).title}</div>}
                      {canAnswer ? (
                        <form className="stack" action={answerQuestion.bind(null, projectId, q.id)}>
                          {(q.options ?? []).length > 0 && (
                            <div className="row tight wrap">{(q.options as string[]).map((o) => (
                              <button key={o} type="submit" name="answer" value={o} className="btn btn-secondary btn-small">{o}</button>
                            ))}</div>
                          )}
                          <input name="custom" placeholder="Or write your own answer" aria-label={`Your answer to: ${q.question}`} />
                          <div className="row tight">
                            <SubmitButton name="answer" value="__custom" pendingText="Saving…">Save my answer</SubmitButton>
                            <SubmitButton variant="secondary" name="answer" value="__recommended" pendingText="Saving…">Use the recommendation</SubmitButton>
                            <SubmitButton variant="secondary" name="answer" value="__dismiss" pendingText="Saving…">Not relevant</SubmitButton>
                          </div>
                        </form>
                      ) : <div className="small muted">The project owner answers this.</div>}
                    </div>
                  ))}
                </div>
              )}
              {wait.length > 0 && (
                <div className="ws-approvals" id="approvals" data-testid="ws-approvals">
                  <p className="ws-approvals-head">{wait.length} result{wait.length > 1 ? "s" : ""} ready for your go-ahead</p>
                  <p className="small">VX Design has checked each one. If its checks passed, approving lets the work move on; you do not need to read schematics.</p>
                  {canDecide && wait.some((t) => verdict(checksOf(t.id)).verdict !== "attention") && (
                    <form action={approvePassed.bind(null, projectId)} className="row tight" style={{ margin: "6px 0 10px" }}>
                      <SubmitButton pendingText="Approving…">Approve everything that passed ({wait.filter((t) => verdict(checksOf(t.id)).verdict !== "attention").length})</SubmitButton>
                    </form>
                  )}
                  {wait.map((t) => {
                    const a = approvalFor.get(t.id);
                    const o = mainOutput(t.key);
                    const checks = checksOf(t.id);
                    const v = verdict(checks);
                    return (
                      <div key={t.id} className="ws-approval" data-testid="approval-stop">
                        <div><strong>{t.title}</strong></div>
                        <PlainSummary text={t.plain_summary} />
                        <div className={`verdict verdict-${v.verdict}`} data-testid="verdict">{v.verdict === "passed" || v.verdict === "notes" ? "✓ " : v.verdict === "attention" ? "! " : ""}{v.label}</div>
                        {checks.length > 0 && <ul className="plain-checks">{checks.map((c, i) => { const p = plainCheck(c); return <li key={i} className={`pc-${p.level}`}>{p.level === "pass" ? "✓" : p.level === "note" ? "•" : "✕"} {p.text}</li>; })}</ul>}
                        <details className="small"><summary>See the full technical explanation</summary>
                          {a && <p>{a.reason}</p>}
                          <ul>{checks.map((c, i) => <li key={i}>{c.result}: {c.summary}</li>)}</ul>
                          {o && <p><Link href={href(o.id)}>Open the result in the viewer</Link></p>}
                        </details>
                        {canDecide ? (
                          <form className="stack" action={decideFromWorkspace.bind(null, projectId, t.id, true)}>
                            <textarea name="note" rows={2} placeholder="Note (required to return)" aria-label={`Note for ${t.title}`} />
                            <div className="row tight">
                              <SubmitButton pendingText="Approving…">Approve</SubmitButton>
                              <SubmitButton variant="danger" formAction={decideFromWorkspace.bind(null, projectId, t.id, false)} pendingText="Returning…">Return with note</SubmitButton>
                            </div>
                          </form>
                        ) : <div className="small muted">Waiting for the client or a reviewer.</div>}
                      </div>
                    );
                  })}
                </div>
              )}
              {now.length > 0 && <div className="ws-now" data-testid="ws-now"><strong>Working on:</strong> {now.map((t) => t.title).join(", ")}</div>}
              {answeredQs.length > 0 && (
                <details className="ws-log" data-testid="answered-questions">
                  <summary>Your answers ({answeredQs.length})</summary>
                  <ol>{answeredQs.map((q) => <li key={q.id}><span className="small">{q.question}</span> → <strong className="small">{q.answer}</strong></li>)}</ol>
                </details>
              )}
              {(activity ?? []).length > 0 && (
                <details className="ws-log" open data-testid="ws-log">
                  <summary>Recent activity</summary>
                  <ol>{(activity ?? []).map((l) => { const t = (l.executions as unknown as { tasks: { key: string; title: string } | null } | null)?.tasks;
                    return <li key={l.id} className={`log-${l.level}`}><span className="muted small">{ago(l.created_at)}</span> <span className="mono small">{t?.key}</span> {l.message.slice(0, 160)}</li>; })}</ol>
                </details>
              )}
            </>
          );
        })()}
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
                  {a && <div className="small"><a href="#approvals"><strong>Approval needed</strong>: see the top of this panel</a></div>}
                  {!a && t.status === "complete" && t.plain_summary && <PlainSummary text={t.plain_summary} href={o ? href(o.id) : null} />}
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
