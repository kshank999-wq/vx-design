import { pinKey, type ComponentFacts, type Netlist, type ParsedFile } from "../model.ts";

type SExp = string | SExp[];

export function parseSExp(src: string): SExp[] {
  const out: SExp[] = [];
  const stack: SExp[][] = [out];
  const re = /\s*(?:(\()|(\))|"((?:[^"\\]|\\.)*)"|([^\s()"]+))/gy;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null && m[0] !== "") {
    if (m[1]) { const l: SExp[] = []; stack.at(-1)!.push(l); stack.push(l); }
    else if (m[2]) { if (stack.length > 1) stack.pop(); }
    else stack.at(-1)!.push(m[3] !== undefined ? m[3] : m[4]!);
  }
  return out;
}

const head = (x: SExp) => (Array.isArray(x) && typeof x[0] === "string" ? x[0].toLowerCase() : null);
/** A name is an identifier or (rename id "Original Name"); the original name wins. */
const nameOf = (x: SExp | undefined): { id: string; name: string } => {
  if (typeof x === "string") return { id: x, name: x };
  if (Array.isArray(x) && head(x) === "rename") return { id: String(x[1]), name: typeof x[2] === "string" ? x[2] : String(x[1]) };
  return { id: "", name: "" };
};
function* walk(x: SExp): Generator<SExp[]> {
  if (!Array.isArray(x)) return;
  yield x;
  for (const c of x) yield* walk(c);
}

/** EDIF 2.0.0 schematic netlist: instances (components) and nets (joined port references). */
export function parseEdif(path: string, src: string): ParsedFile {
  const tree = parseSExp(src);
  const notes: string[] = [];
  const instName = new Map<string, string>();
  const components: ComponentFacts[] = [];
  const nets: Netlist = new Map();
  for (const root of tree) {
    for (const n of walk(root)) {
      if (head(n) === "instance") {
        const { id, name } = nameOf(n[1]);
        const designator = (name || id).toUpperCase();
        instName.set(id, designator);
        const props = new Map<string, string>();
        for (const p of n.filter((c): c is SExp[] => head(c) === "property")) {
          const v = p.find((c): c is SExp[] => head(c) === "string");
          if (v) props.set(nameOf(p[1]).name.toLowerCase(), String(v[1] ?? ""));
        }
        const pick = (...ks: string[]) => ks.map((k) => props.get(k)).find((v) => v) ?? null;
        components.push({ designator, value: pick("value"), mpn: pick("mpn", "manufacturer part number", "part number", "partnumber"),
                          manufacturer: pick("manufacturer", "mfr"), footprint: pick("footprint", "package") });
      }
    }
  }
  for (const root of tree) {
    for (const n of walk(root)) {
      if (head(n) !== "net") continue;
      const { name } = nameOf(n[1]);
      const joined = n.find((c): c is SExp[] => head(c) === "joined");
      if (!joined) continue;
      const pins = new Set<string>();
      for (const pr of joined.filter((c): c is SExp[] => head(c) === "portref")) {
        const inst = pr.find((c): c is SExp[] => head(c) === "instanceref");
        if (!inst) continue;   // a port of the cell itself (hierarchy), not a component pin
        const pin = nameOf(pr[1]).name;
        pins.add(pinKey(instName.get(nameOf(inst[1]).id) ?? nameOf(inst[1]).name, pin));
      }
      if (pins.size) nets.set(name, new Set([...(nets.get(name) ?? []), ...pins]));
    }
  }
  if (!components.length) notes.push("no component instances found");
  if (!nets.size) notes.push("no nets found");
  return { source: "edif", path, components, nets, notes };
}
