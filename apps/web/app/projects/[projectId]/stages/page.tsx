import Link from "next/link";
import { notFound } from "next/navigation";
import { Banner } from "@/components/Banner";
import { SubmitButton } from "@/components/SubmitButton";
import { requireUser } from "@/lib/auth";
import { STAGE_NAME, type StageRow } from "@/lib/stages";
import { reopenStage, setStageGates, signOffStage } from "./actions";

const WHERE: Partial<Record<string, string>> = { S0: "risks", S1: "concepts", S6: "validation" };

export default async function StagesPage({ params, searchParams }: {
  params: Promise<{ projectId: string }>; searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { projectId } = await params;
  const { error, notice } = await searchParams;
  const { supabase, userId } = await requireUser();
  const [{ data: project }, { data: me }, { data: board, error: e }] = await Promise.all([
    supabase.from("projects").select("name, stage_gates").eq("id", projectId).maybeSingle(),
    supabase.from("project_members").select("role").eq("project_id", projectId).eq("user_id", userId).maybeSingle(),
    supabase.rpc("stage_status", { p_project: projectId }),
  ]);
  if (!project) notFound();
  const role = me?.role ?? "viewer";
  const canSign = role === "owner" || role === "reviewer";
  const stages = (board ?? []) as StageRow[];

  return (
    <main>
      <p className="crumbs"><Link href="/projects">Projects</Link> / <Link href={`/projects/${projectId}`}>{project.name}</Link> /</p>
      <h1>Stages</h1>
      <p className="muted">The product moves through nine stages. Each is signed off by an owner or reviewer once its work is done and its
        high risks are handled; the owner can sign off past open items with a written reason, which is kept. With stage gates on,
        tasks of a later stage start only after every earlier stage is signed off.</p>
      <Banner error={error ?? e?.message} notice={notice} />
      <p className="row" data-testid="gates">
        <span className={`pill pill-${project.stage_gates ? "complete" : "awaiting_approval"}`}>Stage gates {project.stage_gates ? "on" : "off"}</span>
        {role === "owner" && <form action={setStageGates.bind(null, projectId, !project.stage_gates)}>
          <SubmitButton variant="secondary" pendingText="…">{project.stage_gates ? "Turn stage gates off" : "Turn stage gates on"}</SubmitButton></form>}
      </p>
      <ol className="list" data-testid="stages">
        {stages.map((s) => (
          <li key={s.stage} className={`card${s.current ? " card-current" : ""}`} data-stage={s.stage} data-status={s.status}>
            <div className="row spread">
              <h2>{s.stage} · {STAGE_NAME[s.stage]} {s.current && <span className="pill pill-running">current</span>}</h2>
              <span className={`pill pill-${s.status === "signed_off" ? "complete" : s.status === "reopened" ? "failed" : "awaiting_approval"}`}>
                {s.status === "signed_off" ? "signed off" : s.status}</span>
            </div>
            <p className="small muted">
              {s.tasks_total ? `${s.tasks_done} of ${s.tasks_total} task(s) done` : "No plan tasks in this stage"}
              {s.risks_open ? ` · ${s.risks_open} risk(s) open or being mitigated` : ""}
              {WHERE[s.stage] && <> · <Link href={`/projects/${projectId}/${WHERE[s.stage]}`}>{s.stage === "S0" ? "intake and risks" : WHERE[s.stage]}</Link></>}
            </p>
            {s.status === "signed_off" ? (
              <>
                {s.note && <p className="small">Note: {s.note}</p>}
                {s.waived.length > 0 && <div className="small" data-testid="waived">Signed off past:<ul>{s.waived.map((b, i) => <li key={i}>{b.text}</li>)}</ul></div>}
                {role === "owner" && (
                  <details><summary>Reopen</summary>
                    <form action={reopenStage.bind(null, projectId, s.stage)} className="row">
                      <input name="reason" required placeholder="Why it needs another look" aria-label={`Reason to reopen ${s.stage}`} />
                      <SubmitButton variant="secondary" pendingText="…">Reopen {s.stage}</SubmitButton>
                    </form>
                  </details>
                )}
              </>
            ) : (
              <>
                {s.reopen_reason && <p className="small">Reopened: {s.reopen_reason}</p>}
                {s.unlocked && (s.blockers.length > 0
                  ? <div className="small" data-testid={`blockers-${s.stage}`}>Before sign-off:<ul>{s.blockers.map((b, i) => <li key={i}>{b.text}</li>)}</ul></div>
                  : <p className="small" data-testid={`blockers-${s.stage}`}>Nothing open: ready to sign off.</p>)}
                {canSign && s.unlocked && (
                  <form action={signOffStage.bind(null, projectId, s.stage)} className="row">
                    <input name="note" placeholder={s.blockers.length ? "Why it is fine to proceed (required to sign off past open items)" : "Note (optional)"}
                           aria-label={`Sign-off note for ${s.stage}`} />
                    {s.blockers.length > 0 && role === "owner" &&
                      <label className="inline small"><input type="checkbox" name="waive" aria-label={`Sign off ${s.stage} past open items`} /> sign off past open items</label>}
                    <SubmitButton pendingText="…">Sign off {s.stage}</SubmitButton>
                  </form>
                )}
                {!s.unlocked && <p className="small muted">Earlier stages first.</p>}
              </>
            )}
          </li>
        ))}
      </ol>
    </main>
  );
}
