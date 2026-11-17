import Link from "next/link";
import { notFound } from "next/navigation";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Banner } from "@/components/Banner";
import { SubmitButton } from "@/components/SubmitButton";
import { requireUser } from "@/lib/auth";
import { addModel, decideModel } from "./actions";

const STATUS: Record<string, { label: string; pill: string }> = {
  pending: { label: "waiting for the KiCad worker", pill: "pill-ready" },
  checking: { label: "checking", pill: "pill-running" },
  checked: { label: "checked: verify it", pill: "pill-awaiting_approval" },
  inconclusive: { label: "check inconclusive: verify by eye", pill: "pill-awaiting_approval" },
  check_failed: { label: "check failed", pill: "pill-failed" },
  verified: { label: "verified", pill: "pill-complete" },
  rejected: { label: "rejected", pill: "pill-canceled" },
};

interface Check {
  problems?: string[]; warnings?: string[]; orientation?: string; terminals?: number; pads?: number;
  worst_offset_mm?: number | null; body_mm?: { x: number; y: number; z: number };
}

export default async function ModelsPage({ params, searchParams }: {
  params: Promise<{ projectId: string }>; searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { projectId } = await params;
  const { error, notice } = await searchParams;
  const { supabase, userId } = await requireUser();
  const { data: project } = await supabase.from("projects").select("name").eq("id", projectId).maybeSingle();
  if (!project) notFound();
  const [{ data: models }, { data: me }] = await Promise.all([
    supabase.from("part_models").select("*, parts(mpn, manufacturer)").eq("project_id", projectId).order("created_at", { ascending: false }),
    supabase.from("project_members").select("role").eq("project_id", projectId).eq("user_id", userId).maybeSingle(),
  ]);
  const role = me?.role ?? "viewer";
  const canAdd = role === "owner" || role === "engineer";
  const canDecide = canAdd || role === "reviewer";
  const paths = (models ?? []).flatMap((m) => [m.overlay_path, m.storage_path]).filter((p): p is string => !!p);
  const { data: signed } = paths.length ? await supabase.storage.from("project-files").createSignedUrls(paths, 3600) : { data: [] };
  const url = new Map((signed ?? []).map((s) => [s.path, s.signedUrl]));
  const busy = (models ?? []).some((m) => m.status === "pending" || m.status === "checking");

  return (
    <main>
      <p className="crumbs"><Link href="/projects">Projects</Link> / <Link href={`/projects/${projectId}`}>{project.name}</Link> /</p>
      <div className="row spread"><h1>3D model library</h1>{busy && <AutoRefresh />}</div>
      <Banner error={error} notice={notice} />
      <p className="small muted">
        Manufacturer STEP models for this project&apos;s parts. The KiCad worker aligns each model to its footprint (it finds the
        orientation that puts every terminal on a pad) and draws an overlay. A person verifies it before layouts use it in place of
        KiCad&apos;s generic package shape. Models stay private to this project unless marked shared.
      </p>

      {canAdd && (
        <details className="card" open={!models?.length}>
          <summary><strong>Add a model</strong></summary>
          <form className="stack" action={addModel.bind(null, projectId)}>
            <div className="grid2">
              <label>Manufacturer part number<input name="mpn" required placeholder="AP2112K-3.3TRG1" /></label>
              <label>Manufacturer<input name="manufacturer" required placeholder="Diodes Incorporated" /></label>
              <label>KiCad footprint<input name="footprint" required placeholder="Package_TO_SOT_SMD:SOT-23-5" /></label>
              <label>Body height from the datasheet (mm, optional)<input name="height_mm" inputMode="decimal" /></label>
              <label>Source<input name="source" required placeholder="Manufacturer website, OEM drawing pack ..." /></label>
              <label>Licence / terms<input name="license" placeholder="e.g. free for design use; NDA" /></label>
              <label>STEP or ZIP file<input type="file" name="file" accept=".step,.stp,.zip" /></label>
              <label>…or an https URL to one<input name="url" type="url" placeholder="https://..." /></label>
            </div>
            <label className="row"><input type="checkbox" name="shared" /> Shared: public manufacturer CAD other projects may use (never for NDA files)</label>
            <SubmitButton pendingText="Adding…">Add to the library</SubmitButton>
          </form>
        </details>
      )}

      {!models?.length && <p className="muted">No models yet.</p>}
      {(models ?? []).map((m) => {
        const part = m.parts as unknown as { mpn: string; manufacturer: string };
        const c = (m.check_result ?? {}) as Check;
        const st = STATUS[m.status] ?? { label: m.status, pill: "" };
        return (
          <div key={m.id} className="card model" data-model={part.mpn}>
            <div className="row spread">
              <h3><span className="mono">{part.mpn}</span> <span className="muted">· {part.manufacturer} · {m.footprint}</span></h3>
              <span className={`pill ${st.pill}`} data-testid="model-status">{st.label}</span>
            </div>
            <p className="small muted">
              {m.source}{m.source_url && <> · <a href={m.source_url} target="_blank" rel="noreferrer">source</a></>}
              {m.license && <> · {m.license}</>} · {m.shared ? "shared" : "private to this project"}
              {m.storage_path && url.get(m.storage_path) && <> · <a href={url.get(m.storage_path)!} download>aligned STEP</a></>}
            </p>
            {m.overlay_path && url.get(m.overlay_path) && (
              <img className="overlay" src={url.get(m.overlay_path)!} alt={`Overlay of ${part.mpn} on ${m.footprint}`} />
            )}
            {c.terminals !== undefined && (
              <p className="small" data-testid="model-check">
                {c.terminals} of {c.pads} terminals on pads (worst {c.worst_offset_mm ?? "—"} mm outside), placed {c.orientation};
                body {c.body_mm?.x} x {c.body_mm?.y} x {c.body_mm?.z} mm
              </p>
            )}
            {(c.problems ?? []).map((p, i) => <p key={i} className="small error-text">{p}</p>)}
            {(c.warnings ?? []).map((w, i) => <p key={i} className="small warn-text">{w}</p>)}
            {m.error && !(c.problems ?? []).length && <p className="small error-text">{m.error}</p>}
            {m.status === "verified" && <p className="small">Verified {m.verified_at && new Date(m.verified_at).toLocaleString()}{m.decision_note && `: ${m.decision_note}`}</p>}
            {canDecide && ["checked", "inconclusive"].includes(m.status) && (
              <form className="stack" action={decideModel.bind(null, projectId, m.id, true)}>
                <label>Note{m.status === "inconclusive" && " (required: what you confirmed by eye)"}
                  <input name="note" placeholder="e.g. leads on pads; pin 1 dot at pad 1" /></label>
                <div className="row">
                  <SubmitButton pendingText="Verifying…">Verify model</SubmitButton>
                  <SubmitButton formAction={decideModel.bind(null, projectId, m.id, false)} variant="secondary" pendingText="Rejecting…">Reject</SubmitButton>
                </div>
              </form>
            )}
          </div>
        );
      })}
    </main>
  );
}
