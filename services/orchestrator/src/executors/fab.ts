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
  // Exchange formats (S5), each read back and checked against the board by vx_eng.
  { key: "ipc2581", suffix: "ipc2581", kind: "fab_package", type: "application/xml" },
  { key: "odb", suffix: "odb", kind: "fab_package", type: "application/zip" },
  { key: "ipcd356", suffix: "ipc356-netlist", kind: "fab_package", type: "text/plain; charset=utf-8" },
  { key: "dxf", suffix: "outline-dxf", kind: "fab_package", type: "application/dxf" },
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
        // Every board of the product: the latest committed layout of each board upstream.
        const sources = await ctx.step("context", async () =>
          db.upstreamBoards(task.id, "kicad-project", ["pcb_layout"]));
        // LCSC numbers from an upstream sourcing task, if any. Only live distributor data is applied.
        const lcsc = await ctx.step("lcsc", async () => {
          const m = await db.upstreamJson(task.id, "lcsc-map");
          if (!m) return { status: "none" as const, map: {} as Record<string, string>, boards: null as Record<string, Record<string, string>> | null, from: null };
          const v = m.value as { data_status: string; lcsc: Record<string, string>; boards?: Record<string, Record<string, string>> };
          return v.data_status === "live" ? { status: "applied" as const, map: v.lcsc, boards: v.boards ?? null, from: m.taskKey }
                                          : { status: "not_live" as const, map: {}, boards: null, from: m.taskKey };
        });
        if (!sources.length) {
          return { status: "blocked", reason: "The fab package needs a committed routed board from an upstream PCB layout task " +
                                              "('<layout task>/kicad-project'). Run and approve the layout first." };
        }
        const multi = sources.length > 1;
        const one = async (source: (typeof sources)[number]): Promise<ExecutorResult> => {
        const label = multi ? (source.board ?? source.taskKey) : null;
        const sfx = label ? `:${label}` : "";
        const prefix = label ? `${task.key}.${label}` : task.key;
        await ctx.log(`packaging ${source.taskKey}/kicad-project (version ${source.versionId.slice(0, 8)})${label ? ` for board ${label}` : ""}`);

        const packaged = await ctx.step(`package${sfx}`, async () => {
          const zip = join(work, `project${label ? `-${label}` : ""}.zip`);
          await writeFile(zip, await db.downloadBytes(source.storagePath));
          const out = join(work, `out${label ? `-${label}` : ""}`);
          let mapPath: string | undefined;
          const boardMap = source.board && lcsc.boards?.[source.board] ? lcsc.boards[source.board]! : lcsc.map;
          if (Object.keys(boardMap).length) {
            mapPath = join(work, `lcsc${label ? `-${label}` : ""}.json`);
            await writeFile(mapPath, JSON.stringify(boardMap));
          }
          const r = await buildFabPackage(tools, zip, out, mapPath);
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
              const base = name.split("/").pop()!;
              const path = `${task.project_id}/stash/${ctx.exec.id}/${sha256.slice(0, 16)}-${base}`;
              await db.upload(path, bytes, f.type);
              stash[f.key] = { path, name: base, sha256 };
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

        const stored = await ctx.step(`store${sfx}`, async () => {
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
              name: `${prefix}/${f.suffix}`, kind: f.kind, filename: s.name, content: bytes, contentType: f.type,
              toolName: f.key === "check" ? "vx_eng" : "kikit", toolVersion, toolConfig: { ...config, board: source.board },
              summary: f.key === "package" ? `${r.project} rev ${r.revision}: ${r.profile?.description} package` : undefined,
            });
            versions[f.key] = v.versionId;
          }
          return versions;
        });

        const g = r.gerbers!;
        const a = r.assembly!;
        const isExport = (code: string) => /^(ipc2581|odb|ipcd356|dxf)_/.test(code);
        const exportProblems = (r.problems ?? []).filter((p) => isExport(p.code));
        const gerberProblems = (r.problems ?? []).filter((p) => !p.code.startsWith("cpl") && !p.code.startsWith("bom") && !isExport(p.code));
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
        if (r.exports) {
          validations.push({ kind: "other", result: exportProblems.length ? "fail" : "pass", evidence_category: "cad_check",
            summary: exportProblems.length ? `Exchange formats: ${exportProblems.map((p) => p.message).join("; ")}`
              : `Exchange formats read back and matching the board: ${Object.values(r.exports.labels).join(", ")}`,
            artifact_version_id: stored.ipc2581 ?? stored.check, tool_name: "vx_eng", tool_version: tools.versions.vx_eng, details: r.exports });
        }
        if (r.profile?.assembly) {
          validations.push(
            { kind: "other", result: assemblyProblems.length ? "fail" : a.rotation_corrections.length ? "warning" : "pass",
              evidence_category: "cad_check",
              summary: assemblyProblems.length ? `Pick-and-place: ${assemblyProblems.map((p) => p.message).join("; ")}`
                : `Pick-and-place: ${a.cpl_rows} parts at the board's positions and sides` +
                  (a.rotation_corrections.length ? `; house rotation corrections on ${a.rotation_corrections.map((c) => c.ref).join(", ")}` : ""),
              artifact_version_id: stored.cpl, tool_name: "vx_eng", tool_version: tools.versions.vx_eng },
            { kind: "bom_check", result: a.lcsc_missing.length ? "warning" : "pass", evidence_category: "unverified_assumption",
              summary: (a.lcsc_missing.length
                ? `Assembly BOM: ${a.bom_lines} lines; LCSC part numbers missing for ${a.lcsc_missing.length} part(s), so assembly ` +
                  "cannot be ordered yet (bare boards can)"
                : `Assembly BOM: ${a.bom_lines} lines, every line has an LCSC part number`) +
                (lcsc.status === "applied" ? `; ${r.lcsc_applied?.length ?? 0} part(s) numbered from ${lcsc.from}'s live sourcing`
                 : lcsc.status === "not_live" ? `; ${lcsc.from}'s LCSC numbers are fixture data and were not applied` : ""),
              artifact_version_id: stored.bom, tool_name: "vx_eng", tool_version: tools.versions.vx_eng,
              details: { lcsc_missing: a.lcsc_missing, lcsc_source: lcsc.from, lcsc_status: lcsc.status, applied: r.lcsc_applied } },
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
        };

        const outs: { label: string; r: ExecutorResult }[] = [];
        for (const source of sources) outs.push({ label: source.board ?? source.taskKey, r: await one(source) });
        if (!multi) return outs[0]!.r;
        const validations = outs.flatMap((o) => (o.r.status === "blocked" ? [] : o.r.validations ?? [])
          .map((v) => ({ ...v, summary: `${o.label}: ${v.summary}` })));
        const failed = outs.filter((o) => o.r.status !== "passed");
        if (failed.length) {
          return { status: "failed", validations, retryable: failed.every((f) => f.r.status === "failed" && f.r.retryable),
                   error: failed.map((f) => `${f.label}: ${f.r.status === "failed" ? f.r.error : f.r.status === "blocked" ? f.r.reason : ""}`).join("; ") };
        }
        const passed = outs.map((o) => o.r as Extract<ExecutorResult, { status: "passed" }>);
        return { status: "passed", validations,
                 summary: `${outs.length} boards: ` + outs.map((o, i) => `${o.label}: ${passed[i]!.summary}`).join(" · "),
                 reviewReason: passed.find((r) => r.reviewReason)?.reviewReason ?? null };
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    },
  };
}
