import Link from "next/link";
import { notFound } from "next/navigation";
import { TRADE_TEMPLATES } from "@vx/planning";
import { Banner } from "@/components/Banner";
import { SubmitButton } from "@/components/SubmitButton";
import { requireUser } from "@/lib/auth";
import { STAGE_NAME, STAGES } from "@/lib/stages";
import { DECISION_CLASSES, studyCode, type Study } from "@/lib/trades";
import { createStudy } from "./actions";

export default async function TradesPage({ params, searchParams }: {
  params: Promise<{ projectId: string }>; searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { projectId } = await params;
  const { error, notice } = await searchParams;
  const { supabase, userId } = await requireUser();
  const [{ data: project }, { data: me }, { data: studies }] = await Promise.all([
    supabase.from("projects").select("name").eq("id", projectId).maybeSingle(),
    supabase.from("project_members").select("role").eq("project_id", projectId).eq("user_id", userId).maybeSingle(),
    supabase.from("trade_studies").select("*").eq("project_id", projectId).order("study_no", { ascending: false }),
  ]);
  if (!project) notFound();
  const canEdit = me?.role === "owner" || me?.role === "engineer";

  return (
    <main>
      <p className="crumbs"><Link href="/projects">Projects</Link> / <Link href={`/projects/${projectId}`}>{project.name}</Link> /</p>
      <h1>Trade studies</h1>
      <p className="muted">Compare options against weighted criteria: module or custom design, which part, which approach. Each score keeps its
        basis; part costs, stock and lifecycle can be filled from the parts catalog. The ranking is calculated, not judged, and says when a
        different weighting would change the winner. Deciding records a project decision with the evidence.</p>
      <Banner error={error} notice={notice} />
      <ul className="list" data-testid="studies">
        {((studies ?? []) as Study[]).map((s) => {
          const chosen = s.options.find((o) => o.key === s.chosen_option)?.name;
          const lead = s.result?.ranking[0];
          return (
            <li key={s.id} data-study={studyCode(s.study_no)} data-status={s.status}>
              <Link href={`/projects/${projectId}/trades/${s.id}`}><strong>{studyCode(s.study_no)}</strong> {s.question}</Link>{" "}
              <span className="pill">{s.stage}</span>{" "}
              <span className={`pill pill-${s.status === "decided" ? "complete" : s.status === "withdrawn" ? "" : "awaiting_approval"}`}>{s.status}</span>
              <div className="small muted">{s.options.length} option(s), {s.criteria.length} criteria
                {s.status === "decided" ? ` · chose ${chosen}` : lead?.total != null ? ` · leading: ${lead.name} (${lead.total})` : ""}</div>
            </li>
          );
        })}
        {!studies?.length && <li className="muted">No trade studies yet.</li>}
      </ul>
      {canEdit && (
        <form action={createStudy.bind(null, projectId)} className="card stack">
          <h2>New trade study</h2>
          <label>Question<input name="question" required placeholder="Bluetooth: pre-certified module or chip-down?" /></label>
          <div className="grid2">
            <label>Start from<select name="template" defaultValue="module_vs_custom">
              {Object.entries(TRADE_TEMPLATES).map(([k, t]) => <option key={k} value={k}>{t.label}</option>)}</select></label>
            <label>Stage<select name="stage" defaultValue="S2">{STAGES.map((s) => <option key={s} value={s}>{s} {STAGE_NAME[s]}</option>)}</select></label>
            <label>Decision type<select name="decision_class" defaultValue="component_selection">
              {DECISION_CLASSES.map((c) => <option key={c} value={c}>{c.replace(/_/g, " ")}</option>)}</select></label>
          </div>
          <div><SubmitButton pendingText="Starting…">Start study</SubmitButton></div>
        </form>
      )}
    </main>
  );
}
