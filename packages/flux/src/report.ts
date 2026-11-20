import { KIND_LABEL, type AuditReport } from "./audit.ts";

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** The audit as a Markdown document (stored next to the JSON; the web page renders the JSON). */
export function renderReport(r: AuditReport, title: string): string {
  const L: string[] = [];
  const s = r.summary;
  L.push(`# Flux audit: ${title}`, "", `> ${r.statement}`, "",
    `${s.revisions} revision(s), ${s.files} file(s). Latest revision: ${s.components} parts, ${s.consistent} consistent across the exports, ${s.uncertain} uncertain. ` +
    `${s.blockers} blocker(s), ${s.warnings} warning(s). ${s.claims} claimed validation(s), ${s.claims_unverifiable} unverifiable.`, "");
  L.push("## Revisions", "", "| Revision | Date | Files | Kinds |", "|---|---|---|---|");
  for (const v of r.revisions) L.push(`| ${esc(v.label)} | ${v.date ?? "—"} | ${v.files} | ${Object.entries(v.kinds).filter(([k]) => k !== "archive").map(([k, n]) => `${KIND_LABEL[k as keyof typeof KIND_LABEL]} ×${n}`).join(", ")} |`);
  L.push("", "## Findings", "");
  for (const f of r.findings) {
    L.push(`### ${f.id} [${f.severity}] ${f.title}${f.revision ? ` (${f.revision})` : ""}`, "", f.detail);
    for (const i of f.items ?? []) L.push(`- ${i}`);
    if (f.evidence.length) L.push("", `Evidence: ${f.evidence.map((e) => `\`${e}\``).join(", ")}`);
    L.push("");
  }
  if (r.current) {
    const c = r.current;
    L.push(`## Current state (${c.revision})`, "", "### Parts", "", "| Ref | Part number | Manufacturer | Value | Package | Why it is there | Seen in | Status |", "|---|---|---|---|---|---|---|---|");
    for (const p of c.components) {
      const why = p.design ? [p.design.role, p.design.details, p.design.note].filter(Boolean).join(" — ") : "";
      L.push(`| ${p.designator} | ${p.mpn ?? "—"}${p.suppliers ? ` (${esc(Object.entries(p.suppliers).map(([k, v]) => `${k} ${v}`).join(", "))})` : ""} | ${p.manufacturer ?? "—"} | ${p.value ?? "—"} | ${p.package ?? "—"} | ${esc(why) || "—"} | ${p.sources.join(", ")} | ${p.status}${p.reasons.length ? `: ${esc(p.reasons.join("; "))}` : ""} |`);
    }
    L.push("", "### Board", "", `- Outline: ${c.enclosure.outline_mm ?? "unknown"} (from ${c.board.sources.join(" and ") || "nothing"})`,
      `- Copper layers: ${c.board.copper_layers ?? "unknown"}${c.board.layer_names?.length ? ` (${c.board.layer_names.join(", ")})` : ""}`,
      `- Minimum trace / space: ${c.board.min_trace_mm ?? "?"} / ${c.board.min_space_mm ?? "?"} mm`, "", "### Connectors (motherboard and external connections)", "");
    for (const k of c.connectors) L.push(`- **${k.designator}** ${k.mpn ?? ""}${k.edge ? ` — ${k.edge}` : ""}: ${k.pins.map((p) => `${p.pin}=${p.net}`).join(", ") || "no nets"}`);
    if (!c.connectors.length) L.push("- none recognised");
    L.push("", "### Power rails (by net name)", "");
    for (const p of c.power_rails) L.push(`- ${p.net}: ${p.pins} pins (${p.components.join(", ")})`);
    if (!c.power_rails.length) L.push("- none recognised");
    L.push("", "### Enclosure constraints", "", `- Mounting holes: ${c.enclosure.mounting_holes.join(", ") || "none recognised"}`,
      `- Connectors at the edge: ${c.enclosure.edge_connectors.join("; ") || "none recognised"}`, `- ${c.enclosure.tallest_parts_note}`, "");
  }
  if (r.comparisons.length) {
    L.push("## Revision comparison", "");
    for (const c of r.comparisons) {
      L.push(`### ${c.from} → ${c.to}`, "");
      if (c.added.length) L.push(`- Added: ${c.added.join(", ")}`);
      if (c.removed.length) L.push(`- Removed: ${c.removed.join(", ")}`);
      for (const ch of c.changed) L.push(`- ${ch.designator} ${ch.field}: ${ch.from ?? "—"} → ${ch.to ?? "—"}`);
      if (c.nets_added.length) L.push(`- Nets added: ${c.nets_added.join(", ")}`);
      if (c.nets_removed.length) L.push(`- Nets removed: ${c.nets_removed.join(", ")}`);
      for (const n of c.nets_changed) L.push(`- Net ${n.net}: ${n.added.length ? `+${n.added.join(" +")}` : ""} ${n.removed.length ? `-${n.removed.join(" -")}` : ""}`.trimEnd());
      for (const b of c.board) L.push(`- Board: ${b}`);
      L.push("");
    }
  }
  if (r.history.decisions.length || r.history.claims.length) {
    L.push("## Prior decisions and claimed validations", "", `Extracted by ${r.history.model ?? "—"}${r.history.offline ? " (offline stand-in, not AI)" : ""}; every quote was checked word for word against its file.`, "");
    for (const d of r.history.decisions) L.push(`- Decision (unverifiable): ${d.statement} — “${d.quote}” (${d.file.split(/[/!]/).pop()})`);
    for (const c of r.history.claims) L.push(`- Claim [${c.kind}] (${c.status === "unverifiable" ? "unverifiable" : "evidence file present, not re-run"}): ${c.claim} — “${c.quote}” (${c.file.split(/[/!]/).pop()})`);
    L.push("");
  }
  L.push("## Migration plan", "", "| # | Task | Discipline | Effort | Done when | Resolves |", "|---|---|---|---|---|---|");
  for (const m of r.migration) L.push(`| ${m.id} | **${esc(m.title)}**: ${esc(m.scope)} | ${m.discipline} | ${m.effort} | ${esc(m.done_when)} | ${m.findings.join(", ") || "—"} |`);
  L.push("", "## Inventory", "", "| File | Revision | Kind | Size | sha256 |", "|---|---|---|---|---|");
  for (const f of r.inventory.filter((x) => x.kind !== "archive")) L.push(`| ${esc(f.path)} | ${esc(f.revision)} | ${KIND_LABEL[f.kind]} | ${f.size} | ${f.sha256.slice(0, 16)} |`);
  return L.join("\n") + "\n";
}
