/**
 * PCB layout executor (G4): approved schematic design -> board layout (model) -> placement checks ->
 * native KiCad board linked to the schematic -> Freerouting -> ground pours -> KiCad DRC with
 * schematic parity -> KiCad library 3D models -> STEP, GLB, renders and layer drawings.
 *
 * Steps (checkpointed):
 *   context (upstream design + footprint facts) -> layout (model + repair loop against placement,
 *   routing and DRC; the passing build is stashed in storage) -> store (register the stashed files)
 *
 * Routing is not bit-for-bit reproducible, so the files that passed DRC are stashed in the same
 * step that checked them; a resumed attempt registers those exact files instead of rebuilding.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CircuitDesign, LAYOUT_PROMPT_VERSION, LayoutDesignError, generateLayout, requiredLayersFromNotes,
  type BoardLayout, type LayoutCheck, type LayoutInput,
} from "@vx/planning";
import type { Validation } from "../db.ts";
import { normalizeManufacturer, normalizeMpn } from "@vx/integrations";
import { buildLayout, footprints, toLayoutCheck, type EngineeringTools, type LayoutBuildResult } from "../engineering.ts";
import type { Executor, ExecutorContext, ExecutorResult } from "../execution.ts";

type FileKey = keyof NonNullable<LayoutBuildResult["files"]>;

const FILES: { key: FileKey; suffix: string; kind: string; type: string }[] = [
  { key: "project_zip", suffix: "kicad-project", kind: "kicad_project", type: "application/zip" },
  { key: "render_iso", suffix: "render-3d", kind: "pcb", type: "image/png" },
  { key: "render_top", suffix: "render-top", kind: "pcb", type: "image/png" },
  { key: "render_bottom", suffix: "render-bottom", kind: "pcb", type: "image/png" },
  { key: "pcb_svg_top", suffix: "pcb-top-svg", kind: "pcb", type: "image/svg+xml" },
  { key: "pcb_svg_bottom", suffix: "pcb-bottom-svg", kind: "pcb", type: "image/svg+xml" },
  { key: "pcb_pdf", suffix: "pcb-pdf", kind: "pcb", type: "application/pdf" },
  { key: "step", suffix: "board-step", kind: "step", type: "model/step" },
  { key: "glb", suffix: "board-glb", kind: "other", type: "model/gltf-binary" },
  { key: "drc_report", suffix: "drc-report", kind: "report", type: "application/json" },
  { key: "models", suffix: "model-report", kind: "report", type: "application/json" },
];

interface Stashed { path: string; name: string; sha256: string }

interface LayoutOutcome {
  layout: BoardLayout;
  rounds: number;
  warnings: string[];
  history: { round: number; stage: string; problems: number }[];
  build: Pick<LayoutBuildResult, "board" | "routing" | "drc" | "models" | "erc" | "kicad_version" | "generator_version">;
  stash: Partial<Record<FileKey, Stashed>>;
}

export function pcbExecutor(tools: EngineeringTools): Executor {
  const toolVersion = `vx_eng ${tools.versions.vx_eng} / KiCad ${tools.versions.kicad} / Freerouting`;
  return {
    id: "kicad-pcb",
    version: `${LAYOUT_PROMPT_VERSION}+vx_eng-${tools.versions.vx_eng}`,
    describe: "Board placed by the model, routed by Freerouting, checked by KiCad DRC with schematic parity",
    disciplines: ["pcb_layout"],
    canRun: (task) => task.discipline === "pcb_layout",

    async run(ctx: ExecutorContext): Promise<ExecutorResult> {
      const { task, db } = ctx;
      const work = await mkdtemp(join(tmpdir(), `vx-pcb-${ctx.exec.id.slice(0, 8)}-`));
      try {
        const context = await ctx.step("context", async () => {
          // A board built over several tasks: its latest design. Otherwise the nearest upstream design.
          const source = task.board ? await db.boardJson(task.id, "design", ["schematic"], task.board) : await db.upstreamJson(task.id, "design");
          if (!source) return null;
          const parsed = CircuitDesign.safeParse(source.value);
          if (!parsed.success) return null;
          const circuit = parsed.data;
          const [project, reqs, upstream, notes, fp] = await Promise.all([
            db.project(task.project_id), db.taskRequirements(task.id), db.upstreamOutputs(task.id), db.reviewNotes(task.id),
            footprints(tools, circuit),
          ]);
          const input: LayoutInput = {
            projectContext: `${project.name}${project.description ? `: ${project.description}` : ""}`,
            task: { key: task.key, title: task.title, description: task.description },
            requirements: reqs.map((r) => ({ refCode: r.ref_code, kind: r.kind, priority: r.priority, text: r.text })),
            acceptanceTests: task.acceptance_tests.map((a) => ({ id: a.id, description: a.description, method: a.method })),
            upstream: upstream.filter((u) => u.content).map((u) => ({ taskKey: u.taskKey, title: u.title, content: u.content! })),
            reviewNotes: notes,
            circuit,
            footprints: fp.footprints,
            fabProfiles: Object.values(fp.fab_profiles).map((p) => ({ name: p.name, description: p.description })),
          };
          // Verified manufacturer models from the library (this project's, or shared), matched by part and footprint.
          const wanted = circuit.components.filter((c) => c.mpn && c.manufacturer)
            .map((c) => ({ ref: c.ref, footprint: c.footprint, normalizedMpn: normalizeMpn(c.mpn!), normalizedMfr: normalizeManufacturer(c.manufacturer) }));
          const verified = await db.verifiedModels(task.project_id, wanted);
          const models: Record<string, { id: string; storage_path: string; sha256: string; source: string; mpn: string }> = {};
          for (const w of wanted) {
            const m = verified.find((v) => v.normalized_mpn === w.normalizedMpn && v.normalized_mfr === w.normalizedMfr && v.footprint === w.footprint);
            if (m) models[w.ref] = { id: m.id, storage_path: m.storage_path, sha256: m.sha256, source: m.source, mpn: w.normalizedMpn };
          }
          return { input, source: { taskKey: source.taskKey, versionId: source.versionId }, models };
        });
        if (!context) {
          return { status: "blocked", reason: "PCB layout needs the committed circuit design of an upstream schematic task " +
                                              "(artifact '<schematic task>/design'). Run and approve the schematic first." };
        }
        const { input: cached, source, models: libraryModels } = context;
        // Guidance given after this attempt's context was saved still counts (e.g. "use 4 layers").
        const freshNotes = await db.reviewNotes(task.id);
        const input: LayoutInput = { ...cached, reviewNotes: freshNotes, requiredLayers: requiredLayersFromNotes(freshNotes) };

        // Stackup, placement and routing of one board are often separate tasks: when the board's earlier layout task
        // already routed this exact design version, take that board over (copied, with its checks) instead of laying
        // it out again.
        if (task.board) {
          const reused = await ctx.step("reuse", async () => {
            const [prev] = await db.upstreamBoards(task.id, "kicad-project", ["pcb_layout"], task.board);
            if (!prev || prev.toolConfig?.source_design !== source.versionId) return null;
            const copied: Record<string, string> = {};
            for (const f of [...FILES, { key: "layout", suffix: "layout", kind: "other", type: "application/json" }]) {
              const [v] = await db.upstreamBoards(task.id, f.suffix, ["pcb_layout"], task.board);
              if (!v || v.taskKey !== prev.taskKey) continue;
              const bytes = await db.downloadBytes(v.storagePath);
              const st = await ctx.storeArtifact({
                name: `${task.key}/${f.suffix}`, kind: f.kind, filename: v.storagePath.split("/").pop()!.replace(/^[0-9a-f]{16}-/, ""),
                content: bytes, contentType: f.type, toolName: f.suffix === "layout" ? "vx-design" : "kicad", toolVersion,
                toolConfig: { ...(v.toolConfig ?? {}), reused_from: prev.taskKey },
                summary: f.suffix === "kicad-project" ? `${input.circuit.title}: board taken over from ${prev.taskKey} (circuit unchanged)` : undefined,
              });
              copied[f.suffix] = st.versionId;
            }
            return { from: prev.taskKey, copied };
          });
          if (reused) {
            // The earlier task's checks hold for the same board: carry them over, saying where they come from.
            const prevTask = (await db.allUpstream(task.id)).find((u) => u.key === reused.from);
            const prevChecks = prevTask ? await db.latestValidations([prevTask.id]) : [];
            const failing = prevChecks.filter((c) => c.result === "fail" || c.result === "error");
            await ctx.log(`board ${task.board}: design unchanged since ${reused.from}; its routed board is taken over`);
            if (failing.length) {
              return { status: "failed", retryable: false, error: `The board taken over from ${reused.from} has failing checks: ${failing.map((c) => c.summary).join("; ")}` };
            }
            return {
              status: "passed",
              validations: prevChecks.length ? prevChecks.map((c) => ({ kind: c.kind, result: c.result as Validation["result"], evidence_category: c.evidence_category,
                  summary: `Board taken over from ${reused.from} (same circuit design version): ${c.summary}`,
                  artifact_version_id: c.kind === "drc" ? reused.copied["drc-report"] : undefined, tool_name: c.tool_name ?? undefined }))
                : [{ kind: "drc", result: "warning", evidence_category: "cad_check", summary: `Board taken over from ${reused.from} (same circuit design version); its checks were not found` }],
              summary: `${input.circuit.title}: board from ${reused.from} kept (the circuit has not changed since it was laid out)`,
              reviewReason: null,
            };
          }
        }
        await ctx.log(`laying out ${input.circuit.components.length} components from ${source.taskKey}/design` +
                      (Object.keys(libraryModels).length ? `; verified manufacturer models for ${Object.keys(libraryModels).join(", ")}` : ""));

        let outcome: LayoutOutcome;
        try {
          outcome = await ctx.step("layout", async (): Promise<LayoutOutcome> => {
            const builds = new Map<number, { dir: string; result: LayoutBuildResult }>();
            const local: Record<string, { path: string; name: string }> = {};
            if (Object.keys(libraryModels).length) {
              await mkdir(join(work, "models"), { recursive: true });
              for (const [ref, m] of Object.entries(libraryModels)) {
                const path = join(work, "models", `${m.id}.step`);
                await writeFile(path, await db.downloadBytes(m.storage_path));
                local[ref] = { path, name: `${m.mpn}-${m.sha256.slice(0, 8)}` };
              }
            }
            const r = await generateLayout(input, ctx.model,
              async (layout, round): Promise<LayoutCheck> => {
                const dir = join(work, `round-${round}`);
                const result = await buildLayout(tools, input.circuit, layout, dir, local);
                builds.set(round, { dir, result });
                return toLayoutCheck(result);
              },
              async (round, check, usage) => {
                await ctx.chargeModelUsage([usage], round === 1 ? "board_layout" : "board_layout_repair");
                const b = builds.get(round)?.result;
                await ctx.log(`layout round ${round}: ${check.ok
                  ? `routed, DRC ${b?.drc?.errors} errors / ${b?.drc?.warnings} warnings, parity clean`
                  : `${check.problems.length} problem(s) at ${check.stage}`}`,
                  { round, stage: check.stage, problems: check.problems.slice(0, 20), drc: b?.drc && { ...b.drc, violations: undefined } },
                  check.ok ? "info" : "warn");
              });
            const { dir, result } = builds.get(r.rounds)!;
            const stash: LayoutOutcome["stash"] = {};
            for (const f of FILES) {
              const name = result.files?.[f.key];
              if (!name) continue;
              const bytes = await readFile(join(dir, name));
              const sha256 = createHash("sha256").update(bytes).digest("hex");
              const path = `${task.project_id}/stash/${ctx.exec.id}/${sha256.slice(0, 16)}-${name}`;
              await db.upload(path, bytes, f.type);
              stash[f.key] = { path, name, sha256 };
            }
            const { board, routing, drc, models, erc, kicad_version, generator_version } = result;
            return { layout: r.layout, rounds: r.rounds, warnings: r.check.warnings, history: r.history, stash,
                     build: { board, routing, drc: drc && { ...drc, violations: drc.violations.slice(0, 50) }, models, erc,
                              kicad_version, generator_version } };
          });
        } catch (e) {
          if (e instanceof LayoutDesignError) {
            return { status: "failed", retryable: true, error: e.message, validations: [{
              kind: "drc", result: "fail", evidence_category: "cad_check", tool_name: "kicad", tool_version: tools.versions.kicad,
              summary: `Layout still failed placement, routing or DRC after ${e.rounds} round(s)`, details: { problems: e.problems.slice(0, 50) } }] };
          }
          throw e;
        }

        const stored = await ctx.step("store", async () => {
          const versions: Record<string, string> = {};
          const config = { model: ctx.modelLabel, offline: ctx.offline, fab_profile: outcome.layout.fab_profile,
                           source_design: source.versionId };
          for (const f of FILES) {
            const s = outcome.stash[f.key];
            if (!s) continue;
            const bytes = await db.downloadBytes(s.path);
            const got = createHash("sha256").update(bytes).digest("hex");
            if (got !== s.sha256) throw new Error(`stashed ${s.name} changed in storage (sha ${got.slice(0, 12)} != ${s.sha256.slice(0, 12)})`);
            const stored = await ctx.storeArtifact({
              name: `${task.key}/${f.suffix}`, kind: f.kind, filename: s.name, content: bytes, contentType: f.type,
              toolName: f.key === "models" ? "vx_eng" : "kicad", toolVersion, toolConfig: config,
              summary: f.key === "project_zip" ? `${input.circuit.title}: KiCad 10 project with routed board` : undefined,
            });
            versions[f.key] = stored.versionId;
          }
          const layoutDoc = { ...outcome.layout, source_design: { task: source.taskKey, version_id: source.versionId },
                              history: outcome.history, board: outcome.layout.board };
          const s = await ctx.storeArtifact({
            name: `${task.key}/layout`, kind: "other", filename: "layout.json", content: JSON.stringify(layoutDoc, null, 2),
            contentType: "application/json", toolName: "vx-design", toolVersion: LAYOUT_PROMPT_VERSION, toolConfig: config,
          });
          versions.layout = s.versionId;
          return versions;
        });

        const { board, routing, drc, models } = outcome.build;
        if (!board || !routing || !drc || !models) throw new Error("layout build result is incomplete");
        const allModels = models.found === models.total;
        const validations: Validation[] = [
          { kind: "drc", result: drc.errors || drc.unconnected ? "fail" : drc.warnings ? "warning" : "pass", evidence_category: "cad_check",
            summary: `KiCad DRC: ${drc.errors} errors, ${drc.warnings} warnings, ${drc.unconnected} unrouted, ${drc.waived} waived ` +
                     `(${board.fab_profile.name} rules)`,
            artifact_version_id: stored.drc_report, tool_name: "kicad", tool_version: tools.versions.kicad,
            details: { errors: drc.errors, warnings: drc.warnings, unconnected: drc.unconnected, waived: drc.waived,
                       violations: drc.violations } },
          { kind: "other", result: drc.parity ? "fail" : "pass", evidence_category: "cad_check",
            summary: drc.parity ? `Schematic parity: ${drc.parity} difference(s) between board and schematic`
                                : `Schematic parity: the board matches the schematic (${board.footprints} footprints, ${board.nets} nets)`,
            artifact_version_id: stored.drc_report, tool_name: "kicad", tool_version: tools.versions.kicad },
          { kind: "footprint_check", result: allModels ? "pass" : "warning", evidence_category: "cad_check",
            summary: `3D models: ${models.found} of ${models.total} parts have a model; ` +
                     (Object.keys(context.models).length ? `verified manufacturer CAD for ${Object.keys(context.models).join(", ")}, ` : "") +
                     `the rest are KiCad library package shapes (generic, not manufacturer CAD)` +
                     (allModels ? "" : `; missing: ${models.missing.map((m) => m.ref).join(", ")}`),
            artifact_version_id: stored.models, tool_name: "vx_eng", tool_version: tools.versions.vx_eng,
            details: { tag: models.tag, missing: models.missing, manufacturer: context.models } },
        ];
        if (drc.errors || drc.unconnected || drc.parity) {
          return { status: "failed", retryable: true, error: "the stored board does not pass DRC", validations };
        }
        const humanTests = input.acceptanceTests.filter((t) => t.method === "human_review").map((t) => t.id);
        const reviewReason = ctx.offline ? "Offline stand-in: the fixture layout is not derived from your requirements; review it"
          : ctx.run.mode !== "autonomous" && humanTests.length ? `Acceptance test(s) ${humanTests.join(", ")} need human review` : null;
        const summary = `${input.circuit.title}: ${board.width_mm} x ${board.height_mm} mm, ${board.copper_layers} layers, ` +
          `${routing.segments} track segments and ${routing.vias} vias, DRC ${drc.errors} errors / ${drc.warnings} warnings, ` +
          `parity clean, 3D models ${models.found}/${models.total}, after ${outcome.rounds} layout round(s)`;
        return { status: "passed", validations, summary, reviewReason };
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    },
  };
}
