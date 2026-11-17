/**
 * Enclosure executor (M-ENC): committed routed board -> board 3D facts -> enclosure design (model) ->
 * housing built around the board's outline and 3D models -> fit (every part against base and lid),
 * connector access and process checks -> STEP, STL, exploded GLB, drawings and fit report.
 *
 * Steps (checkpointed): context (upstream board, 3D facts) -> design (model + repair loop; the passing
 * build is stashed) -> store.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CircuitDesign, ENCLOSURE_PROMPT_VERSION, EnclosureDesignError, generateEnclosure, type EnclosureDesign, type EnclosureInput } from "@vx/planning";
import type { Validation } from "../db.ts";
import { buildEnclosure, enclosureFacts, toEnclosureCheck, type EngineeringTools, type EnclosureResult } from "../engineering.ts";
import type { Executor, ExecutorContext, ExecutorResult } from "../execution.ts";

type FileKey = keyof NonNullable<EnclosureResult["files"]>;
const FILES: { key: FileKey; suffix: string; kind: string; type: string }[] = [
  { key: "exploded_glb", suffix: "enclosure-3d", kind: "enclosure", type: "model/gltf-binary" },
  { key: "base_step", suffix: "base-step", kind: "step", type: "model/step" },
  { key: "lid_step", suffix: "lid-step", kind: "step", type: "model/step" },
  { key: "base_stl", suffix: "base-stl", kind: "stl", type: "model/stl" },
  { key: "lid_stl", suffix: "lid-stl", kind: "stl", type: "model/stl" },
  { key: "assembly_step", suffix: "assembly-step", kind: "step", type: "model/step" },
  { key: "base_top_svg", suffix: "base-top-svg", kind: "enclosure", type: "image/svg+xml" },
  { key: "base_front_svg", suffix: "base-front-svg", kind: "enclosure", type: "image/svg+xml" },
  { key: "lid_top_svg", suffix: "lid-top-svg", kind: "enclosure", type: "image/svg+xml" },
  { key: "lid_front_svg", suffix: "lid-front-svg", kind: "enclosure", type: "image/svg+xml" },
  { key: "report", suffix: "fit-report", kind: "report", type: "application/json" },
];
const FIT = new Set(["interference", "tight", "opening", "connector_recessed", "no_model", "boolean_failed"]);

interface Stashed { path: string; name: string; sha256: string }

export function enclosureExecutor(tools: EngineeringTools): Executor {
  return {
    id: "enclosure",
    version: `${ENCLOSURE_PROMPT_VERSION}+vx_eng-${tools.versions.vx_eng}`,
    describe: "Housing designed by the model, built around the board's 3D models, checked for fit and process rules",
    disciplines: ["enclosure"],
    canRun: (task) => task.discipline === "enclosure",

    async run(ctx: ExecutorContext): Promise<ExecutorResult> {
      const { task, db } = ctx;
      const work = await mkdtemp(join(tmpdir(), `vx-enc-${ctx.exec.id.slice(0, 8)}-`));
      try {
        const board = await ctx.step("context", async () => {
          const v = await db.upstreamVersion(task.id, "kicad-project", ["pcb_layout"]);
          if (!v) return null;
          const zip = join(work, "project.zip");
          await writeFile(zip, await db.downloadBytes(v.storagePath));
          const facts = await enclosureFacts(tools, zip);
          if (!facts.ok) throw new Error(`board facts: ${facts.error}`);
          const [project, reqs, upstream, notes, design] = await Promise.all([
            db.project(task.project_id), db.taskRequirements(task.id), db.upstreamOutputs(task.id), db.reviewNotes(task.id),
            db.upstreamJson(task.id, "design"),
          ]);
          const circuit = design ? CircuitDesign.safeParse(design.value) : null;
          const input: EnclosureInput = {
            projectContext: `${project.name}${project.description ? `: ${project.description}` : ""}`,
            task: { key: task.key, title: task.title, description: task.description },
            requirements: reqs.map((r) => ({ refCode: r.ref_code, kind: r.kind, priority: r.priority, text: r.text })),
            acceptanceTests: task.acceptance_tests.map((a) => ({ id: a.id, description: a.description, method: a.method })),
            upstream: upstream.filter((u) => u.content).map((u) => ({ taskKey: u.taskKey, title: u.title, content: u.content! })),
            reviewNotes: notes, facts,
            components: circuit?.success ? circuit.data.components.map((c) => ({ ref: c.ref, value: c.value, purpose: c.purpose })) : [],
          };
          return { input, source: { taskKey: v.taskKey, versionId: v.versionId, storagePath: v.storagePath, offline: !!v.toolConfig?.offline } };
        });
        if (!board) {
          return { status: "blocked", reason: "The enclosure needs a committed routed board from an upstream PCB layout task " +
                                              "('<layout task>/kicad-project'). Run and approve the layout first." };
        }

        let outcome: { design: EnclosureDesign; rounds: number; result: Omit<EnclosureResult, "files">; stash: Partial<Record<FileKey, Stashed>>;
                       history: { round: number; stage: string; problems: number }[] };
        try {
          outcome = await ctx.step("design", async () => {
            const zip = join(work, "project.zip");
            await writeFile(zip, await db.downloadBytes(board.source.storagePath));
            const builds = new Map<number, { dir: string; result: EnclosureResult }>();
            const r = await generateEnclosure(board.input, ctx.model, async (design, round) => {
              const dir = join(work, `round-${round}`);
              const result = await buildEnclosure(tools, zip, design, dir);
              builds.set(round, { dir, result });
              return toEnclosureCheck(result);
            }, async (round, check, usage) => {
              await ctx.chargeModelUsage([usage], round === 1 ? "enclosure_design" : "enclosure_design_repair");
              await ctx.log(`enclosure round ${round}: ${check.ok ? "fits; process rules met" : `${check.problems.length} problem(s) at ${check.stage}`}`,
                            { round, problems: check.problems.slice(0, 20), warnings: check.warnings.slice(0, 20) }, check.ok ? "info" : "warn");
            });
            const { dir, result } = builds.get(r.rounds)!;
            const stash: Partial<Record<FileKey, Stashed>> = {};
            for (const f of FILES) {
              const name = result.files?.[f.key];
              if (!name) continue;
              const bytes = await readFile(join(dir, name));
              const sha256 = createHash("sha256").update(bytes).digest("hex");
              const path = `${task.project_id}/stash/${ctx.exec.id}/${sha256.slice(0, 16)}-${name}`;
              await db.upload(path, bytes, f.type);
              stash[f.key] = { path, name, sha256 };
            }
            const { files: _f, ...summary } = result;
            return { design: r.design, rounds: r.rounds, result: summary, stash, history: r.history };
          });
        } catch (e) {
          if (e instanceof EnclosureDesignError) {
            return { status: "failed", retryable: true, error: e.message, validations: [{
              kind: "fit_check", result: "fail", evidence_category: "cad_check", tool_name: "vx_eng", tool_version: tools.versions.vx_eng,
              summary: `Enclosure still did not fit after ${e.rounds} round(s)`, details: { problems: e.problems.slice(0, 30) } }] };
          }
          throw e;
        }

        const stored = await ctx.step("store", async () => {
          const versions: Record<string, string> = {};
          const config = { model: ctx.modelLabel, offline: ctx.offline, process: outcome.design.process, source_board: board.source.versionId };
          for (const f of FILES) {
            const s = outcome.stash[f.key];
            if (!s) continue;
            const bytes = await db.downloadBytes(s.path);
            if (createHash("sha256").update(bytes).digest("hex") !== s.sha256) throw new Error(`stashed ${s.name} changed in storage`);
            const v = await ctx.storeArtifact({ name: `${task.key}/${f.suffix}`, kind: f.kind, filename: s.name, content: bytes, contentType: f.type,
              toolName: "vx_eng", toolVersion: `vx_eng ${tools.versions.vx_eng} / CadQuery`, toolConfig: config,
              summary: f.key === "exploded_glb" ? `${outcome.result.process?.label} housing, ${outcome.result.dimensions_mm?.x} x ` +
                `${outcome.result.dimensions_mm?.y} x ${outcome.result.dimensions_mm?.z} mm` : undefined });
            versions[f.key] = v.versionId;
          }
          const d = await ctx.storeArtifact({ name: `${task.key}/enclosure-design`, kind: "other", filename: "enclosure-design.json",
            content: JSON.stringify({ ...outcome.design, history: outcome.history, source_board: board.source }, null, 2),
            contentType: "application/json", toolName: "vx-design", toolVersion: ENCLOSURE_PROMPT_VERSION, toolConfig: config });
          versions.design = d.versionId;
          return versions;
        });

        const r = outcome.result;
        const warnings = r.warnings ?? [];
        const fitWarn = warnings.filter((w) => FIT.has(w.code));
        const dims = r.dimensions_mm!;
        const validations: Validation[] = [
          { kind: "fit_check", result: fitWarn.length ? "warning" : "pass", evidence_category: "cad_check",
            summary: `Fit: no part or the board touches the housing (${r.board?.parts_checked.length} of ${r.board?.parts} parts checked against their 3D models` +
                     `${r.missing_models?.length ? `; no model for ${r.missing_models.join(", ")}` : ""})` +
                     (fitWarn.length ? `; ${fitWarn.map((w) => w.message).join("; ")}` : ""),
            artifact_version_id: stored.report, tool_name: "vx_eng", tool_version: tools.versions.vx_eng,
            details: { clearance_mm: r.clearance_mm, openings: r.openings, levels_mm: r.levels_mm } },
          { kind: "dfm", result: warnings.some((w) => !FIT.has(w.code)) ? "warning" : "pass", evidence_category: "cad_check",
            summary: `${r.process?.label}, ${r.material}: ${dims.x} x ${dims.y} x ${dims.z} mm, wall ${outcome.design.wall_mm} mm, ` +
                     `${Object.keys(r.mounting ?? {}).length} standoff(s) with ${outcome.design.fastening.replace(/_/g, " ")}s; ` +
                     `about ${r.mass_g?.base} g + ${r.mass_g?.lid} g`,
            artifact_version_id: stored.base_step, tool_name: "vx_eng", tool_version: tools.versions.vx_eng },
        ];
        const offline = ctx.offline || board.source.offline;
        return {
          status: "passed", validations,
          summary: `${r.process?.label} housing ${dims.x} x ${dims.y} x ${dims.z} mm around ${board.source.taskKey}'s board after ${outcome.rounds} round(s)`,
          reviewReason: offline ? "Offline stand-in: the fixture enclosure is not derived from your requirements; review it"
            : "Check the housing before printing or machining: openings, clearances and fastener choice",
        };
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    },
  };
}
