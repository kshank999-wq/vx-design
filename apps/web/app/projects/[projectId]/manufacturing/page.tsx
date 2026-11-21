import Link from "next/link";
import { notFound } from "next/navigation";
import {
  fitsBuildVolumes, massEstimate, needsFromRequirements, optionByKey, printSettings, PROD_PROCESSES, PRODUCTION_MATERIALS, PROTO_PROCESSES,
  PROTOTYPE_OPTIONS, prodMaterialLabel, prodProcessLabel, stlStats, suggestPrototypes, type PartNeeds, type StlStats,
} from "@vx/dfm";
import { Banner } from "@/components/Banner";
import { InputsUpload } from "@/components/InputsUpload";
import { SubmitButton } from "@/components/SubmitButton";
import { requireUser } from "@/lib/auth";
import { partModels, type PartModel, type Route } from "@/lib/manufacturing";
import { removeRoute, saveRoute, chooseSuggestion } from "./actions";

export const maxDuration = 60;

const procLabel = (k: string) => PROTO_PROCESSES.find((p) => p.key === k)?.label ?? k;
const NEEDS: [keyof PartNeeds, string][] = [
  ["outdoor", "Used outdoors or in sun"], ["impact", "Gets dropped or knocked"], ["snap_fits", "Has snap fits or clips"],
  ["cosmetic", "Seen by clients (photos, reviews)"], ["precise", "Tight fits or sliding parts"], ["flexible", "Rubber-like part"], ["clear", "Clear (window, lens)"],
];

/** How each physical part is made now (prototype) and later (production), with material suggestions and the 3D-printing export. */
export default async function ManufacturingPage({ params, searchParams }: {
  params: Promise<{ projectId: string }>; searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { projectId } = await params;
  const { error, notice } = await searchParams;
  const { supabase, userId } = await requireUser();
  const [{ data: project }, { data: me }, { data: rows }, { data: reqs }, models] = await Promise.all([
    supabase.from("projects").select("name").eq("id", projectId).maybeSingle(),
    supabase.from("project_members").select("role").eq("project_id", projectId).eq("user_id", userId).maybeSingle(),
    supabase.from("part_routes").select("*").eq("project_id", projectId).order("name"),
    supabase.from("requirements").select("text, status").eq("project_id", projectId).neq("status", "rejected"),
    partModels(supabase, projectId),
  ]);
  if (!project) notFound();
  const canEdit = me?.role === "owner" || me?.role === "engineer";
  const routes = (rows ?? []) as Route[];
  const fromReqs = needsFromRequirements((reqs ?? []).map((r) => r.text));
  const modelOf = (r: Route) => models.find((m) => m.key === r.source_key) ?? null;
  const unrouted = models.filter((m) => !routes.some((r) => r.source_key === m.key));

  // Size and volume from each routed part's STL.
  const stats = new Map<string, StlStats>();
  await Promise.all(routes.map(async (r) => {
    const stl = modelOf(r)?.stl;
    if (!stl) return;
    const { data } = await supabase.storage.from("project-files").download(stl.path);
    if (!data) return;
    try { stats.set(r.id, stlStats(new Uint8Array(await data.arrayBuffer()))); } catch { /* not readable: no size shown */ }
  }));
  const allPaths = models.flatMap((m) => [m.stl?.path, m.step?.path].filter((p): p is string => !!p));
  const { data: signed } = allPaths.length ? await supabase.storage.from("project-files").createSignedUrls(allPaths, 3600, { download: true }) : { data: [] };
  const dl = new Map<string, string>((signed ?? []).filter((s) => s.path && s.signedUrl).map((s) => [s.path!, s.signedUrl!]));
  const fileLinks = (m: PartModel | null) => m ? <>{[m.stl, m.step].filter((f): f is NonNullable<typeof f> => !!f).map((f) =>
    <span key={f.path}>{dl.get(f.path) ? <a href={dl.get(f.path)}>{f.name}</a> : f.name} </span>)}<span className="muted">({m.origin})</span></> : <span className="muted">no model yet</span>;

  const routeFields = (r: Route | null, defaults: { name: string; source_key: string | null; needs: PartNeeds }) => {
    const n = r?.needs ?? defaults.needs;
    const tag = ` ${r?.name ?? defaults.name}`;
    return <>
      <input type="hidden" name="source_key" value={r?.source_key ?? defaults.source_key ?? ""} />
      <div className="grid2">
        <label className="span2">Part name<input name="name" required defaultValue={r?.name ?? defaults.name} aria-label={`Part name${tag}`} /></label>
        <fieldset className="span2"><legend className="small">What the part has to survive</legend>
          <div className="row">{NEEDS.map(([k, l]) => <label key={k} className="inline small"><input type="checkbox" name={k} defaultChecked={!!n[k]} aria-label={`${l}${tag}`} /> {l}</label>)}
            <label className="inline small">Hottest it gets (°C)<input name="max_temp_c" type="number" min={0} max={400} defaultValue={n.max_temp_c ?? ""} aria-label={`Hottest${tag}`} style={{ width: "6em" }} /></label></div>
        </fieldset>
        <label>Production process<select name="production_process" defaultValue={r?.production_process ?? ""} aria-label={`Production process${tag}`}>
          <option value="">Not decided</option>{PROD_PROCESSES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</select></label>
        <label>Production material<select name="production_material" defaultValue={r?.production_material ?? ""} aria-label={`Production material${tag}`}>
          <option value="">Not decided</option>{PRODUCTION_MATERIALS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}</select></label>
        <label>Production volume (a year)<input name="production_volume" type="number" min={1} defaultValue={r?.production_volume ?? ""} aria-label={`Production volume${tag}`} /></label>
        <label>Prototypes needed<input name="prototype_qty" type="number" min={1} defaultValue={r?.prototype_qty ?? 1} aria-label={`Prototypes needed${tag}`} /></label>
        <label className="span2">Prototype material<select name="prototype_option" defaultValue={r?.prototype_option ?? ""} aria-label={`Prototype material${tag}`}>
          <option value="">Choose from the suggestions after saving</option>
          {PROTO_PROCESSES.map((p) => <optgroup key={p.key} label={p.label}>{PROTOTYPE_OPTIONS.filter((o) => o.process === p.key).map((o) => <option key={o.key} value={o.key}>{o.material}</option>)}</optgroup>)}</select></label>
        <label className="span2">Colour and finish<input name="finish" defaultValue={r?.finish ?? ""} aria-label={`Finish${tag}`} placeholder="matte black, light texture (MT-11010)" /></label>
        <label className="span2">Notes<textarea name="notes" rows={2} defaultValue={r?.notes ?? ""} aria-label={`Route notes${tag}`} /></label>
      </div>
    </>;
  };

  return (
    <main>
      <p className="crumbs"><Link href="/projects">Projects</Link> / <Link href={`/projects/${projectId}`}>{project.name}</Link> /</p>
      <h1>Manufacturing routes</h1>
      <p className="muted">For each physical part: how it is made now (printed, cast or machined prototypes) and how it will be made in production
        (injection molded, machined, sheet metal). The plan and the enclosure design read these routes, so prototypes are designed for the
        production process from the start. Suggestions rank prototype materials by what the part must survive and how well they stand in for the
        production material; they are starting points, not a datasheet.</p>
      <Banner error={error} notice={notice} />

      <section>
        <h2>Parts to make</h2>
        {routes.map((r) => {
          const o = optionByKey(r.prototype_option);
          const s = stats.get(r.id);
          const sugg = suggestPrototypes({ ...r.needs, quantity: r.prototype_qty }, { process: r.production_process, material: r.production_material });
          const mass = o && s ? massEstimate(o, s.volume_cm3) : null;
          const fit = o && s ? fitsBuildVolumes(s.size_mm).find((b) => b.process === o.process) : null;
          return (
            <div key={r.id} className="card stack" data-route={r.name}>
              <h3>{r.name}</h3>
              <p className="small">{fileLinks(modelOf(r))}{s && <> · {s.size_mm.join(" × ")} mm, {s.volume_cm3} cm³</>}</p>
              <dl className="facts small" data-testid="route-summary">
                <dt>Prototype</dt><dd>{o ? `${o.material}, ${procLabel(o.process)}` : <span className="muted">not chosen</span>}{r.prototype_qty ? ` × ${r.prototype_qty}` : ""}
                  {mass && <span className="muted"> · about {mass[0] === mass[1] ? mass[0] : `${mass[0]} to ${mass[1]}`} g each</span>}
                  {fit && !fit.fits && <span className="warn-text"> · too big for a {fit.label}</span>}</dd>
                <dt>Production</dt><dd>{r.production_process ? `${prodProcessLabel(r.production_process)}${r.production_material ? `, ${prodMaterialLabel(r.production_material)}` : ""}` : <span className="muted">not decided</span>}
                  {r.production_volume ? `, about ${r.production_volume.toLocaleString("en-US")} a year` : ""}</dd>
                {r.finish && <><dt>Finish</dt><dd>{r.finish}</dd></>}
                {o && r.production_process === "injection_molding" && r.production_material && !o.stands_in_for.includes(r.production_material) &&
                  <><dt>Note</dt><dd className="warn-text">{o.material} behaves differently from {prodMaterialLabel(r.production_material)}: use these prints for fit and form, not for strength or drop sign-off.</dd></>}
              </dl>
              <details open={!o} data-testid="suggestions"><summary className="small"><strong>Suggested prototype materials</strong></summary>
                <table className="small">
                  <thead><tr><th>Material</th><th>Why</th><th>Watch out</th><th /></tr></thead>
                  <tbody>{sugg.map((x, i) => (
                    <tr key={x.option.key} data-option={x.option.key}>
                      <td><strong>{i + 1}. {x.option.material}</strong><div className="muted">{procLabel(x.option.process)}</div></td>
                      <td>{[...x.reasons, x.option.good_for].join(". ").replace(/\.\./g, ".")}</td>
                      <td>{[...x.cautions, x.option.watch_out].join(". ").replace(/\.\./g, ".")}</td>
                      <td className="right">{r.prototype_option === x.option.key ? <span className="pill pill-complete">chosen</span> : canEdit && (
                        <form action={chooseSuggestion.bind(null, projectId, r.id, x.option.key)}><SubmitButton variant="secondary" pendingText="…">{`Use ${x.option.material}`}</SubmitButton></form>)}</td>
                    </tr>
                  ))}{!sugg.length && <tr><td colSpan={4} className="muted">No prototype option meets every need; relax one (for example the temperature) or choose machining.</td></tr>}</tbody>
                </table>
              </details>
              {o && <details className="small" data-testid="settings"><summary>How to print or order it</summary><ul>{printSettings(o).lines.map((l) => <li key={l}>{l}</li>)}</ul></details>}
              {canEdit && (
                <details><summary className="small">Edit route</summary>
                  <form action={saveRoute.bind(null, projectId, r.id)} className="stack">
                    {routeFields(r, { name: r.name, source_key: r.source_key, needs: r.needs })}
                    <div className="row"><SubmitButton variant="secondary" pendingText="…">Save route</SubmitButton></div>
                  </form>
                  <form action={removeRoute.bind(null, projectId, r.id)}><SubmitButton variant="secondary" pendingText="…">{`Remove ${r.name}`}</SubmitButton></form>
                </details>
              )}
            </div>
          );
        })}
        {unrouted.map((m) => (
          <div key={m.key} className="card stack" data-model={m.label}>
            <h3>{m.label} <span className="pill">no route yet</span></h3>
            <p className="small">{fileLinks(m)}</p>
            {canEdit && (
              <details><summary className="small">Set up its route</summary>
                <form action={saveRoute.bind(null, projectId, null)} className="stack">
                  {routeFields(null, { name: m.label, source_key: m.key, needs: fromReqs })}
                  <p className="small muted">“What the part has to survive” is pre-filled from the requirements; check it.</p>
                  <div className="row"><SubmitButton pendingText="Saving…">Save route</SubmitButton></div>
                </form>
              </details>
            )}
          </div>
        ))}
        {!routes.length && !unrouted.length && <p className="muted" data-testid="no-parts">No parts yet. Run an enclosure task, upload a part model below, or add a part without a model.</p>}
      </section>

      {canEdit && (
        <section>
          <h2>Add a part</h2>
          <div className="grid2">
            <div className="card stack"><h3 className="small">Upload a part model</h3>
              <p className="small muted">An STL or STEP from your CAD tool (a bezel, a button, a bracket). It is checked, stored, and appears above.</p>
              <InputsUpload projectId={projectId} mode="model" /></div>
            <details className="card" data-testid="add-route"><summary className="small"><strong>A part without a model yet</strong></summary>
              <form action={saveRoute.bind(null, projectId, null)} className="stack">
                {routeFields(null, { name: "", source_key: null, needs: fromReqs })}
                <div className="row"><SubmitButton pendingText="Saving…">Add part</SubmitButton></div>
              </form></details>
          </div>
        </section>
      )}

      <section className="card">
        <h2>Export for 3D printing</h2>
        <p className="small muted">A ZIP with one folder per part (STL to print, STEP for a service that prefers it), a print sheet with the material,
          settings, quantity, size, material estimate and what each print stands in for, and parts.csv for a print service&apos;s order form.</p>
        {routes.length ? (
          <form method="get" action={`/projects/${projectId}/manufacturing/print-pack`} className="stack" data-testid="print-export">
            <div className="row">{routes.map((r) => {
              const o = optionByKey(r.prototype_option);
              return <label key={r.id} className="inline small"><input type="checkbox" name="route" value={r.id}
                defaultChecked={!o || ["fdm", "sla", "sls_mjf"].includes(o.process)} aria-label={`Export ${r.name}`} /> {r.name}
                {!modelOf(r)?.stl && <span className="muted"> (no STL yet)</span>}</label>;
            })}</div>
            <div className="row"><button className="btn btn-primary" type="submit">Export for 3D printing</button></div>
          </form>
        ) : <p className="small muted">Set up a route for at least one part first.</p>}
      </section>
    </main>
  );
}
