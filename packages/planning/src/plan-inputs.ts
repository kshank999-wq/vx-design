/**
 * Project inputs → plan context. Everything a plan is built from, as text with stable ids the plan can cite:
 * prior work is PW-n (one per Flux audit or prior-design file), references are REF-n (mock-ups, sketches, drawings,
 * datasheets). Deterministic: the same inputs give the same text, so plans are reproducible and the context can be
 * shown to the people who approve the plan.
 */

export interface PriorWorkPart { designator: string; mpn: string | null; manufacturer?: string | null; value?: string | null; role?: string | null; details?: string | null }
export interface PriorWork {
  id: string;                 // "PW-1"
  label: string;              // "Flux audit #1: VC Smart Slate"
  revision?: string | null;
  board?: { width_mm?: number | null; height_mm?: number | null; thickness_mm?: number | null; copper_layers?: number | null } | null;
  routed?: boolean | null;    // null: not known
  connectivityChecked?: boolean;
  parts: PriorWorkPart[];
  rails: string[];
  connectors: { designator: string; mpn: string | null; pins: number }[];
  decisions: { statement: string; quote?: string; file?: string }[];
  claims: { claim: string; status: string }[];
  open: string[];             // blocker and warning findings
  migration: string[];        // the audit's suggested tasks
}
export interface ReferenceInput { id: string; kind: string; title: string; note?: string | null; filename: string }
import { registerText, type RegisterItem } from "./prior-work.ts";

export interface PlanInputs {
  project: { name: string; description?: string | null };
  intake?: Record<string, string | number | null> | null;
  freeze?: { envelope?: string | null; cmf?: string | null; note?: string | null } | null;
  standards?: { identifier: string; title: string; applicability: string }[];
  documents?: { title: string; requirements: number }[];
  references?: ReferenceInput[];
  priorWork?: PriorWork[];
  /** The prior-work register (already corrected by people): every item, cited as PR-n. */
  register?: RegisterItem[];
  /** How each physical part is made now and later, one line per part ("Enclosure base: prototype …; production …"). */
  routes?: string[];
  /** Parts the team has chosen (recorded from their datasheets and models), cited as PT-n. */
  parts?: ChosenPart[];
  /** What changed since the plan this one replaces, with that plan's tasks, so a new plan takes it all in. */
  changes?: PlanChanges | null;
}
export interface ChosenPart {
  id: string;                 // "PT-1"
  mpn: string;
  manufacturer?: string | null;
  summary?: string | null;    // what it is, from the datasheet
  role?: string | null;
  subsystem?: string | null;
  status: string;             // candidate, selected, designed, laid_out, verified
  note?: string | null;
  specs?: { name: string; value: string }[];
  files?: string[];           // "riverdi.pdf (datasheet)", "display.step (3D model)"
  register?: string | null;   // the register item for the same part, when there is one
}
export interface PlanChanges {
  version: number;            // the plan these changes are measured from
  since: string;              // ISO time it was made
  items: string[];            // one line per change
  tasks: { key: string; title: string; stage?: string | null; status?: string | null }[];
}
export interface PlanInputSource { id: string; kind: "prior_work" | "reference" | "part"; label: string }

const MAX_PART_LINES = 60, MAX_DECISIONS = 25;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const one = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/** Groups parts that share a part number (or value) and role, so a board's decoupling capacitors are one line. */
function partLines(parts: PriorWorkPart[]): string[] {
  const groups = new Map<string, { refs: string[]; p: PriorWorkPart }>();
  for (const p of parts) {
    const k = `${p.mpn ?? `~${p.value ?? ""}`}|${one(p.role)}`;
    const g = groups.get(k);
    if (g) g.refs.push(p.designator); else groups.set(k, { refs: [p.designator], p });
  }
  return [...groups.values()].map(({ refs, p }) => {
    const what = p.mpn ? `${p.mpn}${p.manufacturer ? ` (${p.manufacturer})` : ""}` : `${p.value ?? "part"}, no part number chosen`;
    const why = [one(p.role), clip(one(p.details), 160)].filter(Boolean).join(": ");
    return `${refs.join(", ")}: ${what}${why ? ` — ${why}` : ""}`;
  });
}

export function planContext(inputs: PlanInputs): { text: string; sources: PlanInputSource[] } {
  const L: string[] = [];
  const sources: PlanInputSource[] = [];
  L.push(`Project: ${inputs.project.name}${inputs.project.description ? ` — ${one(inputs.project.description)}` : ""}`);
  const intake = Object.entries(inputs.intake ?? {}).filter(([, v]) => v != null && v !== "");
  if (intake.length) L.push("", "Intake:", ...intake.map(([k, v]) => `- ${k.replace(/_/g, " ")}: ${v}`));
  if (inputs.freeze && (inputs.freeze.envelope || inputs.freeze.cmf || inputs.freeze.note)) {
    L.push("", "Design freeze (industrial design, agreed):",
      ...[inputs.freeze.envelope && `- envelope: ${inputs.freeze.envelope}`, inputs.freeze.cmf && `- colour, material, finish: ${one(inputs.freeze.cmf)}`,
          inputs.freeze.note && `- note: ${one(inputs.freeze.note)}`].filter((x): x is string => !!x));
  }
  if (inputs.standards?.length) L.push("", "Standards that apply:", ...inputs.standards.map((s) => `- ${s.identifier} ${s.title} (${s.applicability})`));
  if (inputs.documents?.length) L.push("", "Specification documents (their requirements are listed below):", ...inputs.documents.map((d) => `- ${d.title}: ${d.requirements} requirement(s)`));

  if (inputs.references?.length) {
    L.push("", "References (mock-ups, sketches, drawings, datasheets; cite as REF-n):");
    for (const r of inputs.references) {
      sources.push({ id: r.id, kind: "reference", label: `${r.title} (${r.kind.replace(/_/g, " ")})` });
      L.push(`- [${r.id}] ${r.title} (${r.kind.replace(/_/g, " ")}, file ${r.filename})${r.note ? `: ${clip(one(r.note), 600)}` : ""}`);
    }
  }
  for (const w of inputs.priorWork ?? []) {
    sources.push({ id: w.id, kind: "prior_work", label: w.label });
    L.push("", `Prior work [${w.id}] ${w.label}${w.revision ? `, revision ${w.revision}` : ""} (imported; nothing in it is verified):`);
    const b = w.board;
    if (b && (b.width_mm || b.copper_layers)) {
      L.push(`- board: ${b.width_mm && b.height_mm ? `${b.width_mm} × ${b.height_mm} mm` : "outline unknown"}${b.thickness_mm ? `, ${b.thickness_mm} mm thick` : ""}` +
             `${b.copper_layers ? `, ${b.copper_layers} copper layers` : ""}${w.routed === false ? "; parts placed but NOT routed" : w.routed ? "; routed" : ""}`);
    }
    if (w.connectivityChecked) L.push("- the exported schematic and layout netlists agree (pin assignments only)");
    if (w.parts.length) {
      const lines = partLines(w.parts);
      L.push(`- parts (${w.parts.length}):`, ...lines.slice(0, MAX_PART_LINES).map((x) => `  - ${x}`));
      if (lines.length > MAX_PART_LINES) L.push(`  - …and ${lines.length - MAX_PART_LINES} more line(s)`);
    }
    if (w.rails.length) L.push(`- power rails by name: ${w.rails.join(", ")}`);
    if (w.connectors.length) L.push(`- connectors: ${w.connectors.map((c) => `${c.designator}${c.mpn ? ` ${c.mpn}` : ""} (${c.pins} pins)`).join("; ")}`);
    if (w.decisions.length) {
      L.push("- earlier decisions (quoted from the exported documents, unverified):",
        ...w.decisions.slice(0, MAX_DECISIONS).map((d) => `  - ${clip(one(d.statement), 240)}${d.file ? ` (${d.file})` : ""}`));
    }
    if (w.claims.length) L.push("- claimed validations (unverified, to be re-established):", ...w.claims.slice(0, 15).map((c) => `  - ${clip(one(c.claim), 200)} [${c.status.replace(/_/g, " ")}]`));
    if (w.open.length) L.push("- open problems found by the import audit:", ...w.open.slice(0, 15).map((o) => `  - ${clip(one(o), 200)}`));
    if (w.migration.length) L.push("- import audit's suggested next steps:", ...w.migration.map((m) => `  - ${clip(one(m), 200)}`));
  }
  if (inputs.register?.length) L.push("", registerText(inputs.register));
  if (inputs.parts?.length) {
    L.push("", "Parts the team has chosen (recorded from the manufacturers' datasheets and models; cite as PT-n). Design around them: " +
      "do not plan to select something else for the same job unless one cannot work, and then say why. Use the specifications below " +
      "for the power budget, interfaces, mechanical fit and the enclosure, and their 3D models for the fit checks:");
    for (const p of inputs.parts) {
      sources.push({ id: p.id, kind: "part", label: `${p.mpn}${p.manufacturer ? ` (${p.manufacturer})` : ""}` });
      const head = `- [${p.id}] (${p.status.replace("_", " ")}) ${p.mpn}${p.manufacturer ? ` (${p.manufacturer})` : ""}` +
        `${p.summary ? `: ${clip(one(p.summary), 160)}` : ""}${p.subsystem ? ` [${p.subsystem.replace(/_/g, " ")}]` : ""}${p.register ? `; also ${p.register} in the register` : ""}`;
      L.push(head);
      if (p.role) L.push(`  - used for: ${clip(one(p.role), 200)}`);
      if (p.specs?.length) L.push(`  - specifications: ${p.specs.slice(0, 12).map((x) => `${one(x.name)} ${one(x.value)}`).join("; ")}`);
      if (p.files?.length) L.push(`  - files: ${p.files.join(", ")}`);
      if (p.note) L.push(`  - note: ${clip(one(p.note), 300)}`);
    }
  }
  if (inputs.routes?.length) {
    L.push("", "Manufacturing routes (prototype now, production later). Design each part for its production process from the start, plan the " +
      "prototype builds and the production tooling, and do not sign off strength or drop tests on a prototype material that differs from production:",
      ...inputs.routes.map((r) => `- ${one(r)}`));
  }
  if (inputs.changes) {
    const c = inputs.changes;
    L.push("", `Changed since the last plan (version ${c.version}, made ${c.since.slice(0, 10)}). This plan replaces it: take every change ` +
      "below into account. Keep the tasks that still hold (with the same keys), change the ones these affect, add the work they need, " +
      "and drop what they make unnecessary:", ...(c.items.length ? c.items.map((x) => `- ${one(x)}`) : ["- nothing recorded; review the plan against the inputs above"]));
    if (c.tasks.length) L.push("", `Tasks in plan version ${c.version}:`, ...c.tasks.map((t) => `- ${t.key}: ${one(t.title)}${t.stage ? ` [${t.stage}]` : ""}${t.status && t.status !== "pending" ? ` (${t.status.replace(/_/g, " ")})` : ""}`));
  }
  return { text: L.join("\n"), sources };
}

/** The parts of a Flux audit report (@vx/flux AuditReport) that a plan needs. */
export interface FluxAuditLike {
  current: {
    revision: string;
    components: { designator: string; mpn: string | null; manufacturer: string | null; value: string | null; dnp?: boolean; design?: { role?: string | null; details?: string | null } | null }[];
    connectors: { designator: string; mpn: string | null; pins: unknown[] }[];
    power_rails: { net: string }[];
    board: { width_mm?: number | null; height_mm?: number | null; thickness_mm?: number | null; copper_layers?: number | null };
  } | null;
  findings: { severity: string; title: string; category: string }[];
  history: { decisions: { statement: string; quote: string; file: string }[]; claims: { claim: string; status: string }[] };
  migration: { title: string; scope: string }[];
}

export function priorWorkFromFluxAudit(id: string, label: string, r: FluxAuditLike): PriorWork {
  const c = r.current;
  const routedFinding = r.findings.some((f) => f.title === "The layout is not routed");
  return {
    id, label, revision: c?.revision ?? null,
    board: c ? { width_mm: c.board.width_mm ?? null, height_mm: c.board.height_mm ?? null, thickness_mm: c.board.thickness_mm ?? null, copper_layers: c.board.copper_layers ?? null } : null,
    routed: routedFinding ? false : null,
    connectivityChecked: r.findings.some((f) => f.title === "Layout connectivity matches the schematic netlist"),
    parts: (c?.components ?? []).filter((p) => !p.dnp).map((p) => ({ designator: p.designator, mpn: p.mpn, manufacturer: p.manufacturer, value: p.value,
                                                                     role: p.design?.role ?? null, details: p.design?.details ?? null })),
    rails: (c?.power_rails ?? []).map((p) => p.net),
    connectors: (c?.connectors ?? []).map((k) => ({ designator: k.designator, mpn: k.mpn, pins: k.pins.length })),
    decisions: r.history.decisions.map((d) => ({ statement: d.statement, quote: d.quote, file: d.file.split(/[/!]/).pop() })),
    claims: r.history.claims.map((x) => ({ claim: x.claim, status: x.status })),
    open: r.findings.filter((f) => f.severity !== "info").map((f) => `${f.severity}: ${f.title}`),
    migration: r.migration.map((m) => `${m.title}: ${m.scope}`),
  };
}
