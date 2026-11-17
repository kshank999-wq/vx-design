/**
 * Adapter for the KiCad engineering library (services/engineering/vx_eng), which runs as a
 * Python subprocess in the engineering image. Workers without it simply do not advertise
 * the schematic discipline.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { BoardLayout, CircuitCheck, CircuitDesign, FootprintFacts, LayoutCheck } from "@vx/planning";

export interface EngineeringTools {
  python: string;
  /** Directory containing the vx_eng package. */
  dir: string;
  versions: { vx_eng: string; kicad: string };
}

interface Problem { code: string; message: string; suggestions?: string[] }

export interface ValidationResult {
  ok: boolean;
  errors: Problem[];
  warnings: Problem[];
  components: {
    ref: string; symbol: string; footprint: string; symbol_found: boolean; footprint_found: boolean;
    pads_match?: boolean; fp_filter_match?: boolean; units?: number; library_datasheet?: string | null;
    library_description?: string | null; pins?: { number: string; name: string; type: string; unit: number }[];
  }[];
}

export interface BuildResult {
  ok: boolean;
  stage: "validation" | "built" | "kicad";
  error?: string;
  validation: ValidationResult;
  generator_version: string;
  kicad_version: string;
  project?: string;
  sheet?: string;
  erc?: { errors: number; warnings: number; violations: { severity: string; type: string; description: string; items: string[] }[] };
  netlist?: { match: boolean; nets: number; missing: string[][]; unexpected: string[][] };
  files?: Record<"project_zip" | "schematic" | "erc_report" | "netlist" | "pdf" | "svg" | "bom", string>;
}

function call(tools: Pick<EngineeringTools, "python" | "dir">, args: string[], stdin?: string, timeoutMs = 600_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(tools.python, ["-m", "vx_eng", ...args], { cwd: tools.dir, env: { ...process.env, PYTHONPATH: tools.dir } });
    let out = "";
    let err = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`vx_eng ${args[0]} timed out`)); }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`vx_eng ${args[0]} exited ${code}: ${err.trim().slice(-1500)}`));
      try {
        resolve(JSON.parse(out.trim().split("\n").at(-1)!));
      } catch {
        reject(new Error(`vx_eng ${args[0]} printed no JSON: ${(out + err).trim().slice(-1500)}`));
      }
    });
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

/** Finds vx_eng and KiCad, or returns null when this worker cannot do engineering work. */
export async function detectEngineering(): Promise<EngineeringTools | null> {
  if (process.env.VX_ENGINEERING === "off") return null;
  const dir = process.env.VX_ENG_DIR ?? "/opt/vx";
  if (!existsSync(`${dir}/vx_eng/__init__.py`)) return null;
  const python = process.env.VX_PYTHON ?? "python3";
  try {
    const versions = await call({ python, dir }, ["version"], undefined, 60_000) as EngineeringTools["versions"];
    return versions.kicad ? { python, dir, versions } : null;
  } catch {
    return null;
  }
}

export async function validateCircuit(tools: EngineeringTools, design: CircuitDesign): Promise<ValidationResult> {
  return call(tools, ["validate", "--spec", "-"], JSON.stringify(design)) as Promise<ValidationResult>;
}

export async function buildCircuit(tools: EngineeringTools, design: CircuitDesign, outDir: string): Promise<BuildResult> {
  return call(tools, ["build", "--spec", "-", "--out", outDir], JSON.stringify(design)) as Promise<BuildResult>;
}

/** Turns a build result into feedback the model can act on. */
export function toCircuitCheck(r: BuildResult): CircuitCheck {
  const fmt = (p: Problem) => p.suggestions?.length ? `${p.message} (closest library entries: ${p.suggestions.join(", ")})` : p.message;
  if (r.stage === "kicad") return { ok: false, stage: "erc", problems: [`KiCad could not process the schematic: ${r.error}`], warnings: [] };
  const warnings = r.validation.warnings.map(fmt);
  if (r.stage === "validation") return { ok: false, stage: "validation", problems: r.validation.errors.map(fmt), warnings };
  const problems: string[] = [];
  for (const v of r.erc?.violations ?? []) {
    const line = `ERC ${v.severity} ${v.type}: ${v.description}${v.items.length ? ` (${v.items.join("; ")})` : ""}`;
    if (v.severity === "error") problems.push(line);
    else warnings.push(line);
  }
  if (problems.length) return { ok: false, stage: "erc", problems, warnings };
  if (r.netlist && !r.netlist.match) {
    return { ok: false, stage: "netlist", warnings, problems: [
      ...r.netlist.missing.map((n) => `KiCad's netlist is missing the intended connection ${n.join(" - ")}`),
      ...r.netlist.unexpected.map((n) => `KiCad's netlist has an unintended connection ${n.join(" - ")}`),
    ] };
  }
  return { ok: true, stage: "built", problems: [], warnings };
}

// --- Board layout (G4) ---------------------------------------------------------------------

export interface FootprintsResult {
  ok: boolean;
  footprints: FootprintFacts[];
  fab_profiles: Record<string, { name: string; description: string } & Record<string, unknown>>;
  hole_sizes: string[];
}

interface LayoutProblem { code: string; message: string; items?: string[]; violations?: unknown[] }

export interface DrcViolation {
  severity: string; type: string; description: string; excluded: boolean;
  items: { description: string; pos?: { x: number; y: number } }[];
}

export interface ModelResult {
  ref: string; footprint: string; model: string | null; status: "found" | "missing" | "none" | "unsupported_path";
  source?: string; sha256?: string; bytes?: number; error?: string;
}

export interface LayoutBuildResult {
  ok: boolean;
  stage: "placement" | "schematic" | "built" | "kicad";
  error?: string;
  generator_version?: string;
  kicad_version?: string;
  placement?: { ok: boolean; problems: LayoutProblem[]; warnings: LayoutProblem[]; density?: number };
  schematic?: unknown;
  problems?: LayoutProblem[];
  project?: string;
  erc?: { errors: number; warnings: number };
  board?: { footprints: number; nets: number; copper_layers: number; zones: number; thickness_mm: number;
            width_mm: number; height_mm: number; fab_profile: Record<string, unknown> & { name: string } };
  routing?: { router: string | null; segments: number; vias: number; length_mm?: number; widths_mm?: number[];
              ground_pour: { net: string; layers: string[] } | null; power_nets: string[]; solid_zone_connections: string[] };
  drc?: { errors: number; warnings: number; unconnected: number; parity: number; waived: number; violations: DrcViolation[] };
  models?: { found: number; total: number; missing: ModelResult[]; tag: string };
  export_errors?: string | null;
  files?: Partial<Record<"project_zip" | "drc_report" | "models" | "svg" | "pdf" | "bom" | "erc_report" | "netlist" |
                         "pcb_svg_top" | "pcb_svg_bottom" | "pcb_pdf" | "render_top" | "render_bottom" | "render_iso" |
                         "step" | "glb", string>>;
}

export async function footprints(tools: EngineeringTools, design: CircuitDesign): Promise<FootprintsResult> {
  return call(tools, ["footprints", "--spec", "-"], JSON.stringify(design)) as Promise<FootprintsResult>;
}

/** Builds, routes and checks the board in outDir (also rebuilds the schematic there). */
export async function buildLayout(tools: EngineeringTools, design: CircuitDesign, layout: BoardLayout, outDir: string): Promise<LayoutBuildResult> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(outDir, { recursive: true });
  const layoutPath = `${outDir}.layout.json`;
  await writeFile(layoutPath, JSON.stringify(layout));
  return call(tools, ["layout-build", "--spec", "-", "--layout", layoutPath, "--out", outDir], JSON.stringify(design), 1_800_000) as
    Promise<LayoutBuildResult>;
}

/** Turns a layout build into feedback the model can act on. */
export function toLayoutCheck(r: LayoutBuildResult): LayoutCheck {
  const fmt = (p: LayoutProblem) => p.message +
    (p.items?.length ? ` (${p.items.slice(0, 12).join("; ")})` : "") +
    (p.violations?.length ? `: ${p.violations.slice(0, 12).map((v) => typeof v === "string" ? v
      : `${(v as { type: string }).type}: ${(v as { description: string }).description} [${((v as { items?: string[] }).items ?? []).join("; ")}]`).join(" | ")}` : "");
  if (r.stage === "kicad") return { ok: false, stage: "drc", problems: [`KiCad could not process the board: ${r.error}`], warnings: [] };
  const warnings = (r.placement?.warnings ?? []).map(fmt);
  if (r.stage === "placement") return { ok: false, stage: "placement", problems: (r.placement?.problems ?? []).map(fmt), warnings };
  if (r.stage === "schematic") {
    return { ok: false, stage: "schematic", warnings,
             problems: ["The approved schematic no longer builds; the layout cannot fix this (re-run the schematic task)."] };
  }
  const problems = (r.problems ?? []).map(fmt);
  if (r.export_errors) warnings.push(`Some exports failed: ${r.export_errors}`);
  for (const v of r.drc?.violations ?? []) {
    if (v.severity === "warning") warnings.push(`DRC warning ${v.type}: ${v.description}`);
  }
  if (problems.length || !r.ok) {
    const stage = (r.problems ?? []).some((p) => p.code === "routing_incomplete") ? "routing" : "drc";
    return { ok: false, stage, problems: problems.length ? problems : ["DRC did not pass"], warnings };
  }
  return { ok: true, stage: "built", problems: [], warnings };
}
