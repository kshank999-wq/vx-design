/**
 * Fab package executor (G4.5): committed routed board -> DRC gate -> KiKit board-house files ->
 * independent Gerber/drill re-read, CPL and BOM checks -> drawings, fab notes, panel, package zip.
 *
 * Deterministic: no model call. A fab package is a release, so it always waits for sign-off.
 *
 * Steps (checkpointed): context (find the upstream board) -> package (build, check, stash) -> store.
 * Gerbers carry creation timestamps, so the checked files are stashed in the step that checked them
 * and a resumed attempt registers exactly those files.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Validation } from "../db.ts";
import { buildFabPackage, type EngineeringTools, type FabPackageResult } from "../engineering.ts";
import type { Executor, ExecutorContext, ExecutorResult } from "../execution.ts";

type FileKey = keyof NonNullable<FabPackageResult["files"]>;

const FILES: { key: FileKey; suffix: string; kind: string; type: string }[] = [
  { key: "package", suffix: "fab-package", kind: "fab_package", type: "application/zip" },
  { key: "gerbers", suffix: "gerbers", kind: "fab_package", type: "application/zip" },
  { key: "bom", suffix: "assembly-bom", kind: "bom", type: "text/csv; charset=utf-8" },
  { key: "cpl", suffix: "cpl", kind: "fab_package", type: "text/csv; charset=utf-8" },
  { key: "notes", suffix: "fab-notes", kind: "fab_package", type: "text/plain; charset=utf-8" },
  { key: "assembly_top", suffix: "assembly-top", kind: "fab_package", type: "application/pdf" },
  { key: "assembly_bottom", suffix: "assembly-bottom", kind: "fab_package", type: "application/pdf" },
  { key: "drill_map", suffix: "drill-map", kind: "fab_package", type: "application/pdf" },
  { key: "panel_gerbers", suffix: "panel-gerbers", kind: "fab_package", type: "application/zip" },
  { key: "panel_render", suffix: "panel-render", kind: "fab_package", type: "image/png" },
  { key: "check", suffix: "fab-check", kind: "report", type: "application/json" },
];

interface Stashed { path: string; name: string; sha256: string }
type Summary = Omit<FabPackageResult, "files">;

export function fabExecutor(tools: EngineeringTools): Executor {
  const toolVersion = `vx_eng ${tools.versions.vx_eng} / KiCad ${tools.versions.kicad} / KiKit`;
  return {
    id: "fab-package",
    version: `vx_eng-${tools.versions.vx_eng}`,
    describe: "Board-house package from the committed board, re-read independently of KiCad",
    disciplines: ["manufacturing"],
    canRun: (task) => task.discipline === "manufacturing",

    async run(ctx: ExecutorContext): Promise<ExecutorResult> {
      const { task, db } = ctx;
      const work = await mkdtemp(join(tmpdir(), `vx-fab-${ctx.exec.id.slice(0, 8)}-`));
      try {
        const source = await ctx.step("context", async () =>
          db.upstreamVersion(task.id, "kicad-project", ["pcb_layout"]));
        if (!source) {
          return { status: "blocked", reason: "The fab package needs a committed routed board from an upstream PCB layout task " +
                                              "('<layout task>/kicad-project'). Run and approve the layout first." };
        }
        await ctx.log(`packaging ${source.taskKey}/kicad-project (version ${source.versionId.slice(0, 8)})`);

        const packaged = await ctx.step("package", async () => {
          const zip = join(work, "project.zip");
          await writeFile(zip, await db.downloadBytes(source.storagePath));
          const out = join(work, "out");
          const r = await buildFabPackage(tools, zip, out);
          await ctx.log(r.ok ? `fab package ${r.revision}: all checks pass`
                             : `fab package stopped at ${r.stage}: ${r.error ?? (r.problems ?? []).map((p) => p.message).join("; ")}`,
                        { stage: r.stage, drc: r.drc, problems: r.problems, warnings: r.warnings }, r.ok ? "info" : "warn");
          const stash: Partial<Record<FileKey, Stashed>> = {};
          if (r.stage === "built") {
            for (const f of FILES) {
              const name = r.files?.[f.key];
              if (!name) continue;
              const bytes = await readFile(join(out, name));
              const sha256 = createHash("sha256").update(bytes).digest("hex");
              const path = `${task.project_id}/stash/${ctx.exec.id}/${sha256.slice(0, 16)}-${name}`;
              await db.upload(path, bytes, f.type);
              stash[f.key] = { path, name, sha256 };
            }
          }
          const { files: _files, ...summary } = r;
          return { summary: summary as Summary, stash };
        });
        const r = packaged.summary;

        if (r.stage === "kicad") return { status: "failed", retryable: true, error: `fab package tools failed: ${r.error}` };
        const drcCheck: Validation = {
          kind: "drc", result: r.stage === "drc" ? "fail" : "pass", evidence_category: "cad_check",
          summary: `Release gate, KiCad DRC with schematic parity: ${r.drc?.errors} errors, ${r.drc?.unconnected} unrouted, ` +
                   `${r.drc?.parity} schematic differences, ${r.drc?.waived} waived`,
          tool_name: "kicad", tool_version: tools.versions.kicad, details: r.drc,
        };
        if (r.stage === "drc") {
          return { status: "failed", retryable: false, validations: [drcCheck],
                   error: "The committed board does not pass DRC with schematic parity; fix the layout before releasing it" };
        }

        const stored = await ctx.step("store", async () => {
          const versions: Record<string, string> = {};
          const config = { revision: r.revision, profile: r.profile?.name, house: r.profile?.house, source_board: source.versionId,
                           offline: ctx.offline || !!source.toolConfig?.offline };
          for (const f of FILES) {
            const s = packaged.stash[f.key];
            if (!s) continue;
            const bytes = await db.downloadBytes(s.path);
            const got = createHash("sha256").update(bytes).digest("hex");
            if (got !== s.sha256) throw new Error(`stashed ${s.name} changed in storage`);
            const v = await ctx.storeArtifact({
              name: `${task.key}/${f.suffix}`, kind: f.kind, filename: s.name, content: bytes, contentType: f.type,
              toolName: f.key === "check" ? "vx_eng" : "kikit", toolVersion, toolConfig: config,
              summary: f.key === "package" ? `${r.project} rev ${r.revision}: ${r.profile?.description} package` : undefined,
            });
            versions[f.key] = v.versionId;
          }
          return versions;
        });

        const g = r.gerbers!;
        const a = r.assembly!;
        const gerberProblems = (r.problems ?? []).filter((p) => !p.code.startsWith("cpl") && !p.code.startsWith("bom"));
        const assemblyProblems = (r.problems ?? []).filter((p) => p.code.startsWith("cpl") || p.code.startsWith("bom"));
        const silk = (r.warnings ?? []).filter((w) => w.code === "silk_outside_board");
        const validations: Validation[] = [
          { ...drcCheck, artifact_version_id: stored.check },
          { kind: "dfm", result: gerberProblems.length ? "fail" : silk.length ? "warning" : "pass", evidence_category: "cad_check",
            summary: gerberProblems.length ? `Gerber re-read: ${gerberProblems.map((p) => p.message).join("; ")}`
              : `Gerbers re-read without KiCad: ${g.layers.length} layers, outline ${g.outline_mm[0]} x ${g.outline_mm[1]} mm, ` +
                `${g.drill_hits.plated} plated + ${g.drill_hits.nonplated} non-plated holes match the board, smallest drill ` +
                `${g.min_drill_mm} mm, copper-to-edge within ${r.profile?.name} rules`,
            artifact_version_id: stored.gerbers, tool_name: "gerbonara", tool_version: "1.6.3", details: { ...g, warnings: silk } },
        ];
        if (r.profile?.assembly) {
          validations.push(
            { kind: "other", result: assemblyProblems.length ? "fail" : a.rotation_corrections.length ? "warning" : "pass",
              evidence_category: "cad_check",
              summary: assemblyProblems.length ? `Pick-and-place: ${assemblyProblems.map((p) => p.message).join("; ")}`
                : `Pick-and-place: ${a.cpl_rows} parts at the board's positions and sides` +
                  (a.rotation_corrections.length ? `; house rotation corrections on ${a.rotation_corrections.map((c) => c.ref).join(", ")}` : ""),
              artifact_version_id: stored.cpl, tool_name: "vx_eng", tool_version: tools.versions.vx_eng },
            { kind: "bom_check", result: a.lcsc_missing.length ? "warning" : "pass", evidence_category: "unverified_assumption",
              summary: a.lcsc_missing.length
                ? `Assembly BOM: ${a.bom_lines} lines; LCSC part numbers missing for ${a.lcsc_missing.length} part(s), so assembly ` +
                  "cannot be ordered yet (bare boards can)"
                : `Assembly BOM: ${a.bom_lines} lines, every line has an LCSC part number (not yet checked against stock)`,
              artifact_version_id: stored.bom, tool_name: "vx_eng", tool_version: tools.versions.vx_eng,
              details: { lcsc_missing: a.lcsc_missing } },
          );
        }
        if (!r.ok) return { status: "failed", retryable: false, validations, error: "the fab package failed its independent checks" };
        const offline = ctx.offline || !!source.toolConfig?.offline;
        return {
          status: "passed", validations,
          summary: `${r.project} rev ${r.revision}: ${r.profile?.description} package, ${r.board?.width_mm} x ${r.board?.height_mm} mm` +
                   (r.panel ? `, plus a ${r.panel.size_mm[0]} x ${r.panel.size_mm[1]} mm 2x2 panel` : ""),
          reviewReason: "A fab package is a release: check the fab notes and drawings before ordering" +
                        (offline ? " (the board is the offline fixture, not derived from your requirements)" : ""),
        };
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    },
  };
}
