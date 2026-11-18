/**
 * Synthetic Flux exports for tests: three revisions (A, B, C) of a small timecode board, each a ZIP shaped like
 * Flux's documented exports (project.json, EDIF, IPC-D-356, and a nested manufacturing ZIP with Gerbers, BOM and
 * pick-and-place). Invented data, not a real Flux export. Revision C carries planted problems:
 *   - U2 went AP2112K → MCP1700 (B) → AP2112K (C): a decision taken twice
 *   - D1 has no part number; C2 is placed but missing from the BOM; J1's part number differs between BOM and JSON
 *   - the layout splits LTC_RX (R2.2 on its own net) and leaves J2.2 unconnected
 *   - project.json lists a 3D model asset that is not in the export
 *   - chat notes claim a DRC pass (a DRC report is attached) and a bench test (nothing attached)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { zipSync } from "fflate";
import type { Upload } from "../src/inventory.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const MTIME = new Date(Date.UTC(2026, 10, 9));
type Part = { ref: string; mpn: string | null; mfr: string | null; value: string; pkg: string; x: number; y: number; rot: number };

function parts(rev: "A" | "B" | "C"): Part[] {
  return [
    { ref: "U1", mpn: "STM32G031K8T6", mfr: "STMicroelectronics", value: "STM32G031", pkg: "LQFP-32", x: 25, y: 15, rot: 0 },
    { ref: "U2", mpn: rev === "B" ? "MCP1700T-3302E/TT" : "AP2112K-3.3TRG1", mfr: rev === "B" ? "Microchip" : "Diodes Inc", value: "3V3 LDO", pkg: "SOT-23-5", x: 10, y: 20, rot: 90 },
    { ref: "J1", mpn: "USB4105-GF-A", mfr: "GCT", value: "USB-C", pkg: "USB-C-16P", x: 1.5, y: 15, rot: 270 },
    { ref: "J2", mpn: "1-1337540-0", mfr: "TE", value: "LTC in", pkg: "3.5mm jack", x: 48, y: 10, rot: 90 },
    { ref: "C1", mpn: "GRM188R61E106KA73D", mfr: "Murata", value: "10u", pkg: "0603", x: 8, y: 24, rot: 0 },
    { ref: "C2", mpn: "GRM155R71C104KA88D", mfr: "Murata", value: "100n", pkg: "0402", x: 14, y: 20, rot: 0 },
    { ref: "R1", mpn: "RC0402FR-071KL", mfr: "Yageo", value: "1k", pkg: "0402", x: 30, y: 25, rot: 0 },
    { ref: "R2", mpn: rev === "A" ? "RC0402FR-071KL" : "RC0402FR-0710KL", mfr: "Yageo", value: rev === "A" ? "1k" : "10k", pkg: "0402", x: 40, y: 12, rot: 0 },
    { ref: "D1", mpn: rev === "C" ? null : "150040GS73240", mfr: rev === "C" ? null : "Wurth", value: "green", pkg: "0402", x: 34, y: 25, rot: 0 },
    { ref: "H1", mpn: null, mfr: null, value: "M2", pkg: "MountingHole_2.2mm", x: 3, y: 3, rot: 0 },
    { ref: "H2", mpn: null, mfr: null, value: "M2", pkg: "MountingHole_2.2mm", x: 47, y: 27, rot: 0 },
  ];
}

const NETS: Record<string, string[]> = {
  VBUS: ["J1.A4", "U2.1", "U2.3", "C1.1"],
  "3V3": ["U2.5", "U1.4", "C2.1", "R1.1"],
  GND: ["J1.A1", "U2.2", "C1.2", "C2.2", "U1.16", "J2.2", "D1.2"],
  LTC_IN: ["J2.1", "R2.1"],
  LTC_RX: ["R2.2", "U1.10"],
  LED_K: ["R1.2", "D1.1"],
};

function edif(ps: Part[]): string {
  const id = (s: string) => s.replace(/[^A-Za-z0-9]/g, "_");
  return `(edif timecode (edifVersion 2 0 0) (edifLevel 0) (keywordMap (keywordLevel 0))
  (library work (edifLevel 0) (technology (numberDefinition))
    (cell timecode (cellType GENERIC) (view netlist (viewType NETLIST) (interface)
      (contents
${ps.map((p) => `        (instance ${p.ref} (viewRef netlist (cellRef ${id(p.pkg)})) (property Value (string "${p.value}"))${p.mpn ? ` (property MPN (string "${p.mpn}"))` : ""})`).join("\n")}
${Object.entries(NETS).map(([n, pins]) => `        (net (rename N_${id(n)} "${n}") (joined ${pins.map((p) => { const [r, pin] = p.split("."); return `(portRef ${/^\d/.test(pin!) ? `(rename P${pin} "${pin}")` : pin} (instanceRef ${r}))`; }).join(" ")}))`).join("\n")}
      )))))
`;
}

function d356(rev: "A" | "B" | "C"): string {
  const lines = ["C  IPC-D-356 netlist (synthetic test data)", "P  JOB   timecode", "P  UNITS CUST 0", "P  NNAME1     LTC_RX_STUB"];
  const rec = (net: string, ref: string, pin: string) => `327${net.padEnd(14).slice(0, 14)}   ${ref.padEnd(6).slice(0, 6)}-${pin.padEnd(4).slice(0, 4)}M       X+010000Y+010000X0100Y0100R000 S0`;
  for (const [net, pins] of Object.entries(NETS)) {
    for (const p of pins) {
      const [ref, pin] = p.split(".") as [string, string];
      if (rev === "C" && p === "R2.2") { lines.push(rec("NNAME1", ref, pin)); continue; }
      if (rev === "C" && p === "J2.2") { lines.push(rec("N/C", ref, pin)); continue; }
      lines.push(rec(net, ref, pin));
    }
  }
  lines.push("317GND            VIA   -    D0300PA00X+020000Y+020000X0600Y0000R000 S3", "999");
  return lines.join("\n") + "\n";
}

const gerberHead = (fn: string) => `G04 synthetic*\n%TF.GenerationSoftware,Flux,test*%\n%TF.FileFunction,${fn}*%\n%FSLAX46Y46*%\n%MOMM*%\n%ADD10C,0.100000*%\nD10*\n`;
const outline = (w: number, h: number) => `${gerberHead("Profile,NP")}X0Y0D02*\nX${w * 1e6}Y0D01*\nX${w * 1e6}Y${h * 1e6}D01*\nX0Y${h * 1e6}D01*\nX0Y0D01*\nM02*\n`;
const copper = (l: number, side: string) => `${gerberHead(`Copper,L${l},${side}`)}X1000000Y1000000D03*\nM02*\n`;

function bom(ps: Part[], rev: "A" | "B" | "C"): string {
  const rows = ps.filter((p) => !p.ref.startsWith("H") && !(rev === "C" && p.ref === "C2"));
  return ["Designator,Quantity,Value,Package,Manufacturer,MPN",
    ...rows.map((p) => `"${p.ref}",1,${p.value},${p.pkg},${p.mfr ?? ""},${p.mpn ?? ""}`)].join("\r\n") + "\r\n";
}
const pnp = (ps: Part[]) => ["Designator,Mid X,Mid Y,Layer,Rotation", ...ps.filter((p) => !p.ref.startsWith("H")).map((p) => `${p.ref},${p.x}mm,${p.y}mm,Top,${p.rot}`)].join("\n") + "\n";

function projectJson(ps: Part[], rev: "A" | "B" | "C"): string {
  return JSON.stringify({
    project: { name: "Smart Slate timecode board", version: `rev ${rev}`, exportedAt: `2026-1${rev === "A" ? 0 : 1}-0${rev === "C" ? 9 : 2}` },
    components: ps.map((p) => ({ designator: p.ref, part: { mpn: rev === "C" && p.ref === "J1" ? "USB4110-GF-A" : p.mpn, manufacturer: p.mfr },
      value: p.value, package: p.pkg, position: { x: p.x, y: p.y }, rotation: p.rot, side: "top" })),
    nets: Object.entries(NETS).map(([name, pins]) => ({ name, pins: pins.map((x) => { const [designator, pin] = x.split("."); return { designator, pin }; }) })),
    boards: [{ name: "main", outline: { points: [[0, 0], [50, 0], [50, 30], [0, 30]] },
      stackup: [{ name: "Top", type: "copper", thickness: 0.035 }, { name: "Core", type: "dielectric", thickness: 1.53 }, { name: "Bottom", type: "copper", thickness: 0.035 }],
      designRules: [{ name: "default", minTraceWidth: 0.15, minClearance: 0.15 }] }],
    assets: rev === "C" ? [{ name: "models/USB4105-GF-A.step", sha256: "ab".repeat(32), size: 120000 }] : [],
  }, null, 2);
}

const CHAT_C = `# Flux chat export (synthetic)

**Alex:** We went back and forth on the regulator. We decided to use the AP2112K because the MCP1700 dropout was too high at 500 mA.

**Sam:** DRC passed with no errors on the rev C layout.

**Alex:** Bench tested LTC decode at 30 fps with the Tentacle as source, no dropped frames.

**Sam:** Let's keep the 3.5 mm jack for LTC in; BNC is too tall for the enclosure.
`;

export function fluxFixture(): Upload[] {
  return (["A", "B", "C"] as const).map((rev) => {
    const ps = parts(rev);
    const mfg = zipSync({
      "gerbers/timecode-F_Cu.gbr": enc(copper(1, "Top")), "gerbers/timecode-B_Cu.gbr": enc(copper(2, "Bot")),
      "gerbers/timecode-Edge_Cuts.gbr": enc(outline(50, 30)), "gerbers/timecode.drl": enc("M48\nMETRIC\nT1C0.3\n%\nT1\nX20.0Y20.0\nM30\n"),
      "pick_and_place.csv": enc(pnp(ps)), "bom/bom.csv": enc(bom(ps, rev)), "bom/bom-JLCPCB.csv": enc(bom(ps, rev).replace("MPN", "LCSC Part #")),
    }, { mtime: MTIME });
    const files: Record<string, Uint8Array> = {
      "project.json": enc(projectJson(ps, rev)), "schematic.edif": enc(edif(ps)), "layout.d356": enc(d356(rev)),
      "manufacturing.zip": mfg, "screenshot.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
    };
    if (rev === "C") { files["notes/chat-export.md"] = enc(CHAT_C); files["drc_report.txt"] = enc("Flux DRC: 0 errors, 2 warnings (silkscreen overlap)\n"); }
    return { name: `timecode-rev${rev}.zip`, revision: `Rev ${rev}`, data: zipSync(files, { mtime: MTIME }) };
  });
}

/** Writes the three ZIPs to a folder (used by the browser test). */
export function writeFixture(dir: string): string[] {
  mkdirSync(dir, { recursive: true });
  return fluxFixture().map((u) => { const p = join(dir, u.name); writeFileSync(p, u.data); return p; });
}

