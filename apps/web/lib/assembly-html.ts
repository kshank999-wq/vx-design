import type { AssemblyDraft } from "@vx/planning";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export interface HtmlMeta { project: string; version: number; status: string; approvedAt: string | null; model: string | null; exported: string }

/**
 * A standalone, printable work-instruction document (one file, no scripts). Figures are given as URLs: signed
 * links when viewed online, relative paths (figures/REF-1.png) inside the export ZIP.
 */
export function assemblyHtml(d: AssemblyDraft, meta: HtmlMeta, figures: Record<string, { src: string; title: string }>,
                             bom: { item: string; qty: number; kind: string }[]): string {
  const list = (xs: string[]) => xs.length ? `<ul>${xs.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "";
  const total = d.steps.reduce((a, s) => a + (s.minutes || 0), 0);
  const status = meta.status === "approved" ? `Approved ${meta.approvedAt ? esc(meta.approvedAt.slice(0, 10)) : ""}`
    : `<span class="draft">${esc(meta.status.toUpperCase())}: not approved for production use</span>`;
  const steps = d.steps.map((s, i) => {
    const fig = s.figure ? figures[s.figure] : undefined;
    return `<section class="step">
  <h2><span class="n">${i + 1}</span> ${esc(s.title)} <span class="min">${s.minutes} min</span></h2>
  <div class="cols">
    <div>
      ${s.parts.length ? `<h3>Parts</h3><table>${s.parts.map((p) => `<tr><td class="q">${p.qty} ×</td><td>${esc(p.name)}</td></tr>`).join("")}</table>` : ""}
      ${s.fasteners.length ? `<h3>Fasteners</h3><table><tr><th>Qty</th><th>Fastener</th><th>Torque</th></tr>${s.fasteners.map((f) =>
        `<tr><td class="q">${f.qty}</td><td>${esc(f.spec)}</td><td>${f.torque_nm != null ? `${f.torque_nm} N·m` : "—"}${f.torque_note ? `<div class="note">${esc(f.torque_note)}</div>` : ""}</td></tr>`).join("")}</table>` : ""}
      ${s.tools.length ? `<h3>Tools</h3>${list(s.tools)}` : ""}
      <h3>Do</h3><ol>${s.instructions.map((x) => `<li>${esc(x)}</li>`).join("")}</ol>
      ${s.cautions.length ? `<div class="caution"><strong>Caution</strong>${list(s.cautions)}</div>` : ""}
      ${s.check ? `<div class="check"><strong>Check before the next step:</strong> ${esc(s.check)} <span class="box">☐</span></div>` : ""}
    </div>
    ${fig ? `<figure><img src="${esc(fig.src)}" alt="${esc(fig.title)}"><figcaption>${esc(s.figure!)} ${esc(fig.title)}</figcaption></figure>` : ""}
  </div>
</section>`;
  }).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(meta.project)}: assembly instructions v${meta.version}</title>
<style>
body{font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;color:#132542;max-width:960px;margin:24px auto;padding:0 16px;background:#fff}
h1{font-size:24px;margin:0 0 4px}h2{font-size:17px;margin:0 0 10px;display:flex;gap:10px;align-items:center}h3{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#485e7f;margin:12px 0 4px}
.meta{color:#485e7f;margin-bottom:16px}.draft{color:#9a3448;font-weight:600}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #dae5f4;padding:4px 6px;text-align:left;vertical-align:top}th{font-size:12px;color:#485e7f}
.q{width:4em;white-space:nowrap}.note{font-size:12px;color:#556d8b}
.step{border:1px solid #cad9ee;border-radius:10px;padding:14px 16px;margin:14px 0;break-inside:avoid}
.n{display:inline-grid;place-items:center;width:28px;height:28px;border-radius:50%;background:#1856c4;color:#fff;font-size:14px}.min{margin-left:auto;font-weight:400;font-size:13px;color:#556d8b}
.cols{display:grid;grid-template-columns:1fr;gap:16px}@media (min-width:720px){.cols:has(figure){grid-template-columns:3fr 2fr}}
figure{margin:0}figure img{max-width:100%;border:1px solid #dae5f4;border-radius:6px}figcaption{font-size:12px;color:#556d8b}
.caution{background:#fff4df;color:#5c3d08;border-radius:6px;padding:8px 10px;margin-top:10px}.caution ul{margin:4px 0 0}
.check{background:#e5efff;border-radius:6px;padding:8px 10px;margin-top:10px}.box{float:right;font-size:18px}
.block{border:1px solid #cad9ee;border-radius:10px;padding:10px 16px;margin:12px 0}
@media print{body{margin:0;max-width:none}.step,.block{border-color:#999}a{color:inherit}}
</style></head><body>
<h1>${esc(d.title)}</h1>
<div class="meta">${esc(meta.project)} · version ${meta.version} · ${status} · ${d.steps.length} steps, about ${total} min per unit · exported ${esc(meta.exported)}${meta.model ? ` · drafted with ${esc(meta.model)}` : ""}</div>
${d.safety.length ? `<div class="block caution"><strong>Safety and handling</strong>${list(d.safety)}</div>` : ""}
<div class="block"><h3>Parts and fasteners per unit</h3><table><tr><th>Qty</th><th>Item</th><th>Kind</th></tr>${bom.map((b) => `<tr><td class="q">${b.qty}</td><td>${esc(b.item)}</td><td>${b.kind}</td></tr>`).join("")}</table>
${d.tools.length ? `<h3>Tools and fixtures</h3>${list(d.tools)}` : ""}</div>
${steps}
${d.final_test.length ? `<div class="block"><h2>Final functional test</h2><ol>${d.final_test.map((x) => `<li>${esc(x)} <span class="box">☐</span></li>`).join("")}</ol></div>` : ""}
${d.open_questions.length ? `<div class="block"><h3>Open questions for the designer</h3>${list(d.open_questions)}</div>` : ""}
</body></html>`;
}

/** One row per step for a spreadsheet or an MES import. */
export function assemblyCsv(d: AssemblyDraft): string {
  const cell = (c: string) => /[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c;
  const rows = [["step", "title", "parts", "fasteners", "tools", "instructions", "cautions", "check", "figure", "minutes"]];
  d.steps.forEach((s, i) => rows.push([String(i + 1), s.title, s.parts.map((p) => `${p.qty} x ${p.name}`).join("; "),
    s.fasteners.map((f) => `${f.qty} x ${f.spec}${f.torque_nm != null ? ` @ ${f.torque_nm} N·m` : ""}`).join("; "), s.tools.join("; "),
    s.instructions.join(" / "), s.cautions.join(" / "), s.check ?? "", s.figure ?? "", String(s.minutes)]));
  return rows.map((r) => r.map(cell).join(",")).join("\n") + "\n";
}
