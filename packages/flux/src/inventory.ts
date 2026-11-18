/**
 * Inventory of a Flux export bundle: unpacks ZIPs (nested once, with size and count limits), hashes every file and
 * classifies it by name and content. Classification is about what the file *is*, not whether it is right.
 */
import { createHash } from "node:crypto";
import { unzipSync } from "fflate";

export type FileKind =
  | "flux_json" | "flux_schema" | "gerber" | "drill" | "bom_csv" | "pnp_csv" | "table_csv" | "edif" | "ipc356" | "ipc2581"
  | "odbpp" | "gencad" | "step" | "mesh_3d" | "drawing" | "pdf" | "image" | "text" | "archive" | "unknown";

export const KIND_LABEL: Record<FileKind, string> = {
  flux_json: "Flux project data (JSON)", flux_schema: "Flux project JSON schema", gerber: "Gerber layer", drill: "Drill file",
  bom_csv: "Bill of materials (CSV)", pnp_csv: "Pick and place (CSV)", table_csv: "Other table (CSV)", edif: "Schematic netlist (EDIF)",
  ipc356: "Layout netlist (IPC-D-356)", ipc2581: "IPC-2581", odbpp: "ODB++", gencad: "GenCAD", step: "3D model (STEP)",
  mesh_3d: "3D mesh (STL/GLB/OBJ…)", drawing: "2D drawing (DXF/SVG)", pdf: "PDF", image: "Image or screenshot",
  text: "Notes, chat or report (text)", archive: "Archive", unknown: "Unrecognised",
};

export interface InventoryFile {
  path: string;            // "<upload name>" or "<upload name>!/inner/path"
  revision: string;        // revision label the upload was tagged with
  kind: FileKind;
  size: number;
  sha256: string;
  data: Uint8Array;
}
export interface InventoryProblem { path: string; problem: string }
export interface Upload { name: string; revision: string; data: Uint8Array }

export const LIMITS = { maxFiles: 5000, maxTotalBytes: 1024 * 1024 * 1024, maxFileBytes: 300 * 1024 * 1024 };

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const ext = (p: string) => (/\.([A-Za-z0-9]+)$/.exec(p)?.[1] ?? "").toLowerCase();
const head = (b: Uint8Array, n = 4096) => new TextDecoder("utf-8", { fatal: false }).decode(b.subarray(0, n));
const isZip = (b: Uint8Array) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

const GERBER_EXT = new Set(["gbr", "ger", "gtl", "gbl", "gto", "gbo", "gts", "gbs", "gtp", "gbp", "gko", "gm1", "gml", "gpt", "gpb",
  "g1", "g2", "g3", "g4", "g5", "g6", "gl2", "gl3", "gl4", "gl5", "gp1", "gp2", "art", "pho", "cmp", "sol", "stc", "sts", "plc", "pls"]);
const DRILL_EXT = new Set(["drl", "xln", "exc", "txt_drl", "nc", "tap"]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);
const MESH_EXT = new Set(["stl", "glb", "gltf", "obj", "3mf", "fbx", "usd", "usda", "usdz", "dae", "wrl", "vrml", "brep", "xao"]);
const TEXT_EXT = new Set(["md", "markdown", "txt", "html", "htm", "log", "rtf"]);

export function classify(path: string, data: Uint8Array): FileKind {
  const name = path.split(/[/!]/).pop()!.toLowerCase();
  const e = ext(name);
  const h = head(data);
  if (e === "json") {
    if (/"\$schema"\s*:/.test(h) && /"properties"\s*:/.test(h) || name.includes("schema")) return "flux_schema";
    return "flux_json";
  }
  if (e === "edif" || e === "edn" || /^\s*\(\s*edif\b/i.test(h)) return "edif";
  if (e === "d356" || e === "ipc" && /^(C |P |3\d7)/m.test(h)) return "ipc356";
  if (e === "ipc2581c" || e === "cvg" || /<IPC-2581/i.test(h)) return "ipc2581";
  if (e === "cad" && /\$HEADER/i.test(h)) return "gencad";
  if (e === "step" || e === "stp" || e === "stpz" || /^ISO-10303-21;/.test(h)) return "step";
  if (MESH_EXT.has(e)) return "mesh_3d";
  if (e === "dxf" || e === "svg") return "drawing";
  if (e === "pdf" || h.startsWith("%PDF-")) return "pdf";
  if (IMAGE_EXT.has(e)) return "image";
  if (/%FS[LT][AI]X\d\dY\d\d\*%/.test(h) || /%TF\.FileFunction/.test(h) || GERBER_EXT.has(e)) return "gerber";
  if (DRILL_EXT.has(e) || /^M48\s*$/m.test(h.slice(0, 200))) return "drill";
  if (e === "csv" || e === "tsv") {
    const first = (h.split(/\r?\n/, 1)[0] ?? "").toLowerCase().replace(/[^a-z0-9,;\t]/g, "");
    const has = (re: RegExp) => re.test(first);
    if (has(/(^|[,;\t])(designator|refdes|ref|reference)/) && has(/(^|[,;\t])(mid?x|posx|x|centerx|locationx)([,;\t]|$)/) && has(/rot/)) return "pnp_csv";
    if (has(/mpn|manufacturerpart|partnumber|mfrpart|quantity|qty|lcsc/) && has(/designator|refdes|reference|ref/)) return "bom_csv";
    return "table_csv";
  }
  if (TEXT_EXT.has(e)) return "text";
  if (isZip(data) || e === "zip") return "archive";
  if (e === "tgz" || e === "tar") return "archive";
  return "unknown";
}

/**
 * Expands uploads into an inventory. ODB++ archives are kept whole (their inner files are tool data, not separate
 * exports). Paths are kept as given; nothing is written to disk.
 */
export function buildInventory(uploads: Upload[]): { files: InventoryFile[]; problems: InventoryProblem[] } {
  const files: InventoryFile[] = [];
  const problems: InventoryProblem[] = [];
  let total = 0;
  const add = (path: string, revision: string, data: Uint8Array, depth: number) => {
    if (files.length >= LIMITS.maxFiles) { problems.push({ path, problem: `more than ${LIMITS.maxFiles} files; the rest were not read` }); return; }
    if (data.length > LIMITS.maxFileBytes) { problems.push({ path, problem: `larger than ${LIMITS.maxFileBytes / 1048576} MB; not read` }); return; }
    total += data.length;
    if (total > LIMITS.maxTotalBytes) { problems.push({ path, problem: "the bundle unpacks to more than 1 GB; the rest was not read" }); return; }
    const lower = path.toLowerCase();
    if (isZip(data) && depth < 2 && !/odb/.test(lower.split(/[/!]/).pop()!)) {
      let inner: Record<string, Uint8Array>;
      try {
        inner = unzipSync(data, { filter: (f) => f.originalSize <= LIMITS.maxFileBytes });
      } catch (e) {
        problems.push({ path, problem: `could not unpack: ${(e as Error).message}` });
        files.push({ path, revision, kind: "archive", size: data.length, sha256: sha(data), data });
        return;
      }
      files.push({ path, revision, kind: "archive", size: data.length, sha256: sha(data), data: new Uint8Array(0) });
      for (const [name, bytes] of Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : 1))) {
        if (name.endsWith("/") || /(^|\/)(__MACOSX|\.DS_Store)/.test(name)) continue;
        if (name.split("/").includes("..")) { problems.push({ path: `${path}!/${name}`, problem: "unsafe path in archive; skipped" }); continue; }
        add(`${path}!/${name}`, revision, bytes, depth + 1);
      }
      return;
    }
    const kind = isZip(data) && /odb/.test(lower) ? "odbpp" : classify(path, data);
    files.push({ path, revision, kind, size: data.length, sha256: sha(data), data });
  };
  for (const u of uploads) add(u.name, u.revision, u.data, 0);
  return { files, problems };
}

export const text = (f: InventoryFile) => new TextDecoder("utf-8", { fatal: false }).decode(f.data);
