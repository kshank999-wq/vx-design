import Link from "next/link";
import { notFound } from "next/navigation";
import { Banner } from "@/components/Banner";
import { ModuleForm } from "@/components/ModuleForm";
import { SubmitButton } from "@/components/SubmitButton";
import { requireUser } from "@/lib/auth";
import { MODULE_KINDS, type ModuleRow } from "@/lib/modules";
import { saveModule, verifyModule } from "../actions";

export default async function ModulePage({ params, searchParams }: {
  params: Promise<{ moduleId: string }>; searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { moduleId } = await params;
  const { error, notice } = await searchParams;
  const { supabase } = await requireUser();
  const [{ data }, { data: canEdit }, { data: editor }] = await Promise.all([
    supabase.from("modules").select("*").eq("id", moduleId).maybeSingle(),
    supabase.rpc("is_directory_user"),
    supabase.rpc("is_knowledge_editor"),
  ]);
  if (!data) notFound();
  const m = data as ModuleRow;
  const s = m.supply, d = m.dimensions_mm;

  return (
    <main>
      <p className="crumbs"><Link href="/knowledge">Knowledge base</Link> / <Link href="/knowledge/modules">Modules</Link> /</p>
      <div className="row spread"><h1>{m.name}</h1>
        <span className={`pill big pill-${m.status === "verified" ? "complete" : "awaiting_approval"}`} data-testid="module-status">{m.status}</span></div>
      <Banner error={error} notice={notice} />
      <dl className="facts small card" data-testid="module-facts">
        <dt>Part</dt><dd>{m.manufacturer} {m.mpn} · {MODULE_KINDS[m.kind]}{m.part_id && " · in the parts catalog"}</dd>
        {m.description && <><dt>Description</dt><dd>{m.description}</dd></>}
        <dt>Radios</dt><dd>{m.radios.join(", ") || "—"}</dd>
        <dt>Interfaces</dt><dd>{m.interfaces.join(", ") || "—"}</dd>
        <dt>Supply</dt><dd>{s.v_min != null || s.v_max != null ? `${s.v_min ?? "?"}–${s.v_max ?? "?"} V` : "—"}{s.i_typ_ma != null && `, ${s.i_typ_ma} mA typical`}
          {s.i_max_ma != null && `, ${s.i_max_ma} mA peak`}{s.sleep_ua != null && `, ${s.sleep_ua} µA sleep`}</dd>
        <dt>Size</dt><dd>{d.x != null ? `${d.x} × ${d.y ?? "?"} × ${d.z ?? "?"} mm` : "—"}</dd>
        {Object.keys(m.performance).length > 0 && <><dt>Performance</dt><dd><ul>{Object.entries(m.performance).map(([k, v]) => <li key={k}>{k}: {v}</li>)}</ul></dd></>}
        <dt>Certifications</dt><dd data-testid="module-certs">{m.certifications.length ? <ul>{m.certifications.map((c) => (
          <li key={`${c.regime}-${c.id}`}><strong>{c.regime}</strong> {c.id}{c.holder && ` (${c.holder})`} · {c.source_url ? <a href={c.source_url} target="_blank" rel="noreferrer">source</a> : c.note}</li>
        ))}</ul> : "none recorded"}<div className="muted">A module's certification covers the module as tested. Using it in a product still needs the
          integration conditions in its grant (antenna, label, RF exposure) and the product's own tests.</div></dd>
        <dt>CAD</dt><dd>{m.cad.length ? m.cad.map((c) => <div key={c.url}>{c.kind}: <a href={c.url} target="_blank" rel="noreferrer">{c.url}</a></div>) : "—"}</dd>
        <dt>Lifecycle</dt><dd>{m.lifecycle.replace(/_/g, " ")}</dd>
        <dt>Source</dt><dd>{m.source_url ? <a href={m.source_url} target="_blank" rel="noreferrer">{m.source_url}</a> : m.source_note}{m.checked_on && `, read ${m.checked_on}`}</dd>
        <dt>Verified</dt><dd>{m.verified_at ? new Date(m.verified_at).toLocaleDateString() : "not yet"}</dd>
      </dl>
      {editor && m.status !== "verified" && (
        <form action={verifyModule.bind(null, m.id)} className="row tight"><SubmitButton variant="secondary" pendingText="…">Verify against the sources</SubmitButton></form>
      )}
      {canEdit && <details className="card"><summary>Edit</summary><ModuleForm action={saveModule.bind(null, m.id)} m={m} /></details>}
    </main>
  );
}
