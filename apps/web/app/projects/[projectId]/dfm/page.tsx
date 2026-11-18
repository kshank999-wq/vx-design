import { Fragment } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  boardFactsFromFabCheck, checkBoard, checkEnclosure, enclosureFactsFromFitReport, FAB_PROFILE_FACTS, PROCESSES,
  type BoardFacts, type CheckResult, type EnclosureFacts, type Process, type Rules,
} from "@vx/dfm";
import { requireUser } from "@/lib/auth";

const VERDICT: Record<CheckResult["verdict"], [string, string]> = {
  fits: ["fits", "complete"], does_not_fit: ["does not fit", "failed"], incomplete: ["incomplete", "awaiting_approval"],
};
const ORDER = { fits: 0, incomplete: 1, does_not_fit: 2 };

async function latestJson(supabase: Awaited<ReturnType<typeof requireUser>>["supabase"], projectId: string, suffix: string) {
  const { data } = await supabase.from("artifact_versions").select("storage_path, version, committed_at, artifacts!inner(name)")
    .eq("project_id", projectId).eq("status", "committed").like("artifacts.name", `%/${suffix}`)
    .order("committed_at", { ascending: false }).limit(1).maybeSingle();
  if (!data?.storage_path) return null;
  const { data: blob } = await supabase.storage.from("project-files").download(data.storage_path);
  if (!blob) return null;
  try { return { json: JSON.parse(await blob.text()), name: (data.artifacts as unknown as { name: string }).name, version: data.version }; }
  catch { return null; }
}

/** The project's board and enclosure checked against every supplier's recorded process rules. */
export default async function DfmPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const { supabase } = await requireUser();
  const [{ data: project }, fab, fit, { data: rows }] = await Promise.all([
    supabase.from("projects").select("name").eq("id", projectId).maybeSingle(),
    latestJson(supabase, projectId, "fab-check"),
    latestJson(supabase, projectId, "fit-report"),
    supabase.from("process_rules").select("id, process, rules, verified_at, checked_on, manufacturers(id, display_name, status)"),
  ]);
  if (!project) notFound();
  const board: BoardFacts | null = fab ? boardFactsFromFabCheck(fab.json, FAB_PROFILE_FACTS[fab.json.profile as string]) : null;
  const enclosure: EnclosureFacts | null = fit ? enclosureFactsFromFitReport(fit.json) : null;
  const results = (rows ?? []).flatMap((r) => {
    const m = r.manufacturers as unknown as { id: string; display_name: string; status: string };
    const p = r.process as Process;
    const res = p === "pcb_fab" || p === "pcb_assembly" ? (board ? checkBoard(p, r.rules as Rules, board) : null)
      : enclosure ? checkEnclosure(p, r.rules as Rules, enclosure) : null;
    return res ? [{ id: r.id, m, verified: !!r.verified_at, checked_on: r.checked_on, res }] : [];
  }).sort((a, b) => ORDER[a.res.verdict] - ORDER[b.res.verdict] || a.m.display_name.localeCompare(b.m.display_name));
  const label = (p: string) => PROCESSES.find((x) => x.key === p)?.label ?? p;

  return (
    <main>
      <p className="crumbs"><Link href="/projects">Projects</Link> / <Link href={`/projects/${projectId}`}>{project.name}</Link> /</p>
      <h1>Manufacturing fit</h1>
      <p className="muted">The committed board and enclosure, measured, against what each supplier says it can make (their process rules in the
        supplier directory). "Incomplete" means a value is not measured or the supplier has not stated a limit: it is not a pass. Rules
        not yet verified by a library editor are marked.</p>
      <section className="grid2">
        <div className="card small" data-testid="board-facts">
          <h2>Board</h2>
          {board ? <>
            <p className="muted">From {fab!.name} v{fab!.version} ({fab!.json.profile ?? "unknown profile"}).</p>
            <p>{board.width_mm} × {board.height_mm} mm · {board.copper_layers} layers · track {board.min_track_mm ?? "?"} mm ·
              clearance {board.min_clearance_mm ?? "?"} mm · drill {board.min_drill_mm ?? "?"} mm · {board.thickness_mm ?? "?"} mm {board.finish ?? ""}</p>
            <p>Smallest passive {board.smallest_passive ?? "none"} · {board.bottom_parts ? "parts on both sides" : "parts on top only"} ·
              {board.through_hole ? " through-hole parts" : " SMD only"}{board.bga ? " · BGA" : ""}</p>
          </> : <p className="muted">No committed fab package yet: board checks run once one exists.</p>}
        </div>
        <div className="card small" data-testid="enclosure-facts">
          <h2>Enclosure</h2>
          {enclosure ? <>
            <p className="muted">From {fit!.name} v{fit!.version}.</p>
            <p>{enclosure.process ?? "?"}{enclosure.material ? `, ${enclosure.material}` : ""} · walls {enclosure.wall_mm ?? "?"} mm ·
              {enclosure.dimensions_mm ? ` ${enclosure.dimensions_mm.join(" × ")} mm` : " size not measured"}</p>
          </> : <p className="muted">No committed enclosure yet.</p>}
        </div>
      </section>
      <section>
        <h2>Suppliers</h2>
        <table className="small" data-testid="fit">
          <thead><tr><th>Supplier</th><th>Process</th><th>Result</th><th>Why</th></tr></thead>
          <tbody>{results.map(({ id, m, verified, checked_on, res }) => (
            <Fragment key={id}>
              <tr data-supplier={m.display_name} data-process={res.process} data-verdict={res.verdict}>
                <td><Link href={`/suppliers/${m.id}#rules`}>{m.display_name}</Link>{!verified && <div className="muted">rules not verified{checked_on ? ` · read ${checked_on}` : ""}</div>}</td>
                <td>{label(res.process)}</td>
                <td><span className={`pill pill-${VERDICT[res.verdict][1]}`}>{VERDICT[res.verdict][0]}</span></td>
                <td>{res.items.filter((i) => i.status !== "pass").map((i) => <div key={i.check}>{i.check}: {i.design} vs {i.limit}{i.note ? ` (${i.note})` : ""}</div>)}
                  {res.verdict === "fits" && "every stated limit met"}
                  <details><summary>All checks</summary><ul>{res.items.map((i) => <li key={i.check}>{i.status === "pass" ? "✓" : i.status === "fail" ? "✗" : "?"} {i.check}: {i.design} vs {i.limit}</li>)}</ul></details></td>
              </tr>
            </Fragment>
          ))}{!results.length && <tr><td colSpan={4} className="muted">{rows?.length ? "Nothing to check yet: add a fab package or enclosure." : <>No supplier has process rules yet: add them on a supplier&apos;s page in the <Link href="/suppliers">directory</Link>.</>}</td></tr>}</tbody>
        </table>
      </section>
    </main>
  );
}
