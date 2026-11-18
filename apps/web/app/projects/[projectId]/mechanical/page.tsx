import Link from "next/link";
import { notFound } from "next/navigation";
import { Banner } from "@/components/Banner";
import { SubmitButton } from "@/components/SubmitButton";
import { requireUser } from "@/lib/auth";
import { KIND_LABEL, mechCode, VERDICT } from "@/lib/mech";
import { addAnalysis } from "./actions";

type Row = { id: string; analysis_no: number; kind: string; title: string; verdict: string; assumptions: number; reviewed_at: string | null;
             result: Record<string, unknown>; inputs: Record<string, unknown> };

/** One line with the numbers that matter for each kind. */
function headline(a: Row): string {
  if (a.kind === "tolerance_stack") {
    const s = a.result as { nominal: number; worst: { min: number; max: number }; rss: { min: number; max: number } };
    return `gap ${s.nominal} mm nominal; worst case ${s.worst.min} to ${s.worst.max}; statistical ${s.rss.min} to ${s.rss.max} mm`;
  }
  if (a.kind === "gasket") {
    const g = a.result as { compression_pct: { min: number; max: number }; fill_pct: number | null };
    return `compression ${g.compression_pct.min}–${g.compression_pct.max}%${g.fill_pct != null ? `, groove fill up to ${g.fill_pct}%` : ""}`;
  }
  const t = a.result as { air_c: number; air_rise_c: number; sources: { name: string; tj_c: number | null }[] };
  const hot = [...(t.sources ?? [])].filter((s) => s.tj_c != null).sort((x, y) => y.tj_c! - x.tj_c!)[0];
  return `internal air ${t.air_c} °C (+${t.air_rise_c} °C)${hot ? `; hottest part ${hot.name} at ${hot.tj_c} °C` : ""}`;
}

export default async function MechanicalPage({ params, searchParams }: {
  params: Promise<{ projectId: string }>; searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { projectId } = await params;
  const { error, notice } = await searchParams;
  const { supabase, userId } = await requireUser();
  const [{ data: project }, { data: me }, { data: rows }] = await Promise.all([
    supabase.from("projects").select("name").eq("id", projectId).maybeSingle(),
    supabase.from("project_members").select("role").eq("project_id", projectId).eq("user_id", userId).maybeSingle(),
    supabase.from("mech_analyses").select("*").eq("project_id", projectId).order("analysis_no"),
  ]);
  if (!project) notFound();
  const canEdit = me?.role === "owner" || me?.role === "engineer";

  return (
    <main>
      <p className="crumbs"><Link href="/projects">Projects</Link> / <Link href={`/projects/${projectId}`}>{project.name}</Link> /</p>
      <h1>Mechanical checks</h1>
      <p className="muted">Tolerance stacks (worst case and statistical), gasket compression and groove fill, and a first-order estimate of how
        hot the inside of the enclosure gets. Calculated, not judged: each result shows its inputs, and inputs that are assumptions rather than a
        supplier&apos;s or datasheet figure are counted, so you know what to replace. These are design checks, not a substitute for testing.</p>
      <Banner error={error} notice={notice} />
      {canEdit && (
        <div className="row tight" data-testid="add-analysis">
          {[["enclosure_stacks", "Stacks from the enclosure"], ["thermal", "Thermal estimate from the power budget"], ["gasket", "Gasket check"], ["blank", "Blank stack"]].map(([w, label]) => (
            <form key={w} action={addAnalysis.bind(null, projectId)}><input type="hidden" name="what" value={w} />
              <SubmitButton variant="secondary" pendingText="…">{label}</SubmitButton></form>
          ))}
        </div>
      )}
      <table className="small" data-testid="analyses">
        <thead><tr><th>Analysis</th><th>Kind</th><th>Result</th><th>Verdict</th><th>Review</th></tr></thead>
        <tbody>{((rows ?? []) as Row[]).map((a) => (
          <tr key={a.id} data-title={a.title} data-verdict={a.verdict}>
            <td><Link href={`/projects/${projectId}/mechanical/${a.id}`}><strong>{mechCode(a.analysis_no)}</strong> {a.title}</Link></td>
            <td>{KIND_LABEL[a.kind]}</td>
            <td>{headline(a)}{a.assumptions > 0 && <div className="muted">rests on {a.assumptions} assumed input(s)</div>}</td>
            <td><span className={`pill pill-${VERDICT[a.verdict]?.[1] ?? ""}`}>{VERDICT[a.verdict]?.[0] ?? a.verdict}</span></td>
            <td>{a.reviewed_at ? "reviewed" : <span className="muted">not reviewed</span>}</td>
          </tr>
        ))}{!rows?.length && <tr><td colSpan={5} className="muted">No analyses yet.</td></tr>}</tbody>
      </table>
    </main>
  );
}
