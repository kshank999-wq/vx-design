/**
 * Simulation executor: calculation and circuit-simulation tasks. The model writes the analysis as named quantities,
 * checks and (when a circuit matters) an ngspice deck; every number is computed by the calculator and ngspice here.
 * A check that evaluates false fails the task with the computed numbers, so a person decides (change the design,
 * relax the requirement, or return it with notes) rather than the model bending its inputs.
 *
 * Steps (checkpointed): context -> analyse (model + calculator + ngspice, repaired until it computes) -> store
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSimulation, renderSimulationMarkdown, SIMULATION_PROMPT_VERSION, SimulationError, type SimulationInput, type SimulationResult } from "@vx/planning";
import type { Validation } from "../db.ts";
import { runSpice, type EngineeringTools } from "../engineering.ts";
import type { Executor, ExecutorContext, ExecutorResult } from "../execution.ts";

export function simulationExecutor(tools: EngineeringTools): Executor {
  return {
    id: "simulation",
    version: `${SIMULATION_PROMPT_VERSION}+vx_eng-${tools.versions.vx_eng}`,
    describe: "Analysis written by the model, every number computed by the calculator and ngspice",
    disciplines: ["simulation"],
    canRun: (task) => task.discipline === "simulation",

    async run(ctx: ExecutorContext): Promise<ExecutorResult> {
      const { task, db } = ctx;
      const work = await mkdtemp(join(tmpdir(), `vx-sim-${ctx.exec.id.slice(0, 8)}-`));
      try {
        const input = await ctx.step("context", async (): Promise<SimulationInput> => {
          const [project, reqs, upstream, notes] = await Promise.all([
            db.project(task.project_id), db.taskRequirements(task.id), db.upstreamOutputs(task.id), db.reviewNotes(task.id),
          ]);
          return {
            projectContext: `${project.name}${project.description ? `: ${project.description}` : ""}`,
            task: { key: task.key, title: task.title, description: task.description },
            requirements: reqs.map((r) => ({ refCode: r.ref_code, kind: r.kind, priority: r.priority, text: r.text })),
            acceptanceTests: task.acceptance_tests.map((a) => ({ id: a.id, description: a.description, method: a.method })),
            upstream: upstream.filter((u) => u.content).map((u) => ({ taskKey: u.taskKey, title: u.title, content: u.content! })),
            reviewNotes: notes,
            spiceAvailable: true,
          };
        });

        let result: SimulationResult & { files?: { deck: string; log: string } | null };
        try {
          result = await ctx.step("analyse", async () => {
            let lastFiles: { deck: string; log: string } | null = null;
            let n = 0;
            const r = await generateSimulation(input, ctx.model, async (deck) => {
              const dir = join(work, `spice-${++n}`);
              const s = await runSpice(tools, deck, dir);
              lastFiles = s.files ? { deck: await readFile(join(dir, s.files.deck), "utf8"), log: (await readFile(join(dir, s.files.log), "utf8")).slice(-20000) } : null;
              return s;
            }, async (round, problems, usage) => {
              await ctx.chargeModelUsage([usage], round === 1 ? "simulation" : "simulation_repair");
              await ctx.log(`analysis round ${round}: ${problems.length ? `${problems.length} problem(s)` : "computes"}`, { problems: problems.slice(0, 20) }, problems.length ? "warn" : "info");
            });
            return { ...r, files: r.spice ? lastFiles : null };
          });
        } catch (e) {
          if (e instanceof SimulationError) {
            return { status: "failed", retryable: true, error: e.message, validations: [{ kind: "simulation", result: "error", evidence_category: "deterministic_calculation",
              summary: "The analysis did not compute (expressions or the ngspice deck)", details: { problems: e.problems.slice(0, 40) } }] };
          }
          throw e;
        }

        const stored = await ctx.step("store", async () => {
          const config = { model: ctx.modelLabel, offline: ctx.offline, ngspice: result.spice?.ngspice ?? null };
          const md = await ctx.storeArtifact({ name: `${task.key}/analysis`, kind: "report", filename: "analysis.md",
            content: renderSimulationMarkdown(result), contentType: "text/markdown; charset=utf-8",
            toolName: "vx-calc", toolVersion: SIMULATION_PROMPT_VERSION, toolConfig: config, summary: result.output.summary });
          const data = await ctx.storeArtifact({ name: `${task.key}/analysis-data`, kind: "other", filename: "analysis.json",
            content: JSON.stringify({ output: result.output, values: result.values, checks: result.checks, spice: result.spice }, null, 2),
            contentType: "application/json", toolName: "vx-calc", toolVersion: SIMULATION_PROMPT_VERSION, toolConfig: config });
          const out: Record<string, string> = { analysis: md.versionId, data: data.versionId };
          if (result.files) {
            out.deck = (await ctx.storeArtifact({ name: `${task.key}/spice-deck`, kind: "simulation", filename: "deck.cir", content: result.files.deck,
              contentType: "text/plain; charset=utf-8", toolName: "ngspice", toolVersion: result.spice?.ngspice ?? "unknown", toolConfig: config })).versionId;
            out.log = (await ctx.storeArtifact({ name: `${task.key}/spice-log`, kind: "simulation", filename: "ngspice.log", content: result.files.log,
              contentType: "text/plain; charset=utf-8", toolName: "ngspice", toolVersion: result.spice?.ngspice ?? "unknown", toolConfig: config })).versionId;
          }
          return out;
        });

        const failed = result.checks.filter((c) => !c.passed);
        const fmt = (v: number) => Number(v.toPrecision(4));
        const validations: Validation[] = result.checks.map((c) => ({
          kind: "simulation", result: c.passed ? "pass" : "fail",
          evidence_category: result.spice && c.expression.includes("spice_") ? "simulation" : "deterministic_calculation",
          summary: `${c.id} ${c.passed ? "passes" : "FAILS"}: ${c.description} (${c.expression})${c.requirement_ref ? ` · ${c.requirement_ref}` : ""}`,
          details: { expression: c.expression, values: Object.fromEntries(Object.entries(result.values).map(([k, v]) => [k, fmt(v)])) },
          artifact_version_id: stored.analysis, tool_name: result.spice ? "ngspice" : "vx-calc",
          tool_version: result.spice?.ngspice ?? SIMULATION_PROMPT_VERSION,
        }));
        if (result.spice) validations.push({ kind: "simulation", result: "pass", evidence_category: "simulation",
          summary: `ngspice ${result.spice.ngspice}: ${Object.entries(result.spice.measures).map(([k, v]) => `${k} = ${fmt(v)}`).join(", ")}`,
          artifact_version_id: stored.log ?? stored.analysis, tool_name: "ngspice", tool_version: result.spice.ngspice ?? "unknown" });
        if (failed.length) {
          return { status: "failed", retryable: false, validations,
            error: `The analysis computes, and ${failed.length} check(s) fail: ${failed.map((c) => `${c.id} ${c.description}`).join("; ")}. ` +
                   "Change the design or the requirement, then continue the run to analyse again." };
        }
        const humanTests = input.acceptanceTests.filter((t) => t.method === "human_review").map((t) => t.id);
        return {
          status: "passed", validations,
          summary: `${result.output.title}: ${result.checks.length} check(s) pass` + (result.spice ? ", circuit simulated with ngspice" : "") + `, after ${result.rounds} round(s)`,
          reviewReason: ctx.offline ? "Offline stand-in: the fixture analysis is not derived from your requirements; review it"
            : ctx.run.mode !== "autonomous" && humanTests.length ? `Acceptance test(s) ${humanTests.join(", ")} need human review` : null,
        };
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    },
  };
}
