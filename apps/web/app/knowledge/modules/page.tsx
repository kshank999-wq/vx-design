import Link from "next/link";
import { Banner } from "@/components/Banner";
import { ModuleForm } from "@/components/ModuleForm";
import { requireUser } from "@/lib/auth";
import { MODULE_KINDS, type ModuleRow } from "@/lib/modules";
import { saveModule } from "./actions";

export default async function ModulesPage({ searchParams }: {
  searchParams: Promise<{ error?: string; notice?: string; kind?: string; radio?: string; cert?: string; q?: string }>;
}) {
  const { error, notice, kind, radio, cert, q } = await searchParams;
  const { supabase } = await requireUser();
  const [{ data: rows }, { data: canEdit }] = await Promise.all([
    supabase.from("modules").select("*").order("name"),
    supabase.rpc("is_directory_user"),
  ]);
  const all = (rows ?? []) as ModuleRow[];
  const has = (xs: string[], t?: string) => !t || xs.some((x) => x.toLowerCase().includes(t.toLowerCase()));
  const shown = all.filter((m) => (!kind || m.kind === kind) && has(m.radios, radio) && has(m.certifications.map((c) => c.regime), cert)
    && (!q || `${m.name} ${m.manufacturer} ${m.mpn} ${m.description ?? ""}`.toLowerCase().includes(q.toLowerCase())));

  return (
    <main>
      <p className="crumbs"><Link href="/knowledge">Knowledge base</Link> /</p>
      <h1>Modules</h1>
      <p className="muted">Radio modules, systems on module and development boards worth reusing instead of a custom design: interfaces, supply,
        size, lifecycle and regulatory certifications, each certification with where it was read. Use them as options in trade studies; the
        compliance page notes certified modules found in a project&apos;s BOM. Entries are checked by a library editor against their sources.</p>
      <Banner error={error} notice={notice} />
      <form className="row tight small" data-testid="module-filter">
        <select name="kind" defaultValue={kind ?? ""} aria-label="Filter kind"><option value="">all kinds</option>{Object.entries(MODULE_KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <input name="radio" defaultValue={radio ?? ""} placeholder="radio, e.g. Bluetooth" aria-label="Filter radio" />
        <input name="cert" defaultValue={cert ?? ""} placeholder="certification, e.g. FCC" aria-label="Filter certification" />
        <input name="q" defaultValue={q ?? ""} placeholder="name or part number" aria-label="Search modules" />
        <button className="btn" type="submit">Filter</button>
      </form>
      <table className="small" data-testid="modules">
        <thead><tr><th>Module</th><th>Kind</th><th>Radios / interfaces</th><th>Supply</th><th>Certifications</th><th>Lifecycle</th><th>Status</th></tr></thead>
        <tbody>{shown.map((m) => (
          <tr key={m.id} data-mpn={m.mpn}>
            <td><Link href={`/knowledge/modules/${m.id}`}><strong>{m.name}</strong></Link><div className="muted">{m.manufacturer} {m.mpn}</div></td>
            <td>{MODULE_KINDS[m.kind]}</td>
            <td>{[...m.radios, ...m.interfaces].join(", ") || "—"}</td>
            <td>{m.supply.v_min != null || m.supply.v_max != null ? `${m.supply.v_min ?? "?"}–${m.supply.v_max ?? "?"} V` : "—"}</td>
            <td>{m.certifications.map((c) => `${c.regime} ${c.id}`).join(" · ") || "—"}</td>
            <td>{m.lifecycle.replace(/_/g, " ")}</td>
            <td><span className={`pill pill-${m.status === "verified" ? "complete" : "awaiting_approval"}`}>{m.status}</span></td>
          </tr>
        ))}{!shown.length && <tr><td colSpan={7} className="muted">{all.length ? "No modules match." : "No modules yet."}</td></tr>}</tbody>
      </table>
      {canEdit && <details className="card" open={!all.length || !!error}><summary>Add a module</summary><ModuleForm action={saveModule.bind(null, null)} /></details>}
    </main>
  );
}
