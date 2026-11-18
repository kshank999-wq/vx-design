import { pinKey, type Netlist, type ParsedFile } from "../model.ts";

/**
 * IPC-D-356(A) layout netlist: fixed-column records. 317 = through-hole access, 327 = SMT access (also 017/027 etc.).
 * Cols 4-17 net name, 21-26 reference designator, 28-31 pin. Long net names are given by "P  NNAMEn" lines.
 * VIA records carry no component pin and are skipped. "N/C" pins are recorded as unconnected.
 */
export function parseIpc356(path: string, src: string): ParsedFile {
  const aliases = new Map<string, string>();
  const nets: Netlist = new Map();
  let units = "";
  const notes: string[] = [];
  let bad = 0;
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (line.startsWith("P ")) {
      const m = /^P\s+(NNAME\d+)\s+(.+)$/.exec(line);
      if (m) aliases.set(m[1]!, m[2]!.trim());
      const u = /^P\s+UNITS\s+(\S+)/.exec(line);
      if (u) units = u[1]!;
      continue;
    }
    if (!/^[0-3][0-9]7/.test(line)) continue;
    let net = line.slice(3, 17).trim();
    const ref = line.slice(20, 26).trim();
    const pin = line.slice(27, 31).trim();
    if (!ref || ref.toUpperCase() === "VIA") continue;
    if (!pin) { bad++; continue; }
    net = aliases.get(net) ?? net;
    if (!net || net === "N/C") net = `N/C:${ref}.${pin}`;
    if (!nets.has(net)) nets.set(net, new Set());
    nets.get(net)!.add(pinKey(ref, pin));
  }
  if (bad) notes.push(`${bad} record(s) without a pin number were skipped`);
  if (!nets.size) notes.push("no component access records found");
  return { source: "ipc356", path, nets, meta: { units }, notes };
}
