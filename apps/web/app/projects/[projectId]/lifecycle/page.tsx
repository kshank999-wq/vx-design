import Link from "next/link";
import { SectionTabs } from "@/components/SectionTabs";
import { notFound } from "next/navigation";
import { assessPart, priceHistory, unitPriceAt, latestOffers, type OfferFact } from "@vx/planning";
import { Banner } from "@/components/Banner";
import { SubmitButton } from "@/components/SubmitButton";
import { requireUser } from "@/lib/auth";
import { CASE_PILL, caseCode, readSourcedBom, RISK_PILL, sourcedBomVersions } from "@/lib/lifecycle";
import { loadBom, openCase, recordNotice } from "./actions";

const money = (n: number | null | undefined, c = "USD") => n == null ? "—" : `${c === "USD" ? "$" : `${c} `}${n < 1 ? n.toFixed(4) : n.toFixed(2)}`;

export default async function LifecyclePage({ params, searchParams }: {
  params: Promise<{ projectId: string }>; searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { projectId } = await params;
  const { error, notice } = await searchParams;
  const { supabase, userId } = await requireUser();
  const [{ data: project }, { data: me }, { data: intake }, { data: loaded }, { data: cases }, boms, { data: releases }] = await Promise.all([
    supabase.from("projects").select("name").eq("id", projectId).maybeSingle(),
    supabase.from("project_members").select("role").eq("project_id", projectId).eq("user_id", userId).maybeSingle(),
    supabase.from("project_intake").select("quantity").eq("project_id", projectId).maybeSingle(),
    supabase.from("project_bom_parts").select("*").eq("project_id", projectId).order("line_no"),
    supabase.from("lifecycle_cases").select("*").eq("project_id", projectId).order("case_no", { ascending: false }),
    sourcedBomVersions(supabase, projectId),
    supabase.from("releases").select("revision, status, manifest").eq("project_id", projectId).in("status", ["released", "superseded"]).order("release_no"),
  ]);
  if (!project) notFound();
  const canEdit = me?.role === "owner" || me?.role === "engineer";
  const boards = intake?.quantity ?? 1;

  // The watch follows the most recently loaded BOM version.
  const loadedIds = [...new Set((loaded ?? []).map((l) => l.bom_version_id))];
  const current = boms.find((b) => loadedIds.includes(b.id));
  const lines = (loaded ?? []).filter((l) => l.bom_version_id === current?.id);
  const newer = boms[0] && boms[0].id !== current?.id ? boms[0] : null;
  const partIds = [...new Set(lines.map((l) => l.part_id).filter(Boolean))] as string[];
  const [{ data: parts }, { data: offers }, { data: notices }] = partIds.length ? await Promise.all([
    supabase.from("parts").select("id, mpn, manufacturer, lifecycle, lifecycle_raw").in("id", partIds),
    supabase.from("offers").select("part_id, seller, stock, currency, prices, observed_at, data_status").in("part_id", partIds).order("observed_at"),
    supabase.from("part_notices").select("*").in("part_id", partIds).order("recorded_at", { ascending: false }),
  ]) : [{ data: [] }, { data: [] }, { data: [] }];
  const part = new Map((parts ?? []).map((p) => [p.id, p]));
  const openCases = new Map((cases ?? []).filter((c) => c.status !== "resolved" && c.part_id).map((c) => [c.part_id as string, c]));
  const rows = lines.map((l) => {
    const p = l.part_id ? part.get(l.part_id) : null;
    const o = ((offers ?? []).filter((x) => x.part_id === l.part_id) as unknown as OfferFact[]);
    const n = (notices ?? []).filter((x) => x.part_id === l.part_id);
    const need = Math.ceil(Number(l.qty_per_board) * boards);
    const a = p ? assessPart({ lifecycle: p.lifecycle, notices: n, offers: o, need })
                : { risk: "low" as const, reasons: ["not in the parts catalog: run sourcing to watch it"], days_to_last_order: null, stock: null, sellers_in_stock: 0 };
    const best = latestOffers(o).map((x) => ({ price: unitPriceAt(x.prices, need), currency: x.currency ?? "USD" })).filter((x) => x.price != null)
      .sort((x, y) => x.price! - y.price!)[0];
    return { l, p, a, need, notices: n, best, history: priceHistory(o, need), fixture: o.some((x) => x.data_status === "fixture") };
  }).sort((x, y) => ({ high: 0, medium: 1, low: 2, none: 3 })[x.a.risk] - ({ high: 0, medium: 1, low: 2, none: 3 })[y.a.risk] || x.l.line_no - y.l.line_no);
  const counts = rows.reduce<Record<string, number>>((s, r) => ({ ...s, [r.a.risk]: (s[r.a.risk] ?? 0) + 1 }), {});

  // Cost history: the per-board cost each committed sourced BOM recorded, newest first, with the release that used it.
  const relOf = new Map<string, string[]>();
  for (const r of releases ?? []) for (const f of (r.manifest ?? []) as { version_id: string }[]) relOf.set(f.version_id, [...(relOf.get(f.version_id) ?? []), `Rev ${r.revision}`]);
  const costs = await Promise.all(boms.slice(0, 8).map(async (b) => ({ b, json: await readSourcedBom(supabase, b.storage_path) })));

  return (
    <main>
      <p className="crumbs"><Link href="/projects">Projects</Link> / <Link href={`/projects/${projectId}`}>{project.name}</Link> /</p>
      <h1>Lifecycle</h1>
      <p className="muted">The parts this product uses and what is happening to them: lifecycle status, manufacturers&apos; change and end-of-life
        notices, distributor stock and price over time. A risk opens a case, which is resolved by a qualified substitute, a last-time buy, a
        redesign or an accepted risk, each recorded as a project decision. Ratings are calculated from the catalog, with their reasons.</p>
      <Banner error={error} notice={notice} />

      <SectionTabs id="lifecycle" sections={[
        { key: "watch", label: "Watch", badge: rows.length || null, content: (<>
      <section>
        <div className="row spread">
          {canEdit && newer && <form action={loadBom.bind(null, projectId, newer.id)}>
            <SubmitButton pendingText="Loading…">{current ? `Load the newer BOM (${newer.artifact} v${newer.version})` : `Load the BOM (${newer.artifact} v${newer.version})`}</SubmitButton></form>}
        </div>
        {current ? <p className="small" data-testid="watch-summary">{rows.length} part(s) from {current.artifact} v{current.version}, needs for {boards} board(s):
          {" "}{counts.high ?? 0} high risk, {counts.medium ?? 0} medium, {counts.low ?? 0} low, {counts.none ?? 0} clear.
          {rows.some((r) => r.fixture) && <strong> Includes fixture (made-up) distributor data.</strong>}</p>
          : <p className="small muted">{boms.length ? "Load the sourced BOM to start watching its parts." : "No committed sourced BOM yet: run sourcing and approve its task."}</p>}
        {rows.length > 0 && (
          <table className="small" data-testid="watch">
            <thead><tr><th>Part</th><th>Refs</th><th>Lifecycle</th><th>Stock / need</th><th>Unit price</th><th>Risk</th><th></th></tr></thead>
            <tbody>{rows.map(({ l, p, a, need, best, history, notices: n }) => {
              const open = l.part_id ? openCases.get(l.part_id) : null;
              return (
                <tr key={l.line_no} data-mpn={l.mpn} data-risk={a.risk}>
                  <td><strong>{l.mpn}</strong> <span className="muted">{l.manufacturer}</span>
                    {n.length > 0 && <details><summary>{n.length} notice(s)</summary><ul>{n.map((x) => (
                      <li key={x.id}>{x.kind.replace(/_/g, " ")}: {x.title}{x.notice_ref && ` (${x.notice_ref})`}{x.last_order_on && `, last order ${x.last_order_on}`}
                        {x.source_url ? <> · <a href={x.source_url} rel="noreferrer noopener" target="_blank">source</a></> : x.source_note ? ` · ${x.source_note}` : x.automatic ? " · from distributor data" : ""}</li>
                    ))}</ul></details>}</td>
                  <td>{(l.refs as string[]).join(", ")}</td>
                  <td>{p ? p.lifecycle.replace(/_/g, " ") : "—"}</td>
                  <td>{a.stock ?? "—"} / {need}</td>
                  <td>{money(best?.price, best?.currency)}{history.change_pct != null && <div className="muted">{history.change_pct > 0 ? "+" : ""}{history.change_pct}% since {history.points[0]!.date}</div>}</td>
                  <td><span className={`pill pill-${RISK_PILL[a.risk]}`}>{a.risk === "none" ? "clear" : a.risk}</span>
                    {a.reasons.length > 0 && <div className="muted">{a.reasons.join("; ")}</div>}</td>
                  <td>{open ? <Link href={`/projects/${projectId}/lifecycle/${open.id}`}>{caseCode(open.case_no)}</Link>
                    : canEdit && a.risk !== "none" && (
                      <form action={openCase.bind(null, projectId)}>
                        <input type="hidden" name="part" value={l.part_id ?? ""} /><input type="hidden" name="mpn" value={l.mpn} />
                        <input type="hidden" name="manufacturer" value={l.manufacturer ?? ""} /><input type="hidden" name="refs" value={(l.refs as string[]).join(" ")} />
                        <input type="hidden" name="trigger" value={a.reasons[0] ?? "risk"} /><input type="hidden" name="severity" value={a.risk === "high" ? "high" : a.risk === "medium" ? "medium" : "low"} />
                        <input type="hidden" name="notice" value={n.find((x) => x.kind === "eol" || x.kind === "last_time_buy" || x.kind === "pcn")?.id ?? ""} />
                        <SubmitButton variant="secondary" pendingText="…">Open case</SubmitButton>
                      </form>
                    )}</td>
                </tr>
              );
            })}</tbody>
          </table>
        )}
        {canEdit && partIds.length > 0 && (
          <details className="card"><summary>Record a change or end-of-life notice</summary>
            <form action={recordNotice.bind(null, projectId)} className="stack">
              <div className="grid2">
                <label>Part<select name="part" required aria-label="Notice part">{rows.filter((r) => r.p).map((r) => <option key={r.l.line_no} value={r.l.part_id!}>{r.l.mpn}</option>)}</select></label>
                <label>Kind<select name="kind" defaultValue="eol" aria-label="Notice kind"><option value="eol">end of life</option><option value="last_time_buy">last-time buy</option>
                  <option value="pcn">product change (PCN)</option><option value="counterfeit_alert">counterfeit alert</option><option value="other">other</option></select></label>
                <label>Title<input name="title" required aria-label="Notice title" /></label>
                <label>Notice number<input name="notice_ref" aria-label="Notice number" /></label>
                <label>Issued<input name="issued_on" type="date" aria-label="Issued" /></label>
                <label>Change takes effect<input name="effective_on" type="date" aria-label="Effective" /></label>
                <label>Last order date<input name="last_order_on" type="date" aria-label="Last order date" /></label>
                <label>Last ship date<input name="last_ship_on" type="date" aria-label="Last ship date" /></label>
                <label>Source link (https)<input name="source_url" type="url" aria-label="Source link" /></label>
                <label>Or source note<input name="source_note" aria-label="Source note" placeholder="e.g. email from the distributor, 12 Nov" /></label>
              </div>
              <label>What changes<input name="summary" aria-label="Notice summary" /></label>
              <p className="small muted">Notices are shared with every project that uses the part. An end-of-life notice also moves the part&apos;s lifecycle in the catalog.</p>
              <div><SubmitButton pendingText="Saving…">Record notice</SubmitButton></div>
            </form>
          </details>
        )}
      </section>
        </>) },
        { key: "cases", label: "Cases", badge: (cases ?? []).filter((c) => c.status !== "resolved").length || null, content: (<>
      <section>
        <ul className="list small" data-testid="cases">{(cases ?? []).map((c) => (
          <li key={c.id} data-case={caseCode(c.case_no)} data-status={c.status}>
            <span className={`pill pill-${CASE_PILL[c.status]}`}>{c.status}</span> <Link href={`/projects/${projectId}/lifecycle/${c.id}`}><strong>{caseCode(c.case_no)}</strong></Link>
            {" "}{c.mpn} ({(c.refs as string[]).join(", ")}) — {c.trigger_text} <span className="pill">{c.severity}</span>
            {c.resolution && <div>Resolved: {c.resolution.replace(/_/g, " ")}{c.ltb_quantity ? ` of ${c.ltb_quantity}` : ""}. {c.resolution_note}</div>}
          </li>
        ))}{!cases?.length && <li className="muted">No cases.</li>}</ul>
      </section>
        </>) },
        { key: "costs", label: "Cost history", content: (<>
      <section>
        <table className="small" data-testid="cost-history">
          <thead><tr><th>BOM</th><th>Committed</th><th>Release</th>{(costs[0]?.json?.quantities ?? []).map((q) => <th key={q}>Per board at {q}</th>)}<th>Data</th></tr></thead>
          <tbody>{costs.map(({ b, json }) => (
            <tr key={b.id}><td><Link href={`/projects/${projectId}/artifacts/${b.id}`}>{b.artifact} v{b.version}</Link></td>
              <td>{b.committed_at ? new Date(b.committed_at).toLocaleDateString() : "—"}</td><td>{relOf.get(b.id)?.join(", ") ?? "—"}</td>
              {(costs[0]?.json?.quantities ?? []).map((q) => {
                const t = json?.totals.find((x) => x.boards === q);
                return <td key={q}>{money(t?.perBoard, json?.currency)}{t?.missingLines.length ? <span className="muted"> ({t.missingLines.length} unpriced)</span> : null}</td>;
              })}
              <td>{json?.dataStatus ?? "unreadable"}</td></tr>
          ))}{!costs.length && <tr><td colSpan={4} className="muted">No sourced BOMs yet.</td></tr>}</tbody>
        </table>
        <p className="small muted">Per-part price history is under each part&apos;s unit price (change since the first distributor observation, at the build quantity).</p>
      </section>
        </>) },
      ]} />
    </main>
  );
}
