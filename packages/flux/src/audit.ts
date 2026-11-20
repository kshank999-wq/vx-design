/**
 * G5 audit (spec §16): inventory → per-revision current-state map → cross-checks → revision comparison → migration
 * plan. Deterministic: the same files give the same report. Nothing imported is ever marked verified; the best a
 * part can be is "consistent across the exports", and the best a claimed validation can be is "evidence file
 * present, not re-run".
 */
import { buildInventory, KIND_LABEL, text, type FileKind, type InventoryFile, type InventoryProblem, type Upload } from "./inventory.ts";
import { normMpn, type BoardFacts, type ComponentFacts, type DesignNotes, type Netlist, type ParsedFile, type Source } from "./model.ts";
import { parseBom, parsePnp } from "./parsers/table.ts";
import { parseEdif } from "./parsers/edif.ts";
import { parseIpc356 } from "./parsers/ipc356.ts";
import { parseProjectJson } from "./parsers/project-json.ts";
import { summariseGerbers } from "./parsers/gerber.ts";
import { parseIdf, parseOdb } from "./parsers/board.ts";

export const AUDIT_VERSION = "flux-audit-v1";

export type Severity = "blocker" | "warning" | "info";
export interface Finding {
  id: string; severity: Severity; category: string; revision: string | null; title: string; detail: string;
  items?: string[]; evidence: string[];
}
export interface ComponentState {
  designator: string; mpn: string | null; manufacturer: string | null; value: string | null; package: string | null;
  sources: Source[]; status: "consistent" | "uncertain"; reasons: string[]; catalog?: CatalogEntry | null; dnp?: boolean;
  /** The designer's own notes on why the part is there (Flux BOM), carried over so the reasoning is not lost. */
  design?: DesignNotes | null;
  suppliers?: Record<string, string>;
}
export interface CatalogEntry { mpn: string; manufacturer: string | null; lifecycle: string | null }
export interface HistoryInput {
  model: string; offline: boolean; dropped_quotes: number;
  decisions: { statement: string; rationale: string | null; file: string; quote: string; date: string | null }[];
  claims: { claim: string; kind: string; file: string; quote: string }[];
}
export interface RevisionInput { label: string; date?: string | null; note?: string | null }
export interface MigrationTask {
  id: string; title: string; discipline: string; effort: "S" | "M" | "L"; scope: string; inputs: string[]; done_when: string; findings: string[];
}
export interface Comparison {
  from: string; to: string; added: string[]; removed: string[];
  changed: { designator: string; field: string; from: string | null; to: string | null }[];
  nets_added: string[]; nets_removed: string[]; nets_changed: { net: string; added: string[]; removed: string[] }[];
  board: string[];
}
export interface AuditReport {
  version: string;
  statement: string;
  revisions: { label: string; date: string | null; note: string | null; files: number; kinds: Partial<Record<FileKind, number>>; project: Record<string, unknown> | null }[];
  inventory: { path: string; revision: string; kind: FileKind; size: number; sha256: string }[];
  problems: InventoryProblem[];
  parse_notes: { path: string; notes: string[] }[];
  findings: Finding[];
  current: {
    revision: string;
    components: ComponentState[];
    connectors: { designator: string; mpn: string | null; pins: { pin: string; net: string }[]; edge: string | null }[];
    power_rails: { net: string; pins: number; components: string[] }[];
    board: BoardFacts & { sources: string[] };
    enclosure: { outline_mm: string | null; mounting_holes: string[]; edge_connectors: string[]; tallest_parts_note: string };
    nets: number;
  } | null;
  comparisons: Comparison[];
  repeated: { designator: string; field: string; values: (string | null)[]; revisions: string[] }[];
  history: {
    model: string | null; offline: boolean; dropped_quotes: number;
    decisions: (HistoryInput["decisions"][number] & { status: "unverifiable" })[];
    claims: (HistoryInput["claims"][number] & { status: "unverifiable" | "evidence_present_not_rerun"; evidence: string[] })[];
  };
  migration: MigrationTask[];
  summary: { revisions: number; files: number; components: number; consistent: number; uncertain: number; blockers: number;
             warnings: number; claims: number; claims_unverifiable: number };
}

export interface Snapshot {
  revision: string;
  files: InventoryFile[];
  parsed: ParsedFile[];
  json: ParsedFile | null; bom: ParsedFile | null; pnp: ParsedFile | null; edif: ParsedFile | null; ipc356: ParsedFile | null; gerber: ParsedFile | null;
  odb: ParsedFile | null; idf: ParsedFile | null;
  schematicNets: Netlist | null;
  components: Map<string, Partial<Record<Source, ComponentFacts>>>;
}

const MFR_SUFFIX = /(jlc|pcbway|macrofab|seeed|lcsc|digikey|mouser|octopart|eurocircuits|aisler|oshpark|advancedcircuits|allpcb|elecrow|openpnp)/i;
/**
 * Flux writes one BOM/placement file per manufacturer. Prefer Flux's own format ("…-Flux.csv": every column, with
 * part numbers and design notes), then a generic one, then the widest file (most columns), then the first by name.
 */
const rank = (f: InventoryFile) => (/-flux\.csv$/i.test(f.path) ? 0 : MFR_SUFFIX.test(f.path.split(/[/!]/).pop()!) ? 2 : 1);
const width = (f: InventoryFile) => (text(f).split(/\r?\n/, 1)[0] ?? "").split(",").length;
const preferGeneric = (fs: InventoryFile[]) => [...fs].sort((a, b) => rank(a) - rank(b) || width(b) - width(a) || (a.path < b.path ? -1 : 1))[0];

export function buildSnapshot(revision: string, files: InventoryFile[]): Snapshot {
  const of = (k: FileKind) => files.filter((f) => f.kind === k);
  const parsed: ParsedFile[] = [];
  const once = <T extends ParsedFile>(f: InventoryFile | undefined, fn: (p: string, s: string) => T) => {
    if (!f) return null;
    const p = fn(f.path, text(f));
    parsed.push(p);
    return p;
  };
  const json = once(of("flux_json")[0], parseProjectJson);
  const bom = once(preferGeneric(of("bom_csv")), parseBom);
  const pnp = once(preferGeneric(of("pnp_csv")), parsePnp);
  const edif = once(of("edif")[0], parseEdif);
  const ipc356 = once(of("ipc356")[0], parseIpc356);
  const odbFile = of("odbpp")[0];
  const odb = odbFile ? parseOdb(odbFile.path, odbFile.data) : null;
  if (odb) parsed.push(odb);
  const idf = of("idf").map((f) => parseIdf(f.path, text(f))).find((x): x is ParsedFile => !!x) ?? null;
  if (idf) parsed.push(idf);
  const gerbers = of("gerber");
  const gerber = gerbers.length ? summariseGerbers(gerbers.map((g) => ({ path: g.path, src: text(g) }))) : null;
  if (gerber) parsed.push(gerber);
  const components = new Map<string, Partial<Record<Source, ComponentFacts>>>();
  for (const p of [json, bom, pnp, edif]) {
    for (const c of p?.components ?? []) {
      const e = components.get(c.designator) ?? {};
      e[p!.source] = c;
      components.set(c.designator, e);
    }
  }
  const schematicNets = edif?.nets?.size ? edif.nets : json?.nets?.size ? json.nets : null;
  return { revision, files, parsed, json, bom, pnp, edif, ipc356, gerber, odb, idf, schematicNets, components };
}

const first = <T>(...xs: (T | null | undefined)[]) => xs.find((x) => x != null && x !== "") ?? null;
const POWER_NAME = /^(\+|-)?(\d+V\d*|\d+V|V\d+V\d*|3V3|1V8|1V2|2V5|5V0|VCC\w*|VDD\w*|VSS\w*|VEE\w*|VBAT\w*|VBUS\w*|VIN\w*|VSYS\w*|VIO\w*|VREF\w*|V_\w+|\+?\d+(\.\d+)?V\w*|GND\w*|AGND\w*|DGND\w*|PGND\w*|EARTH)$/i;
/** A rail by name, also with a domain prefix or suffix ("TC_3V3", "VBAT_PROT"). */
const POWER_NET = { test: (n: string) => POWER_NAME.test(n) || n.split(/[_.]/).some((seg, i, all) => all.length > 1 && (i === 0 || i === all.length - 1) && /^(\d+V\d*|V\d+V\d*|3V3|1V8|1V2|2V5|5V0|VCC\w*|VDD\w*|VBAT|VBUS|VIN|VSYS|GND)$/i.test(seg)) };
const CONNECTOR = /^(J|P|CN|CON|X|USB|HDR)\d+$/;
const MOUNTING = /^(H|MH|MTG|HOLE)\d+$|mounting|mtg[_-]?hole/i;

function componentStates(s: Snapshot, catalog: Map<string, CatalogEntry>): ComponentState[] {
  const have: Source[] = (["flux_json", "edif", "bom", "pnp"] as Source[]).filter((src) => (src === "flux_json" ? s.json : src === "edif" ? s.edif : src === "bom" ? s.bom : s.pnp)?.components?.length);
  const schematicSrc: Source[] = have.filter((x) => x === "flux_json" || x === "edif");
  const out: ComponentState[] = [];
  for (const [designator, by] of [...s.components.entries()].sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true }))) {
    const facts = (["bom", "flux_json", "edif", "pnp"] as Source[]).map((k) => by[k]).filter((f): f is ComponentFacts => !!f);
    const sources = Object.keys(by) as Source[];
    const reasons: string[] = [];
    const mpns = [...new Set(facts.map((f) => f.mpn).filter((m): m is string => !!m))];
    const mpn = first(by.bom?.mpn, by.flux_json?.mpn, by.edif?.mpn);
    const dnp = !!(by.bom?.dnp || by.flux_json?.dnp);
    if (new Set(mpns.map(normMpn)).size > 1) reasons.push(`part numbers disagree: ${mpns.join(" vs ")}`);
    if (!mpn && !MOUNTING.test(designator) && !/^(TP|FID)\d+$/.test(designator)) reasons.push("no manufacturer part number");
    if (schematicSrc.length && !sources.some((x) => schematicSrc.includes(x))) reasons.push("placed or listed but not in the schematic data");
    if (have.includes("bom") && !by.bom && !dnp && !/^(TP|FID|H|MH)\d+$/.test(designator)) reasons.push("not in the BOM");
    if (have.includes("pnp") && !by.pnp && !dnp && by.bom) reasons.push("in the BOM but not in the placement file");
    const cat = mpn ? catalog.get(normMpn(mpn)) ?? null : null;
    if (cat?.lifecycle && /obsolete|nrnd|last_time/i.test(cat.lifecycle)) reasons.push(`lifecycle: ${cat.lifecycle}`);
    out.push({ designator, mpn, manufacturer: first(by.bom?.manufacturer, by.flux_json?.manufacturer, by.edif?.manufacturer),
               value: first(by.bom?.value, by.flux_json?.value, by.edif?.value, by.pnp?.value),
               package: first(by.flux_json?.package, by.bom?.package, by.pnp?.package, by.flux_json?.footprint, by.edif?.footprint),
               sources, status: reasons.length ? "uncertain" : "consistent", reasons, catalog: cat, dnp,
               ...(by.bom?.design ? { design: by.bom.design } : {}), ...(by.bom?.suppliers ? { suppliers: by.bom.suppliers } : {}) });
  }
  return out;
}

const pinNetOf = (n: Netlist) => { const m = new Map<string, string>(); for (const [net, pins] of n) for (const p of pins) m.set(p, net); return m; };
const pinName = (k: string) => k.slice(k.indexOf(".") + 1).replace(/#\d+$/, "").replace(/[^A-Z0-9]/gi, "").toUpperCase();

/**
 * Maps layout pin names onto the schematic's where they differ only in form. Flux writes pin *names* into IPC-D-356
 * and the format keeps four characters ("VTREF" → "VTre", "~RESET~" → "~RES"); a part's repeated name ("GND", "GND_2")
 * arrives as "GND" twice. Each layout pin is matched, on the same part, to a schematic pin with the same name
 * ignoring case and punctuation, else to the one unused pin whose name starts with it (same net name preferred).
 * A part numbered in one export and named in the other (oscillator pins 1/4/6 against CLK/GND/OE) is matched by net:
 * a remaining layout pin is paired with a remaining schematic pin of the same part on the same-named net. Pins on one
 * net are interchangeable for connectivity, so this cannot hide an open or a short; it is reported, by part.
 * Matches are one-to-one; a repeated record with no pin left is dropped.
 */
export function reconcilePins(sch: Netlist, lay: Netlist): { lay: Netlist; renamed: number; byNet: string[] } {
  const sp = pinNetOf(sch), lp = pinNetOf(lay);
  const byRef = new Map<string, string[]>();
  for (const p of sp.keys()) { const r = p.split(".")[0]!; byRef.set(r, [...(byRef.get(r) ?? []), p]); }
  const used = new Set<string>(), map = new Map<string, string | null>();
  const pending = [...lp.keys()].filter((p) => { if (sp.has(p)) { used.add(p); map.set(p, p); return false; } return byRef.has(p.split(".")[0]!); });
  const take = (p: string, pick: (c: string[]) => string[]) => {
    const cands = pick((byRef.get(p.split(".")[0]!) ?? []).filter((c) => !used.has(c)));
    if (!cands.length) return false;
    const net = lp.get(p)!;
    const best = [...cands].sort((a, b) => Number(sp.get(b) === net) - Number(sp.get(a) === net) || pinName(a).length - pinName(b).length || (a < b ? -1 : 1))[0]!;
    used.add(best); map.set(p, best);
    return true;
  };
  const rest = pending.filter((p) => !take(p, (c) => c.filter((x) => pinName(x) === pinName(p))));
  const unmatched: string[] = [];
  for (const p of [...rest].sort((a, b) => pinName(b).length - pinName(a).length)) {
    if (pinName(p).length >= 2 && take(p, (c) => c.filter((x) => pinName(x).startsWith(pinName(p))))) continue;
    unmatched.push(p);
  }
  const byNet = new Set<string>();
  for (const p of unmatched) {
    const net = lp.get(p)!;
    if (!net.startsWith("N/C:") && take(p, (c) => c.filter((x) => sp.get(x) === net))) { byNet.add(p.split(".")[0]!); continue; }
    if (/#\d+$/.test(p)) map.set(p, null);
  }
  let renamed = 0;
  const out: Netlist = new Map();
  for (const [net, pins] of lay) {
    const s = new Set<string>();
    for (const p of pins) {
      const m = map.has(p) ? map.get(p) : p;
      if (m == null) continue;
      if (m !== p) renamed++;
      s.add(m);
    }
    if (s.size) out.set(net.startsWith("N/C:") ? `N/C:${[...s][0]}` : net, s);
  }
  return { lay: out, renamed, byNet: [...byNet].sort((a, b) => a.localeCompare(b, "en", { numeric: true })) };
}

/** Topological comparison: which schematic nets are split (opens) or merged (shorts) in the layout, and missing/extra pins. */
export function compareConnectivity(sch: Netlist, lay: Netlist) {
  const sp = pinNetOf(sch), lp = pinNetOf(lay);
  const refs = (m: Map<string, string>) => new Set([...m.keys()].map((p) => p.split(".")[0]));
  const layRefs = refs(lp), schRefs = refs(sp);
  const opens: { net: string; layout_nets: string[] }[] = [];
  const shorts: { layout_net: string; schematic_nets: string[] }[] = [];
  const missing: string[] = [];
  const extra: string[] = [];
  for (const [net, pins] of sch) {
    const multi = [...pins].filter((p) => layRefs.has(p.split(".")[0]!));
    if (multi.length < 2) continue;
    const ls = new Set(multi.map((p) => lp.get(p)).filter((x): x is string => !!x && !x.startsWith("N/C:")));
    const absent = multi.filter((p) => !lp.has(p) || lp.get(p)!.startsWith("N/C:"));
    missing.push(...absent.map((p) => `${p} (${net})`));
    if (ls.size > 1) opens.push({ net, layout_nets: [...ls].sort() });
  }
  for (const [net, pins] of lay) {
    if (net.startsWith("N/C:")) continue;
    const ss = new Set([...pins].map((p) => sp.get(p)).filter((x): x is string => !!x));
    if (ss.size > 1) shorts.push({ layout_net: net, schematic_nets: [...ss].sort() });
    for (const p of pins) if (schRefs.has(p.split(".")[0]!) && !sp.has(p)) extra.push(`${p} (${net})`);
  }
  return { opens, shorts, missing: missing.sort(), extra: extra.sort() };
}

function compareSnapshots(a: Snapshot, b: Snapshot, ca: ComponentState[], cb: ComponentState[]): Comparison {
  const ma = new Map(ca.map((c) => [c.designator, c])), mb = new Map(cb.map((c) => [c.designator, c]));
  const changed: Comparison["changed"] = [];
  for (const [d, x] of mb) {
    const y = ma.get(d);
    if (!y) continue;
    for (const f of ["mpn", "value", "package"] as const) {
      const norm = (v: string | null) => (f === "mpn" ? normMpn(v) : (v ?? "").toLowerCase().replace(/\s+/g, ""));
      if (norm(y[f]) !== norm(x[f]) && (y[f] || x[f])) changed.push({ designator: d, field: f, from: y[f], to: x[f] });
    }
  }
  const na = a.schematicNets ?? new Map(), nb = b.schematicNets ?? new Map();
  const nets_changed: Comparison["nets_changed"] = [];
  for (const [n, pins] of nb) {
    const old = na.get(n);
    if (!old) continue;
    const added = [...pins].filter((p) => !old.has(p)), removed = [...old].filter((p) => !pins.has(p));
    if (added.length || removed.length) nets_changed.push({ net: n, added, removed });
  }
  const board: string[] = [];
  const ba = boardOf(a), bb = boardOf(b);
  if (ba.copper_layers && bb.copper_layers && ba.copper_layers !== bb.copper_layers) board.push(`copper layers ${ba.copper_layers} → ${bb.copper_layers}`);
  if (ba.width_mm && bb.width_mm && (Math.abs(ba.width_mm - bb.width_mm) > 0.5 || Math.abs((ba.height_mm ?? 0) - (bb.height_mm ?? 0)) > 0.5)) {
    board.push(`outline ${ba.width_mm} × ${ba.height_mm} mm → ${bb.width_mm} × ${bb.height_mm} mm`);
  }
  return {
    from: a.revision, to: b.revision,
    added: [...mb.keys()].filter((d) => !ma.has(d)), removed: [...ma.keys()].filter((d) => !mb.has(d)), changed,
    nets_added: [...nb.keys()].filter((n) => !na.has(n)).sort(), nets_removed: [...na.keys()].filter((n) => !nb.has(n)).sort(),
    nets_changed, board,
  };
}

function boardOf(s: Snapshot): BoardFacts & { sources: string[] } {
  const j = s.json?.board ?? {}, g = s.gerber?.board ?? {}, o = s.odb?.board ?? {}, i = s.idf?.board ?? {};
  const sources = [s.json?.board ? "Flux JSON" : null, s.gerber ? "Gerbers" : null, s.odb?.board?.copper_layers || s.odb?.board?.width_mm ? "ODB++" : null,
                   s.idf?.board?.width_mm ? "IDF" : null].filter((x): x is string => !!x);
  return {
    width_mm: first(j.width_mm, g.width_mm, o.width_mm, i.width_mm), height_mm: first(j.height_mm, g.height_mm, o.height_mm, i.height_mm),
    thickness_mm: first(j.thickness_mm, i.thickness_mm),
    copper_layers: first(j.copper_layers, g.copper_layers, o.copper_layers),
    layer_names: j.layer_names?.length ? j.layer_names : g.layer_names?.length ? g.layer_names : o.layer_names ?? [],
    min_trace_mm: j.min_trace_mm ?? null, min_space_mm: j.min_space_mm ?? null, sources,
  };
}

const EVIDENCE: Record<string, RegExp> = {
  drc: /drc|design[_-]?rule/i, erc: /erc|electrical[_-]?rule/i, simulation: /sim|spice|\.cir$|\.asc$|\.raw$/i,
  bench_test: /test|measure|scope|bench|bringup|bring-up/i, thermal: /therm|temp/i, power: /power|current|consumption/i,
  compliance: /emc|fcc|\bce\b|rohs|ul\b|compliance|cert/i, other: /^$/,
};

export interface AuditInput {
  uploads: Upload[];
  revisions: RevisionInput[];               // oldest first
  history?: HistoryInput | null;
  catalog?: Map<string, CatalogEntry>;
}

export function runAudit(input: AuditInput): AuditReport {
  const { files, problems } = buildInventory(input.uploads);
  const catalog = input.catalog ?? new Map();
  const order = input.revisions.map((r) => r.label);
  const snapshots = order.map((label) => buildSnapshot(label, files.filter((f) => f.revision === label)));
  const states = snapshots.map((s) => componentStates(s, catalog));
  const findings: Finding[] = [];
  let fid = 0;
  const add = (f: Omit<Finding, "id">) => { findings.push({ id: `F${String(++fid).padStart(3, "0")}`, ...f }); return `F${String(fid).padStart(3, "0")}`; };
  const latest = snapshots.at(-1) ?? null;
  const latestStates = states.at(-1) ?? [];

  for (const p of problems) add({ severity: "warning", category: "inventory", revision: null, title: "File could not be read in full", detail: p.problem, evidence: [p.path] });

  // Per revision: what is there, what is missing, what disagrees.
  const ids: Record<string, string[]> = {};
  const tag = (k: string, id: string) => { (ids[k] ??= []).push(id); };
  for (const [i, s] of snapshots.entries()) {
    const isLatest = i === snapshots.length - 1;
    const rev = s.revision;
    const kinds = new Set(s.files.map((f) => f.kind));
    if (!s.files.length) { add({ severity: "warning", category: "inventory", revision: rev, title: "No files for this revision", detail: "Nothing was uploaded under this revision label.", evidence: [] }); continue; }
    const expected: [FileKind[], string, Severity][] = [
      [["flux_json"], "Flux project data (JSON) — the most complete export (Export → Flux project data)", "warning"],
      [["edif", "flux_json"], "a schematic netlist (EDIF, or nets in the JSON)", "warning"],
      [["ipc356"], "the layout netlist (IPC-D-356), needed to check the layout against the schematic", "warning"],
      [["bom_csv", "flux_json"], "a bill of materials", "warning"],
      [["gerber", "ipc2581", "odbpp"], "manufacturing data (Gerbers, IPC-2581 or ODB++)", "info"],
      [["pnp_csv"], "pick-and-place data", "info"],
      [["step", "mesh_3d"], "3D models (STEP)", "info"],
    ];
    if (isLatest) {
      for (const [ks, what, sev] of expected) {
        if (!ks.some((k) => kinds.has(k))) tag("export", add({ severity: sev, category: "inventory", revision: rev, title: `Missing from the export: ${what.split(" (")[0]!.split(" —")[0]}`, detail: `Not found: ${what}.`, evidence: [] }));
      }
    }
    for (const p of s.parsed) {
      if (p.notes.length && isLatest) add({ severity: p.source === "flux_json" ? "info" : "warning", category: "parsing", revision: rev,
        title: p.source === "flux_json" ? "Parts of the Flux JSON were not recognised" : `Problems reading ${p.path.split(/[/!]/).pop()}`,
        detail: p.source === "flux_json" ? "This reader follows Flux's documented description of project.json; check these against the published schema." : "",
        items: p.notes, evidence: [p.path] });
    }
    if (!isLatest) continue;
    const images = s.files.filter((f) => f.kind === "image");
    if (images.length) add({ severity: "info", category: "inventory", revision: rev, title: `${images.length} screenshot(s) or image(s) need a person to read`, detail: "Images are inventoried but not interpreted.", items: images.map((f) => f.path), evidence: [] });
    const unknown = s.files.filter((f) => f.kind === "unknown");
    if (unknown.length) add({ severity: "info", category: "inventory", revision: rev, title: `${unknown.length} file(s) not recognised`, detail: "Kept in the inventory; not used by the audit.", items: unknown.map((f) => f.path), evidence: [] });

    // Missing dependencies: assets the project refers to that are not in the bundle.
    const assets = s.json?.assets ?? [];
    if (assets.length) {
      const shas = new Set(files.map((f) => f.sha256));
      const names = new Set(files.map((f) => f.path.split(/[/!]/).pop()!.toLowerCase()));
      const missing = assets.filter((a) => !(a.sha256 && shas.has(a.sha256)) && !names.has(a.name.split("/").pop()!.toLowerCase()));
      if (missing.length) tag("assets", add({ severity: "warning", category: "dependency", revision: rev, title: `${missing.length} referenced file(s) missing from the export`,
        detail: "The project lists these assets (3D models, datasheets, images) but they are not in the uploaded files. Export with \"JSON and asset files\".",
        items: missing.map((a) => `${a.name}${a.sha256 ? ` (sha256 ${a.sha256.slice(0, 12)}…)` : ""}`), evidence: [s.json!.path] }));
    }

    // Parts.
    const uncertain = latestStates.filter((c) => c.status === "uncertain");
    const byReason = (re: RegExp) => uncertain.filter((c) => c.reasons.some((r) => re.test(r)));
    const noMpn = byReason(/no manufacturer part number/);
    if (noMpn.length) tag("mpn", add({ severity: "warning", category: "sourcing", revision: rev, title: `${noMpn.length} part(s) without a manufacturer part number`, detail: "These cannot be sourced or checked until a part is chosen.", items: noMpn.map((c) => `${c.designator} ${c.value ?? ""} ${c.package ?? ""}`.trim()), evidence: [] }));
    const conflict = byReason(/disagree/);
    if (conflict.length) tag("consistency", add({ severity: "warning", category: "consistency", revision: rev, title: `${conflict.length} part(s) with conflicting part numbers between exports`, detail: "The BOM, the project data and the netlist name different parts for the same designator.", items: conflict.map((c) => `${c.designator}: ${c.reasons.find((r) => /disagree/.test(r))!.replace("part numbers disagree: ", "")}`), evidence: [] }));
    const notBom = byReason(/not in the BOM/), notPlaced = byReason(/not in the placement/), notSch = byReason(/not in the schematic/);
    if (notBom.length || notPlaced.length || notSch.length) tag("consistency", add({ severity: notSch.length ? "blocker" : "warning", category: "consistency", revision: rev,
      title: "Designators do not match across the exports", detail: "Each part should appear in the schematic data, the BOM and the placement file.",
      items: [...notSch.map((c) => `${c.designator}: placed or listed but not in the schematic data`), ...notBom.map((c) => `${c.designator}: not in the BOM`),
              ...notPlaced.map((c) => `${c.designator}: in the BOM but not placed`)], evidence: [] }));
    const life = byReason(/lifecycle/);
    if (life.length) tag("mpn", add({ severity: "warning", category: "sourcing", revision: rev, title: `${life.length} part(s) not recommended for new designs`, detail: "From the VX parts catalog.", items: life.map((c) => `${c.designator} ${c.mpn}: ${c.catalog?.lifecycle}`), evidence: [] }));

    // Schematic vs layout.
    const copper = s.odb?.meta?.copper as { pads: number; tracks: number; surfaces: number } | undefined;
    const unrouted = !!copper && copper.pads > 0 && copper.tracks === 0 && copper.surfaces === 0;
    if (s.schematicNets && s.ipc356?.nets?.size) {
      const rec = reconcilePins(s.schematicNets, s.ipc356.nets);
      if (rec.renamed) add({ severity: "info", category: "connectivity", revision: rev, title: `${rec.renamed} layout pin(s) matched to schematic pins with a different name`,
        detail: "The layout netlist (IPC-D-356) keeps only four characters of a pin name, so names such as VTREF arrive as VTre; these were matched by prefix on the same part." +
          (rec.byNet.length ? ` Some parts are numbered in one export and named in the other (${rec.byNet.join(", ")}); their pins were matched by net, which checks connectivity but not which pad is which: check those footprints' pin numbering against the datasheet.` : ""),
        items: rec.byNet.map((r) => `${r}: pins matched by net, not by name`), evidence: [s.ipc356.path] });
      const cmp = compareConnectivity(s.schematicNets, rec.lay);
      const items = [...cmp.opens.map((o) => `net ${o.net} is split in the layout into ${o.layout_nets.join(", ")}`),
                     ...cmp.shorts.map((o) => `layout net ${o.layout_net} joins schematic nets ${o.schematic_nets.join(", ")}`),
                     ...cmp.missing.map((p) => `pin ${p} is not connected in the layout`), ...cmp.extra.map((p) => `pin ${p} is connected in the layout but not in the schematic`)];
      if (items.length) tag("connectivity", add({ severity: "blocker", category: "connectivity", revision: rev, title: "The layout does not match the schematic",
        detail: "Compared by which pins are joined, not by net names (schematic: " + (s.edif ? "EDIF" : "project JSON") + "; layout: IPC-D-356).", items, evidence: [s.edif?.path ?? s.json!.path, s.ipc356.path] }));
      else add({ severity: "info", category: "connectivity", revision: rev, title: "Layout connectivity matches the schematic netlist", detail: "Every schematic connection between placed parts is present in the layout netlist, and nothing extra. This compares two exports from Flux; it is not an independent DRC." +
        (unrouted ? " The layout netlist lists which net each pad belongs to; the copper has no tracks yet, so none of these connections is made on the board." : ""), evidence: [s.edif?.path ?? s.json!.path, s.ipc356.path] });
    }
    if (unrouted) tag("routing", add({ severity: "warning", category: "routing", revision: rev, title: "The layout is not routed",
      detail: `The ODB++ copper layers hold ${copper!.pads} pad(s) and no tracks or copper pours: parts are placed but nothing is connected on the board yet.`, evidence: [s.odb!.path] }));

    // Board: the outline and layer count wherever more than one export states them.
    const outlines = ([["project data", s.json?.board], ["Gerbers", s.gerber?.board], ["ODB++", s.odb?.board], ["IDF", s.idf?.board]] as const)
      .filter(([, b]) => b?.width_mm && b?.height_mm).map(([n, b]) => [n, b!.width_mm!, b!.height_mm!] as const);
    const off = outlines.filter(([, w, h]) => Math.abs(w - outlines[0]![1]) > 0.5 || Math.abs(h - outlines[0]![2]) > 0.5);
    if (off.length && !(s.json?.board?.width_mm && s.gerber?.board?.width_mm)) tag("layers", add({ severity: "warning", category: "layers", revision: rev, title: "Board size differs between exports",
      detail: outlines.map(([n, w, h]) => `${n}: ${w} × ${h} mm`).join("; "), evidence: [] }));
    const j = s.json?.board, g = s.gerber?.board;
    if (j?.copper_layers && g?.copper_layers && j.copper_layers !== g.copper_layers) tag("layers", add({ severity: "warning", category: "layers", revision: rev, title: "Layer count differs between the project data and the Gerbers", detail: `Stackup lists ${j.copper_layers} copper layers; the Gerbers have ${g.copper_layers}.`, evidence: [s.json!.path, s.gerber!.path] }));
    if (j?.width_mm && g?.width_mm && (Math.abs(j.width_mm - g.width_mm) > 0.5 || Math.abs((j.height_mm ?? 0) - (g.height_mm ?? 0)) > 0.5)) tag("layers", add({ severity: "warning", category: "layers", revision: rev, title: "Board size differs between the project data and the Gerber outline", detail: `Project: ${j.width_mm} × ${j.height_mm} mm; Gerber outline: ${g.width_mm} × ${g.height_mm} mm.`, evidence: [s.json!.path, s.gerber!.path] }));
  }

  // Revisions.
  const comparisons: Comparison[] = [];
  for (let i = 1; i < snapshots.length; i++) comparisons.push(compareSnapshots(snapshots[i - 1]!, snapshots[i]!, states[i - 1]!, states[i]!));
  const repeated: AuditReport["repeated"] = [];
  if (snapshots.length >= 3) {
    const all = new Set(states.flatMap((st) => st.map((c) => c.designator)));
    for (const d of all) {
      for (const f of ["mpn", "value"] as const) {
        const vals = states.map((st) => st.find((c) => c.designator === d)?.[f] ?? null);
        const norm = vals.map((v) => (f === "mpn" ? normMpn(v) : (v ?? "").toLowerCase()));
        for (let i = 2; i < norm.length; i++) {
          if (norm[i] && norm[i] === norm[i - 2] && norm[i] !== norm[i - 1] && norm[i - 1]) {
            repeated.push({ designator: d, field: f, values: vals.slice(i - 2, i + 1), revisions: order.slice(i - 2, i + 1) });
            break;
          }
        }
      }
    }
  }
  if (repeated.length) tag("history", add({ severity: "warning", category: "history", revision: null, title: `${repeated.length} change(s) were made and then undone`,
    detail: "A value went A → B → A across revisions: the same decision was taken twice. Record the reason so it is not reopened.",
    items: repeated.map((r) => `${r.designator} ${r.field}: ${r.values.join(" → ")} (${r.revisions.join(" → ")})`), evidence: [] }));
  const churn = new Map<string, number>();
  for (const c of comparisons) for (const ch of c.changed) churn.set(ch.designator, (churn.get(ch.designator) ?? 0) + 1);
  const hot = [...churn].filter(([, n]) => n >= 2).map(([d, n]) => `${d}: changed in ${n} revisions`);
  if (hot.length) add({ severity: "info", category: "history", revision: null, title: "Parts that keep changing", detail: "Candidates for an explicit decision with its evidence.", items: hot, evidence: [] });

  // Prior decisions and claimed validations (from chat and report exports).
  const h = input.history;
  const latestFiles = latest?.files ?? [];
  const claims = (h?.claims ?? []).map((c) => {
    const re = EVIDENCE[c.kind] ?? EVIDENCE.other!;
    const evidence = latestFiles.filter((f) => f.path !== c.file && ["pdf", "text", "image", "table_csv", "unknown"].includes(f.kind) && re.test(f.path.split(/[/!]/).pop()!)).map((f) => f.path);
    return { ...c, status: evidence.length ? "evidence_present_not_rerun" as const : "unverifiable" as const, evidence };
  });
  const decisions = (h?.decisions ?? []).map((d) => ({ ...d, status: "unverifiable" as const }));
  const unver = claims.filter((c) => c.status === "unverifiable");
  if (unver.length) tag("claims", add({ severity: "warning", category: "claims", revision: null, title: `${unver.length} claimed validation(s) have no supporting files`,
    detail: "Marked unverifiable. They must be re-established before anything depends on them.", items: unver.map((c) => `[${c.kind}] ${c.claim} — ${c.file.split(/[/!]/).pop()}`), evidence: [] }));
  const present = claims.filter((c) => c.status === "evidence_present_not_rerun");
  if (present.length) add({ severity: "info", category: "claims", revision: null, title: `${present.length} claim(s) have a file that may support them`,
    detail: "A related file is in the export, but VX Design has not re-run the check: still not verified.", items: present.map((c) => `[${c.kind}] ${c.claim} — see ${c.evidence.map((e) => e.split(/[/!]/).pop()).join(", ")}`), evidence: [] });
  if (h && h.dropped_quotes) add({ severity: "info", category: "claims", revision: null, title: `${h.dropped_quotes} extracted item(s) dropped`, detail: "Their quoted text was not found word for word in the source file, so they were not kept.", evidence: [] });

  // Current-state map (latest revision).
  let current: AuditReport["current"] = null;
  if (latest) {
    const board = boardOf(latest);
    const sch = latest.schematicNets ?? new Map<string, Set<string>>();
    const pinNet = new Map<string, string>();
    for (const [n, pins] of sch) for (const p of pins) pinNet.set(p, n);
    const pos = (d: string) => latest.components.get(d)?.pnp ?? latest.components.get(d)?.flux_json;
    const edgeOf = (d: string) => {
      const p = pos(d);
      if (!board.width_mm || !board.height_mm || p?.x_mm == null || p?.y_mm == null) return null;
      // Placement origin is assumed at the board's lower-left corner; reported, not relied on.
      const near = [[p.x_mm, "left"], [board.width_mm - p.x_mm, "right"], [p.y_mm, "bottom"], [board.height_mm - p.y_mm, "top"]] as const;
      const [dist, side] = [...near].sort((a, b) => a[0] - b[0])[0]!;
      return dist <= 5 ? `${side} edge (${dist.toFixed(1)} mm in)` : null;
    };
    const connectors = latestStates.filter((c) => CONNECTOR.test(c.designator)).map((c) => ({
      designator: c.designator, mpn: c.mpn,
      pins: [...pinNet].filter(([p]) => p.startsWith(`${c.designator}.`)).map(([p, net]) => ({ pin: p.slice(c.designator.length + 1), net }))
        .sort((a, b) => a.pin.localeCompare(b.pin, "en", { numeric: true })),
      edge: edgeOf(c.designator),
    }));
    const power_rails = [...sch].filter(([n]) => POWER_NET.test(n.replace(/^\//, ""))).map(([net, pins]) => ({
      net, pins: pins.size, components: [...new Set([...pins].map((p) => p.split(".")[0]!))].sort((a, b) => a.localeCompare(b, "en", { numeric: true })),
    })).sort((a, b) => b.pins - a.pins);
    current = {
      revision: latest.revision, components: latestStates, connectors, power_rails, board, nets: sch.size,
      enclosure: {
        outline_mm: board.width_mm && board.height_mm ? `${board.width_mm} × ${board.height_mm}${board.thickness_mm ? ` × ${board.thickness_mm}` : ""} mm` : null,
        mounting_holes: latestStates.filter((c) => MOUNTING.test(c.designator) || MOUNTING.test(c.package ?? "")).map((c) => c.designator),
        edge_connectors: connectors.filter((c) => c.edge).map((c) => `${c.designator}: ${c.edge}`),
        tallest_parts_note: "Part heights are not in these exports; they come from the 3D models (model library) or datasheets.",
      },
    };
    if (!power_rails.length && sch.size) add({ severity: "info", category: "power", revision: latest.revision, title: "No power rails recognised by name", detail: "Rails are found by net name (VCC, 3V3, VBAT, GND…). Name them in the power calculator instead.", evidence: [] });
  }

  // Migration plan: bounded tasks, each tied to the findings it resolves.
  const migration: MigrationTask[] = [];
  const t = (task: Omit<MigrationTask, "id">) => migration.push({ id: `M${migration.length + 1}`, ...task });
  if (ids.export) t({ title: "Complete the Flux export", discipline: "documentation", effort: "S", scope: "Export the missing items from Flux and re-run this audit.", inputs: ["Flux project"], done_when: "This audit reports no missing export items.", findings: ids.export });
  if (ids.assets) t({ title: "Recover missing referenced files", discipline: "documentation", effort: "S", scope: "Export \"JSON and asset files\", or upload the referenced 3D models and datasheets.", inputs: ["Flux project"], done_when: "No referenced file is missing.", findings: ids.assets });
  if (ids.connectivity) t({ title: "Resolve the schematic/layout differences", discipline: "pcb_layout", effort: "M", scope: "Decide for each listed difference whether the schematic or the layout is right; fix the other in Flux (or in the KiCad rebuild).", inputs: ["EDIF", "IPC-D-356"], done_when: "The layout netlist matches the schematic netlist with no differences.", findings: ids.connectivity });
  if (ids.routing) t({ title: "Route the board", discipline: "pcb_layout", effort: "L", scope: "The parts are placed but no copper is routed. Route it (in Flux, or in the KiCad rebuild with autorouting and DRC).", inputs: ["placement", "netlist"], done_when: "Every net is routed and DRC passes with no unrouted connections.", findings: ids.routing });
  if (ids.consistency) t({ title: "Reconcile the BOM, placement and schematic", discipline: "components", effort: "S", scope: "Make every designator appear consistently, with one part number, in all exports (mark do-not-populate parts as such).", inputs: ["BOM", "pick and place", "project JSON"], done_when: "No designator or part-number conflicts remain.", findings: ids.consistency });
  if (ids.mpn) t({ title: "Choose and source the uncertain parts", discipline: "sourcing", effort: "M", scope: "Pick manufacturer part numbers where missing and check lifecycle and stock in M-SRC.", inputs: ["BOM"], done_when: "Every fitted part has a part number with a current offer and an active lifecycle.", findings: ids.mpn });
  if (latest && (latest.schematicNets || latest.bom)) t({ title: "Rebuild the design in KiCad from the export", discipline: "schematic", effort: "L",
    scope: "Flux does not export KiCad projects. Recreate the schematic from the netlist and parts list, then place from the pick-and-place data; keep the Flux Gerbers as the reference until the rebuild matches.",
    inputs: ["project JSON or EDIF", "BOM", "pick and place", "Gerbers"], done_when: "KiCad ERC and DRC pass and the KiCad netlist matches the Flux netlist with no differences.", findings: [...(ids.connectivity ?? []), ...(ids.consistency ?? [])] });
  if (ids.claims) t({ title: "Re-establish the claimed validations", discipline: "verification", effort: "M", scope: "Re-run each claimed check (DRC, ERC, simulation, bench test) in VX Design or attach its original report.", inputs: ["claims list in this audit"], done_when: "Each claim is either re-run with a recorded result or withdrawn.", findings: ids.claims });
  if (current && (latest!.files.every((f) => f.kind !== "step") || ids.assets)) t({ title: "Collect manufacturer 3D models", discipline: "mechanical", effort: "M", scope: "Add STEP models for the parts to the model library and verify their alignment.", inputs: ["BOM"], done_when: "Every fitted part has a verified 3D model.", findings: ids.assets ?? [] });
  if (current) t({ title: "Write the power budget", discipline: "power", effort: "M", scope: `Enter the rails (${current.power_rails.filter((r) => !/gnd/i.test(r.net)).map((r) => r.net).join(", ") || "none named"}) and loads in the power calculator; the export has no currents.`, inputs: ["current-state map"], done_when: "The power calculator's checks pass for every rail.", findings: [] });
  if (current?.enclosure.outline_mm) t({ title: "Record the enclosure constraints", discipline: "enclosure", effort: "S", scope: `Board ${current.enclosure.outline_mm}; ${current.enclosure.mounting_holes.length} mounting hole(s); ${current.enclosure.edge_connectors.length} edge connector(s). Confirm against the design freeze before M-ENC.`, inputs: ["current-state map"], done_when: "Outline, holes and connector openings are confirmed and recorded.", findings: [] });
  if (ids.history) t({ title: "Record the repeated decisions", discipline: "documentation", effort: "S", scope: "For each change that was undone, record the final choice and why, as a project decision.", inputs: ["revision comparison"], done_when: "Each repeated change has a recorded decision with its reason.", findings: ids.history });
  if (ids.layers) t({ title: "Confirm the stackup and outline", discipline: "pcb_layout", effort: "S", scope: "Resolve the layer-count or outline differences between the project data and the Gerbers.", inputs: ["project JSON", "Gerbers"], done_when: "Stackup and outline agree in every export.", findings: ids.layers });

  const blockers = findings.filter((f) => f.severity === "blocker").length;
  return {
    version: AUDIT_VERSION,
    statement: "An imported design is never assumed verified. \"Consistent\" means the exports agree with each other; it is not a design review, and no check has been re-run.",
    revisions: snapshots.map((s, i) => ({
      label: s.revision, date: input.revisions[i]?.date ?? null, note: input.revisions[i]?.note ?? null, files: s.files.filter((f) => f.kind !== "archive").length,
      kinds: s.files.reduce<Partial<Record<FileKind, number>>>((m, f) => ({ ...m, [f.kind]: (m[f.kind] ?? 0) + 1 }), {}),
      project: s.json?.meta ?? null,
    })),
    inventory: files.map(({ data: _d, ...f }) => f),
    problems,
    parse_notes: snapshots.flatMap((s) => s.parsed.filter((p) => p.notes.length).map((p) => ({ path: p.path, notes: p.notes }))),
    findings: findings.sort((a, b) => ["blocker", "warning", "info"].indexOf(a.severity) - ["blocker", "warning", "info"].indexOf(b.severity) || a.id.localeCompare(b.id)),
    current, comparisons, repeated,
    history: { model: h?.model ?? null, offline: h?.offline ?? false, dropped_quotes: h?.dropped_quotes ?? 0, decisions, claims },
    migration,
    summary: {
      revisions: snapshots.length, files: files.filter((f) => f.kind !== "archive").length, components: latestStates.length,
      consistent: latestStates.filter((c) => c.status === "consistent").length, uncertain: latestStates.filter((c) => c.status === "uncertain").length,
      blockers, warnings: findings.filter((f) => f.severity === "warning").length, claims: claims.length, claims_unverifiable: unver.length,
    },
  };
}

export { KIND_LABEL };
