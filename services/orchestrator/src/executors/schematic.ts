/**
 * Schematic executor (G3): requirements -> circuit design (model) -> KiCad library checks ->
 * native KiCad schematic -> ERC -> netlist check -> drawings, BOM and component evidence.
 *
 * Steps (checkpointed):
 *   context -> design (model + repair loop against library checks and ERC) -> evidence (datasheets)
 *   -> store (deterministic rebuild, upload)
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CIRCUIT_PROMPT_VERSION, CircuitDesign, CircuitDesignError, generateCircuit, type CircuitInput } from "@vx/planning";
import type { Validation } from "../db.ts";
import { checkDatasheet, type DatasheetEvidence } from "../datasheet.ts";
import { buildCircuit, toCircuitCheck, validateCircuit, type BuildResult, type EngineeringTools } from "../engineering.ts";
import type { Executor, ExecutorContext, ExecutorResult } from "../execution.ts";

export interface ComponentEvidence {
  ref: string;
  value: string;
  symbol: string;
  footprint: string;
  mpn: string | null;
  manufacturer: string | null;
  purpose: string;
  library: { symbol_found: boolean; footprint_found: boolean; pads_match: boolean | null; fp_filter_match: boolean | null;
             description: string | null; datasheet: string | null };
  datasheet: DatasheetEvidence | null;
  /** verified: datasheet read, part number and every claimed rating found in its text. */
  status: "verified" | "partial" | "unverified" | "generic";
}

export interface EvidenceReport {
  version: 1;
  method: string;
  components: ComponentEvidence[];
  counts: Record<ComponentEvidence["status"], number>;
}

const FILES: { key: keyof NonNullable<BuildResult["files"]>; suffix: string; kind: string; type: string }[] = [
  { key: "project_zip", suffix: "kicad-project", kind: "kicad_project", type: "application/zip" },
  { key: "svg", suffix: "schematic-svg", kind: "schematic", type: "image/svg+xml" },
  { key: "pdf", suffix: "schematic-pdf", kind: "schematic", type: "application/pdf" },
  { key: "erc_report", suffix: "erc-report", kind: "report", type: "application/json" },
  { key: "netlist", suffix: "netlist", kind: "netlist", type: "text/plain; charset=utf-8" },
  { key: "bom", suffix: "bom", kind: "bom", type: "text/csv; charset=utf-8" },
];

export function schematicExecutor(tools: EngineeringTools): Executor {
  const toolVersion = `vx_eng ${tools.versions.vx_eng} / KiCad ${tools.versions.kicad}`;
  return {
    id: "kicad-schematic",
    version: `${CIRCUIT_PROMPT_VERSION}+vx_eng-${tools.versions.vx_eng}`,
    describe: "Circuit designed by the model, generated as a native KiCad schematic, checked by KiCad ERC",
    disciplines: ["schematic"],
    canRun: (task) => task.discipline === "schematic",

    async run(ctx: ExecutorContext): Promise<ExecutorResult> {
      const { task, db } = ctx;
      const work = await mkdtemp(join(tmpdir(), `vx-sch-${ctx.exec.id.slice(0, 8)}-`));
      try {
        const input = await ctx.step("context", async (): Promise<CircuitInput> => {
          const [project, reqs, upstream, notes] = await Promise.all([
            db.project(task.project_id), db.taskRequirements(task.id), db.upstreamOutputs(task.id), db.reviewNotes(task.id),
          ]);
          // A board built over several tasks: start from the board's latest design and its power tree.
          let board: CircuitInput["board"] = null;
          if (task.board) {
            const prior = await db.boardJson(task.id, "design", ["schematic"], task.board);
            const parsed = prior ? CircuitDesign.safeParse(prior.value) : null;
            const power = await db.boardJson(task.id, "power-budget", ["power"], task.board);
            board = {
              name: task.board,
              base: prior && parsed?.success ? { taskKey: prior.taskKey, design: parsed.data } : null,
              power: power ? { taskKey: power.taskKey, summary: JSON.stringify(power.value).slice(0, 8000) } : null,
            };
          }
          return {
            board,
            projectContext: `${project.name}${project.description ? `: ${project.description}` : ""}`,
            task: { key: task.key, title: task.title, description: task.description },
            requirements: reqs.map((r) => ({ refCode: r.ref_code, kind: r.kind, priority: r.priority, text: r.text })),
            acceptanceTests: task.acceptance_tests.map((a) => ({ id: a.id, description: a.description, method: a.method })),
            upstream: upstream.filter((u) => u.content).map((u) => ({ taskKey: u.taskKey, title: u.title, content: u.content! })),
            reviewNotes: notes,
          };
        });

        let design: CircuitDesign;
        let rounds: number;
        let warnings: string[];
        try {
          ({ design, rounds, warnings } = await ctx.step("design", async () => {
            const r = await generateCircuit(input, ctx.model,
              (d) => buildCircuit(tools, d, join(work, `round-${Date.now()}`)).then(toCircuitCheck),
              async (round, check, usage) => {
                await ctx.chargeModelUsage([usage], round === 1 ? "circuit_design" : "circuit_design_repair");
                await ctx.log(`design round ${round}: ${check.ok ? "passes library checks, ERC and netlist" : `${check.problems.length} problem(s) at ${check.stage}`}`,
                              { round, stage: check.stage, problems: check.problems.slice(0, 20) }, check.ok ? "info" : "warn");
              });
            return { design: r.design, rounds: r.rounds, history: r.history, warnings: r.check.warnings };
          }));
        } catch (e) {
          if (e instanceof CircuitDesignError) {
            return { status: "failed", retryable: true, error: e.message, validations: [{
              kind: "erc", result: "fail", evidence_category: "cad_check", tool_name: "kicad", tool_version: tools.versions.kicad,
              summary: `Design still failed library checks or ERC after ${e.rounds} round(s)`, details: { problems: e.problems.slice(0, 50) } }] };
          }
          throw e;
        }

        const evidence = await ctx.step("evidence", async (): Promise<EvidenceReport> => {
          const lib = await validateCircuit(tools, design);
          const fetched = new Map<string, Promise<DatasheetEvidence>>();
          const components: ComponentEvidence[] = [];
          for (const c of design.components) {
            const facts = lib.components.find((f) => f.ref === c.ref);
            const libDatasheet = facts?.library_datasheet && /^https?:\/\//.test(facts.library_datasheet) ? facts.library_datasheet : null;
            const url = c.datasheet ?? (c.mpn ? libDatasheet : null);
            let ds: DatasheetEvidence | null = null;
            if (url) {
              const key = `${url}|${c.mpn}|${JSON.stringify(c.claims)}`;
              if (!fetched.has(key)) fetched.set(key, checkDatasheet(url, c.mpn, c.claims));
              ds = await fetched.get(key)!;
            }
            const generic = !c.mpn && !c.claims.length;
            const status: ComponentEvidence["status"] = generic ? "generic"
              : !ds || ds.status !== "checked" ? "unverified"
              : (ds.mpn.found === "exact" || ds.mpn.found === "base" || !c.mpn) && ds.claims.every((x) => x.found) ? "verified"
              : "partial";
            components.push({
              ref: c.ref, value: c.value, symbol: c.symbol, footprint: c.footprint, mpn: c.mpn, manufacturer: c.manufacturer,
              purpose: c.purpose,
              library: { symbol_found: !!facts?.symbol_found, footprint_found: !!facts?.footprint_found,
                         pads_match: facts?.pads_match ?? null, fp_filter_match: facts?.fp_filter_match ?? null,
                         description: facts?.library_description ?? null, datasheet: libDatasheet },
              datasheet: ds, status,
            });
          }
          const counts = { verified: 0, partial: 0, unverified: 0, generic: 0 };
          for (const c of components) counts[c.status] += 1;
          await ctx.log(`component evidence: ${counts.verified} verified, ${counts.partial} partial, ${counts.unverified} unverified, ${counts.generic} generic`);
          return { version: 1, method: "KiCad library lookup + datasheet text match", components, counts };
        });

        const stored = await ctx.step("store", async () => {
          const out = join(work, "final");
          const build = await buildCircuit(tools, design, out);
          if (!build.ok || !build.files) throw new Error(`rebuild of the accepted design failed at ${build.stage}`);
          const versions: Record<string, string> = {};
          const config = { model: ctx.modelLabel, offline: ctx.offline, sheet: build.sheet };
          for (const f of FILES) {
            const name = build.files[f.key];
            if (!name) continue;
            const s = await ctx.storeArtifact({
              name: `${task.key}/${f.suffix}`, kind: f.kind, filename: name, content: await readFile(join(out, name)),
              contentType: f.type, toolName: "kicad", toolVersion: toolVersion, toolConfig: config,
              summary: f.key === "project_zip" ? `${design.title}: editable KiCad 10 project` : undefined,
            });
            versions[f.key] = s.versionId;
          }
          for (const [suffix, body, kind] of [["component-evidence", evidence, "report"], ["design", design, "other"]] as const) {
            const s = await ctx.storeArtifact({
              name: `${task.key}/${suffix}`, kind, filename: `${suffix}.json`, content: JSON.stringify(body, null, 2),
              contentType: "application/json", toolName: "vx-design", toolVersion: CIRCUIT_PROMPT_VERSION, toolConfig: config,
            });
            versions[suffix] = s.versionId;
          }
          return { versions, erc: build.erc!, netlist: build.netlist!, sheet: build.sheet };
        });

        const libOk = evidence.components.every((c) => c.library.symbol_found && c.library.footprint_found && c.library.pads_match !== false);
        const claimed = evidence.components.filter((c) => c.status !== "generic");
        const allVerified = claimed.every((c) => c.status === "verified");
        const validations: Validation[] = [
          { kind: "erc", result: stored.erc.warnings ? "warning" : "pass", evidence_category: "cad_check",
            summary: `KiCad ERC: ${stored.erc.errors} errors, ${stored.erc.warnings} warnings`, artifact_version_id: stored.versions.erc_report,
            details: { violations: stored.erc.violations }, tool_name: "kicad", tool_version: tools.versions.kicad },
          { kind: "other", result: "pass", evidence_category: "cad_check",
            summary: `KiCad's netlist matches the design's ${stored.netlist.nets} nets exactly`,
            artifact_version_id: stored.versions.netlist, tool_name: "kicad", tool_version: tools.versions.kicad },
          { kind: "footprint_check", result: libOk ? (evidence.components.some((c) => c.library.fp_filter_match === false) ? "warning" : "pass") : "fail",
            evidence_category: "cad_check",
            summary: libOk ? "Every symbol and footprint exists in the KiCad 10 libraries and every pin has a pad"
                           : "Some symbols, footprints or pads do not match",
            artifact_version_id: stored.versions["component-evidence"], tool_name: "vx_eng", tool_version: tools.versions.vx_eng },
          { kind: "bom_check", result: allVerified ? "pass" : "warning",
            evidence_category: allVerified && claimed.length ? "datasheet_verified" : "unverified_assumption",
            summary: `Datasheet text check: ${evidence.counts.verified} verified, ${evidence.counts.partial} partial, ` +
                     `${evidence.counts.unverified} unverified (${evidence.counts.generic} generic passives)`,
            artifact_version_id: stored.versions["component-evidence"], details: { counts: evidence.counts } },
        ];
        if (!libOk) {
          return { status: "failed", retryable: true, error: "library check failed after the design passed ERC", validations };
        }
        const humanTests = input.acceptanceTests.filter((t) => t.method === "human_review").map((t) => t.id);
        const reviewReason = ctx.offline ? "Offline stand-in: the fixture circuit is not derived from your requirements; review it"
          : ctx.run.mode !== "autonomous" && humanTests.length ? `Acceptance test(s) ${humanTests.join(", ")} need human review` : null;
        const summary = `${design.title}: ${design.components.length} components, ${design.nets.length} nets, ` +
          `ERC ${stored.erc.errors} errors / ${stored.erc.warnings} warnings after ${rounds} design round(s)` +
          (warnings.length ? `; ${warnings.length} warning(s) noted` : "");
        return { status: "passed", validations, summary, reviewReason };
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    },
  };
}
