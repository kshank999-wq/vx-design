/**
 * Runs inside the engineering-worker image (KiCad, vx_eng): builds the offline fixture circuit's schematic, board and
 * fab package exactly as the worker does, then prints a normalised summary of every result and file. Volatile fields
 * (creation dates, tool-version banners) are removed by normalise(); anything else that varies is a finding.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { unzipSync } from "fflate";
import { buildCircuit, buildFabPackage, buildLayout, detectEngineering } from "../../services/orchestrator/src/engineering.ts";
import { OFFLINE_FIXTURE_CIRCUIT, OFFLINE_FIXTURE_LAYOUT } from "../../packages/planning/src/index.ts";

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const TEXT = /\.(gbrjob|kicad_sch|kicad_pcb|kicad_pro|kicad_prl|net|csv|gbr|gtl|gbl|gto|gbo|gts|gbs|gtp|gbp|gm1|gko|drl|xln|txt|json|rpt|svg|ipc|d356|pos|md|cir)$/i;
const SKIP = /\.(png|jpg|pdf|step|stp|glb|wrl|log)$/i;   // renders, exports with embedded dates, and logs: presence only

/** In JSON (files and results): hashes of dated PDFs/PNGs and of zips holding dated job files become "present"
 *  (their contents are compared member by member elsewhere). */
export function scrub(o: any): any {
  if (Array.isArray(o)) return o.map(scrub);
  if (o && typeof o === "object") {
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "string" && /\.(pdf|png|zip)$/i.test(k) && /^[0-9a-f]{64}$/.test(v) ? "present" : scrub(v)]));
  }
  return o;
}

/** Removes what legitimately changes between runs (dates, ids derived from time). */
export function normalise(name: string, text: string): string {
  if (/\.json$/.test(name)) {
    try { text = JSON.stringify(scrub(JSON.parse(text))); } catch { /* not JSON: normalise as text */ }
  }
  return text
    .replace(/^G04 .*$/gm, "G04")
    .replace(/%TF\.CreationDate,[^*]*\*%/g, "%TF.CreationDate*%")
    .replace(/^; .*(DRILL file|#@!|Created|created|date).*$/gm, ";")
    .replace(/\(date "[^"]*"\)/g, '(date "")')
    .replace(/"date":\s*"[^"]*"/g, '"date": ""')
    .replace(/^\*\*\* ERC REPORT.*$|^\*\* Drc report.*$|^\*\* Created on .*$/gm, "")
    .replace(/<dc:date>[^<]*<\/dc:date>/g, "")
    .replace(/(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:?\d{2}|Z)?)/g, "<time>");
}

function digestOne(name: string, b: Uint8Array): string {
  return SKIP.test(name) ? "present" : TEXT.test(name) ? sha(normalise(name, new TextDecoder().decode(b))) : sha(b);
}
/** Zips are compared by their members (recursively), so a dated file inside does not hide everything else. */
function digestZip(prefix: string, data: Uint8Array, out: Record<string, string>): void {
  for (const [n, b] of Object.entries(unzipSync(data)).sort(([a], [b2]) => (a < b2 ? -1 : 1))) {
    if (n.endsWith("/")) continue;
    if (/\.zip$/i.test(n)) digestZip(`${prefix}!/${n}`, b, out);
    else out[`${prefix}!/${n}`] = digestOne(n, b);
  }
}

function digestTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  const walk = (d: string) => {
    for (const f of readdirSync(d).sort()) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      const rel = relative(dir, p);
      const bytes = readFileSync(p);
      if (/\.zip$/i.test(f)) digestZip(rel, new Uint8Array(bytes), out);
      else out[rel] = digestOne(f, new Uint8Array(bytes));
    }
  };
  walk(dir);
  return out;
}

const tools = await detectEngineering();
if (!tools) { console.error("engineering tools not found (run inside the engineering-worker image)"); process.exit(2); }
const work = "/tmp/vx-regression";
const sch = await buildCircuit(tools, OFFLINE_FIXTURE_CIRCUIT, `${work}/schematic`);
const lay = await buildLayout(tools, OFFLINE_FIXTURE_CIRCUIT, OFFLINE_FIXTURE_LAYOUT, `${work}/layout`);
const pz = lay.files?.project_zip;
const fab = pz ? await buildFabPackage(tools, isAbsolute(pz) ? pz : join(`${work}/layout`, pz), `${work}/fab`) : null;
const strip = (o: unknown): unknown => JSON.parse(normalise("result.json", JSON.stringify(o, (k, v) => (k === "files" || /path$|_dir$|^out$/.test(k) ? undefined : v))));
if (process.env.REGRESSION_KEEP) { const { cpSync } = await import("node:fs"); cpSync(work, process.env.REGRESSION_KEEP, { recursive: true }); }
console.log("REGRESSION_JSON " + JSON.stringify({
  versions: tools.versions,
  inputs: { circuit: sha(JSON.stringify(OFFLINE_FIXTURE_CIRCUIT)), layout: sha(JSON.stringify(OFFLINE_FIXTURE_LAYOUT)) },
  schematic: { result: strip(sch), files: digestTree(`${work}/schematic`) },
  layout: { result: strip(lay), files: digestTree(`${work}/layout`) },
  fab: fab ? { result: strip(fab), files: digestTree(`${work}/fab`) } : null,
}));
