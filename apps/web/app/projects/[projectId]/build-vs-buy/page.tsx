import Link from "next/link";
import { matchModules } from "@vx/planning";
import { Banner } from "@/components/Banner";
import { CostHint } from "@/components/CostHint";
import { SubmitButton } from "@/components/SubmitButton";
import { requireUser } from "@/lib/auth";
import { catalogModules, certsForRegions, guessKind, readNeed } from "@/lib/build-vs-buy";
import { MODULE_KINDS } from "@/lib/modules";
import { compareBuildVsBuy, findModules } from "./actions";

const SELECTION = /\b(select(ion)?|choose|choice|module|som|radio|camera|display|battery|charger)\b/i;

/**
 * Build versus buy: describe a subsystem, see which catalog modules meet it (and why the others do not), ask the AI
 * for more candidates (each confirmed at a distributor), and compare the fitting modules against a custom design.
 */
export default async function BuildVsBuyPage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { projectId } = await params;
  const sp = await searchParams;
  const { supabase } = await requireUser();
  const [{ data: intake }, { data: plan }] = await Promise.all([
    supabase.from("project_intake").select("regions, quantity").eq("project_id", projectId).maybeSingle(),
    supabase.from("plans").select("id, version").eq("project_id", projectId).order("version", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const { data: tasks } = plan ? await supabase.from("tasks").select("key, title, discipline").eq("plan_id", plan.id).in("discipline", ["components", "architecture", "power"]).order("position") : { data: [] };
  const starts = (tasks ?? []).filter((t) => SELECTION.test(`${t.key} ${t.title}`)).slice(0, 12);
  const defaults = { regions: certsForRegions((intake?.regions as string[] | null) ?? []).join(", "), quantity: intake?.quantity ? String(intake.quantity) : "" };
  const val = (k: string) => sp[k] ?? (k in defaults ? defaults[k as keyof typeof defaults] : "");
  const need = sp.title ? readNeed((k) => val(k) || null) : null;
  const matches = need ? matchModules(need, await catalogModules(supabase)) : [];
  const fits = matches.filter((m) => m.fits);
  const P = `/projects/${projectId}`;
  const hidden = need ? Object.entries({ title: val("title"), kind: need.kind, interfaces: val("interfaces"), radios: val("radios"), supply_v: val("supply_v"),
    max_x: val("max_x"), max_y: val("max_y"), max_z: val("max_z"), regions: val("regions"), quantity: val("quantity") }) : [];

  return (
    <main>
      <h1>Build vs buy</h1>
      <Banner error={sp.error} notice={sp.notice} />
      <p className="muted">Before a subsystem is designed from chips, check whether a ready-made module does the job: a certified radio module, a compute
        module, a camera, display or power module. Code checks each module in the <Link href="/knowledge/modules">modules catalog</Link> against what you
        need; the comparison then weighs the fitting modules against designing it yourself.</p>

      {starts.length > 0 && (
        <section className="card" data-testid="from-plan">
          <h2>From the plan (v{plan!.version})</h2>
          <div className="row">{starts.map((t) => <Link key={t.key} className="pill" href={`${P}/build-vs-buy?title=${encodeURIComponent(t.title)}&kind=${guessKind(t.title)}&regions=${encodeURIComponent(defaults.regions)}&quantity=${defaults.quantity}`}>{t.title}</Link>)}</div>
        </section>
      )}

      <form className="card stack" method="get" data-testid="need-form">
        <h2>What is needed</h2>
        <div className="grid3">
          <label>Subsystem<input name="title" defaultValue={val("title")} required placeholder="e.g. Wireless link to the host" /></label>
          <label>Kind<select name="kind" defaultValue={need?.kind ?? ""}>
            <option value="">Guess from the name</option>{Object.entries(MODULE_KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label>Quantity<input name="quantity" type="number" min={1} defaultValue={val("quantity")} /></label>
          <label>Interfaces it must offer<input name="interfaces" defaultValue={val("interfaces")} placeholder="UART, USB, MIPI CSI-2" /></label>
          <label>Radios<input name="radios" defaultValue={val("radios")} placeholder="Wi-Fi, BLE" /></label>
          <label>Supply rail available (V)<input name="supply_v" type="number" step="0.1" defaultValue={val("supply_v")} /></label>
          <label>Space: length (mm)<input name="max_x" type="number" step="0.1" defaultValue={val("max_x")} /></label>
          <label>width (mm)<input name="max_y" type="number" step="0.1" defaultValue={val("max_y")} /></label>
          <label>height (mm)<input name="max_z" type="number" step="0.1" defaultValue={val("max_z")} /></label>
          <label>Certification needed (markets)<input name="regions" defaultValue={val("regions")} placeholder="FCC, ISED, CE/RED" /></label>
        </div>
        <div><button type="submit">Check the catalog</button></div>
      </form>

      {need && (
        <section className="card" data-testid="matches">
          <h2>Catalog modules for “{need.title}” ({MODULE_KINDS[need.kind] ?? need.kind})</h2>
          {matches.length ? (
            <table className="small"><thead><tr><th>Module</th><th>Status</th><th>Fits</th><th>Why not / not known</th></tr></thead>
              <tbody>{matches.map((m) => (
                <tr key={m.module.id} data-fits={m.fits ? "yes" : "no"}>
                  <td><Link href={`/knowledge/modules/${m.module.id}`}>{m.module.name}</Link> <span className="muted">{m.module.manufacturer} {m.module.mpn}</span></td>
                  <td>{m.module.status === "verified" ? "verified" : "draft"}</td>
                  <td>{m.fits ? (m.unknown.length ? "yes, so far" : "yes") : "no"}</td>
                  <td className="small">{[...m.misses, ...m.unknown.map((u) => `not known: ${u}`)].join("; ") || "—"}</td>
                </tr>))}</tbody></table>
          ) : <p className="muted">No {MODULE_KINDS[need.kind]?.toLowerCase() ?? "modules"} in the catalog yet.</p>}
          <div className="row" style={{ marginTop: 12 }}>
            <form action={findModules.bind(null, projectId)}>{hidden.map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
              <SubmitButton variant="secondary" pendingText="Asking…">Find more modules with AI</SubmitButton></form>
            <CostHint e={{ usd: 0.06, basis: "one short AI call; part numbers checked at distributors" }} />
            <form action={compareBuildVsBuy.bind(null, projectId)}>{hidden.map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
              <SubmitButton>Compare {fits.length ? `${Math.min(fits.length, 4)} module(s)` : "modules"} with a custom design</SubmitButton></form>
          </div>
          <p className="small muted">Suggestions are added to the catalog only when a distributor knows the part number, as drafts that say where they came
            from; a library editor verifies them against the datasheet. The comparison is a trade study you can edit before deciding.</p>
        </section>
      )}
    </main>
  );
}
