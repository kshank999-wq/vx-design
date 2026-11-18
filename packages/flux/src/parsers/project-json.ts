import { pinKey, type AssetRef, type BoardFacts, type ComponentFacts, type Netlist, type ParsedFile } from "../model.ts";

/**
 * Flux project data (project.json). Flux documents the content (project information, components with designators,
 * part data, pins and placements, nets, the BOM, boards with outline, stackup, traces, vias, pads, copper fills and
 * net design rules, design rule sets, schematic wires, and assets with size and SHA-256; units mm and degrees) and
 * publishes a JSON schema alongside it. This reader is written against that description, not a real export, so it
 * looks for each section under several plausible key names and reports what it could not find.
 */
type J = Record<string, unknown>;
const isObj = (v: unknown): v is J => !!v && typeof v === "object" && !Array.isArray(v);
const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Value under any of the keys (case/punctuation-insensitive), also looking inside `properties`/`part` objects or name/value lists. */
function pick(o: unknown, keys: string[], depth = 0): unknown {
  if (!isObj(o)) return undefined;
  const want = keys.map(norm);
  for (const [k, v] of Object.entries(o)) if (want.includes(norm(k)) && v !== null && v !== "") return v;
  if (depth > 1) return undefined;
  for (const sub of ["properties", "props", "part", "partData", "attributes", "data", "position", "placement"]) {
    const s = Object.entries(o).find(([k]) => norm(k) === norm(sub))?.[1];
    if (isObj(s)) { const v = pick(s, keys, depth + 1); if (v !== undefined) return v; }
    if (Array.isArray(s)) {
      for (const it of s) if (isObj(it) && typeof it.name === "string" && want.includes(norm(it.name)) && it.value != null) return it.value;
    }
  }
  return undefined;
}
const str = (v: unknown) => (typeof v === "string" ? v.trim() || null : typeof v === "number" ? String(v) : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const arrayAt = (o: unknown, keys: string[]): unknown[] | null => {
  const v = pick(o, keys);
  if (Array.isArray(v)) return v;
  if (isObj(v)) return Object.entries(v).map(([k, x]) => (isObj(x) ? { _key: k, ...x } : x));
  return null;
};

function points(v: unknown): { x: number; y: number }[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((p) => {
    if (Array.isArray(p) && p.length >= 2 && typeof p[0] === "number") return [{ x: p[0] as number, y: p[1] as number }];
    if (isObj(p)) {
      const x = num(p.x), y = num(p.y);
      if (x != null && y != null) return [{ x, y }];
      return points(p.points ?? p.vertices ?? (p.start ? [p.start, p.end] : null));
    }
    return [];
  });
}

export function parseProjectJson(path: string, src: string): ParsedFile {
  const notes: string[] = [];
  let doc: unknown;
  try { doc = JSON.parse(src); } catch (e) { return { source: "flux_json", path, notes: [`not valid JSON: ${(e as Error).message}`] }; }
  if (!isObj(doc)) return { source: "flux_json", path, notes: ["the JSON is not an object"] };
  const project = isObj(doc.project) ? doc.project : doc;
  const meta: Record<string, unknown> = {
    top_level_keys: Object.keys(doc).slice(0, 50),
    name: str(pick(project, ["name", "title", "projectName"])),
    version: str(pick(project, ["version", "revision", "schemaVersion"])) ?? str(pick(doc, ["version", "schemaVersion", "$schema"])),
    exported_at: str(pick(project, ["exportedAt", "exportDate", "createdAt", "updatedAt", "date"])) ?? str(pick(doc, ["exportedAt", "exportDate"])),
    url: str(pick(project, ["url", "link", "sourceProject", "projectUrl"])),
  };

  // Components.
  const comps = arrayAt(doc, ["components", "parts", "elements", "instances"]) ?? arrayAt(project, ["components", "parts"]);
  const components: ComponentFacts[] = [];
  if (!comps) notes.push("no components section found");
  for (const c of comps ?? []) {
    const designator = str(pick(c, ["designator", "refdes", "reference", "referenceDesignator", "ref", "name", "_key"]));
    if (!designator) continue;
    const pos = pick(c, ["position", "placement", "location", "origin"]);
    const layer = str(pick(c, ["side", "layer", "boardSide", "mountSide"]));
    components.push({
      designator: designator.toUpperCase(),
      mpn: str(pick(c, ["mpn", "manufacturerPartNumber", "partNumber", "mfrPartNumber", "mfrPN"])),
      manufacturer: str(pick(c, ["manufacturer", "manufacturerName", "mfr", "mfg"])),
      value: str(pick(c, ["value", "val"])),
      package: str(pick(c, ["package", "packageName", "case"])),
      footprint: str(pick(c, ["footprint", "footprintName", "land pattern"])),
      x_mm: num(pick(pos, ["x"])) ?? num(pick(c, ["x"])), y_mm: num(pick(pos, ["y"])) ?? num(pick(c, ["y"])),
      rotation: num(pick(c, ["rotation", "angle", "rot"])),
      side: layer ? (/bot|back/i.test(layer) ? "bottom" : "top") : null,
      dnp: pick(c, ["dnp", "doNotPopulate", "excludeFromBom"]) === true,
    });
  }

  // Nets: [{name, pins: ["R1.1", {designator, pin}, ...]}]
  const netArr = arrayAt(doc, ["nets", "netlist", "connections"]);
  const nets: Netlist = new Map();
  if (!netArr) notes.push("no nets section found");
  for (const n of netArr ?? []) {
    const name = str(pick(n, ["name", "netName", "label", "_key"]));
    const pins = arrayAt(n, ["pins", "connections", "members", "terminals", "nodes"]) ?? [];
    if (!name) continue;
    const set = nets.get(name) ?? new Set<string>();
    for (const p of pins) {
      if (typeof p === "string") {
        const m = /^([A-Za-z_][\w]*?)[.:\-/](\w+)$/.exec(p.trim());
        if (m) set.add(pinKey(m[1]!, m[2]!));
      } else {
        const ref = str(pick(p, ["designator", "component", "componentDesignator", "refdes", "ref", "part"]));
        const pin = str(pick(p, ["pin", "pinNumber", "pinName", "terminal", "number"]));
        if (ref && pin) set.add(pinKey(ref, pin));
      }
    }
    nets.set(name, set);
  }

  // Board.
  const boards = arrayAt(doc, ["boards", "board", "layouts", "pcbs"]) ?? (isObj(pick(doc, ["board", "layout", "pcb"])) ? [pick(doc, ["board", "layout", "pcb"])] : null);
  const b0 = boards?.[0];
  const board: BoardFacts = {};
  if (!b0) notes.push("no board section found");
  else {
    const outline = pick(b0, ["outline", "boardOutline", "shape", "edge"]);
    const pts = points(isObj(outline) ? outline.points ?? outline.vertices ?? outline.segments ?? outline.path : outline);
    const w = num(pick(outline, ["width", "w"])) ?? num(pick(b0, ["width"])), h = num(pick(outline, ["height", "h"])) ?? num(pick(b0, ["height"]));
    if (pts.length >= 2) {
      const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
      board.width_mm = +(Math.max(...xs) - Math.min(...xs)).toFixed(3);
      board.height_mm = +(Math.max(...ys) - Math.min(...ys)).toFixed(3);
    } else if (w != null && h != null) { board.width_mm = w; board.height_mm = h; }
    else notes.push("board outline not found or not in a recognised form");
    const stack = arrayAt(b0, ["stackup", "layers", "layerStack"]);
    if (stack) {
      const cu = stack.filter((l) => /copper|signal|plane|\bcu\b|mixed/i.test(`${str(pick(l, ["type", "kind", "material"])) ?? ""} ${str(pick(l, ["name"])) ?? ""}`));
      board.copper_layers = cu.length || null;
      board.layer_names = cu.map((l) => str(pick(l, ["name"])) ?? "?");
      const t = stack.map((l) => num(pick(l, ["thickness", "thicknessMm"]))).filter((x): x is number => x != null);
      if (t.length === stack.length && t.length) board.thickness_mm = +t.reduce((a, x) => a + x, 0).toFixed(3);
    } else notes.push("no stackup found");
    board.thickness_mm = num(pick(b0, ["thickness", "boardThickness"])) ?? board.thickness_mm ?? null;
    const rules = pick(b0, ["designRules", "rules", "netDesignRules"]) ?? pick(doc, ["designRules", "designRuleSets", "rules"]);
    const ruleObjs = Array.isArray(rules) ? rules : rules ? [rules] : [];
    const tw = ruleObjs.map((r) => num(pick(r, ["minTraceWidth", "traceWidth", "minWidth", "width"]))).filter((x): x is number => x != null);
    const cl = ruleObjs.map((r) => num(pick(r, ["minClearance", "clearance", "minSpacing", "spacing"]))).filter((x): x is number => x != null);
    board.min_trace_mm = tw.length ? Math.min(...tw) : null;
    board.min_space_mm = cl.length ? Math.min(...cl) : null;
  }

  // Assets: files the project refers to (3D models, datasheets, images), with their hashes.
  const assetArr = arrayAt(doc, ["assets", "files", "attachments"]);
  const assets: AssetRef[] = (assetArr ?? []).flatMap((a) => {
    const name = str(pick(a, ["name", "filename", "fileName", "path", "_key"]));
    return name ? [{ name, sha256: str(pick(a, ["sha256", "hash", "sha", "checksum"]))?.toLowerCase() ?? null, size: num(pick(a, ["size", "fileSize", "bytes"])) }] : [];
  });
  return { source: "flux_json", path, components, nets, board, assets, meta, notes };
}
