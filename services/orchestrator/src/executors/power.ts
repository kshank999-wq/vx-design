/**
 * Power executor: the model proposes the power tree, the deterministic calculator (@vx/power) checks
 * it at the minimum, nominal and maximum source voltage, and calculator errors go back to the model.
 * The stored power budget holds the tree and the full calculation, so every number can be traced.
 *
 * Steps (checkpointed): context -> design (model + calculator repair loop) -> store
 */
import { CircuitDesign, POWER_PROMPT_VERSION, PowerTreeError, generatePowerTree, type PowerInput } from "@vx/planning";
import { POWER_CALC_VERSION, calculate, type PowerReport } from "@vx/power";
import type { Validation } from "../db.ts";
import type { Executor, ExecutorContext, ExecutorResult } from "../execution.ts";

export function powerSummary(r: PowerReport): string {
  const worst = [...r.converters].sort((a, b) => b.utilization - a.utilization)[0];
  const hottest = [...r.converters].filter((c) => c.tjMaxC !== null).sort((a, b) => b.tjMaxC! - a.tjMaxC!)[0];
  const run = r.runtime[0];
  const first = r.modes[0]?.id;
  return [
    `${r.sources.length} source(s), ${r.converters.length} converter(s), ${r.rails.length} rail(s), ${r.loads.length} load(s)`,
    worst ? `busiest converter ${worst.id} at ${Math.round(worst.utilization * 100)}% of rating` : null,
    hottest ? `hottest junction ${hottest.id} ${hottest.tjMaxC} C at ${r.ambientC.max} C ambient` : null,
    run && first ? `battery ${run.energyWh} Wh: ${run.perMode.find((m) => m.mode === first)?.hours ?? "-"} h ${first}` +
                   (run.days ? `, ${run.days} day(s) on the daily profile` : "") : null,
    `${r.counts.errors} error(s), ${r.counts.warnings} warning(s)`,
  ].filter(Boolean).join("; ");
}

export const powerExecutor: Executor = {
  id: "power-calculator",
  version: `${POWER_PROMPT_VERSION}+${POWER_CALC_VERSION}`,
  describe: "Power tree proposed by the model, checked by the deterministic power calculator",
  disciplines: ["power"],
  canRun: (task) => task.discipline === "power",

  async run(ctx: ExecutorContext): Promise<ExecutorResult> {
    const { task, db } = ctx;
    const input = await ctx.step("context", async (): Promise<PowerInput> => {
      const [project, reqs, upstream, notes, design] = await Promise.all([
        db.project(task.project_id), db.taskRequirements(task.id), db.upstreamOutputs(task.id), db.reviewNotes(task.id),
        db.upstreamJson(task.id, "design"),
      ]);
      const circuit = design ? CircuitDesign.safeParse(design.value) : null;
      return {
        projectContext: `${project.name}${project.description ? `: ${project.description}` : ""}`,
        task: { key: task.key, title: task.title, description: task.description },
        requirements: reqs.map((r) => ({ refCode: r.ref_code, kind: r.kind, priority: r.priority, text: r.text })),
        acceptanceTests: task.acceptance_tests.map((a) => ({ id: a.id, description: a.description, method: a.method })),
        upstream: upstream.filter((u) => u.content).map((u) => ({ taskKey: u.taskKey, title: u.title, content: u.content! })),
        reviewNotes: notes,
        circuit: circuit?.success ? circuit.data : null,
      };
    });

    let tree;
    let rounds: number;
    try {
      ({ tree, rounds } = await ctx.step("design", async () => {
        const r = await generatePowerTree(input, ctx.model, async (round, report, usage) => {
          await ctx.chargeModelUsage([usage], round === 1 ? "power_tree" : "power_tree_repair");
          await ctx.log(`power tree round ${round}: ${report.counts.errors} error(s), ${report.counts.warnings} warning(s)`,
                        { round, findings: report.findings.filter((f) => f.severity !== "info").slice(0, 20) },
                        report.ok ? "info" : "warn");
        });
        return { tree: r.tree, rounds: r.rounds, history: r.history };
      }));
    } catch (e) {
      if (e instanceof PowerTreeError) {
        return { status: "failed", retryable: true, error: e.message, validations: [{
          kind: "power_budget", result: "fail", evidence_category: "deterministic_calculation", tool_name: "vx-power",
          tool_version: POWER_CALC_VERSION, summary: `Power tree still failed the calculator after ${e.rounds} round(s)`,
          details: { problems: e.problems.slice(0, 30) } }] };
      }
      throw e;
    }

    // Recomputed from the stored tree (deterministic), so the report always matches the committed input.
    const report = calculate(tree);
    const stored = await ctx.step("store", async () => {
      const v = await ctx.storeArtifact({
        name: `${task.key}/power-budget`, kind: "power_budget", filename: "power-budget.json",
        content: JSON.stringify({ tree, report, rounds }, null, 2), contentType: "application/json",
        toolName: "vx-power", toolVersion: POWER_CALC_VERSION,
        toolConfig: { model: ctx.modelLabel, offline: ctx.offline, prompt: POWER_PROMPT_VERSION },
        summary: `${tree.title}: ${powerSummary(report)}`,
      });
      return v.versionId;
    });

    const assumptions = report.basis.assumption ?? 0;
    const total = Object.values(report.basis).reduce((a, b) => a + b, 0);
    const validations: Validation[] = [{
      kind: "power_budget", result: report.counts.warnings ? "warning" : "pass", evidence_category: "deterministic_calculation",
      summary: `Power calculator: ${powerSummary(report)}. Inputs: ${total - assumptions} of ${total} from datasheets, requirements or measurements; ` +
               `${assumptions} assumed`,
      artifact_version_id: stored, tool_name: "vx-power", tool_version: POWER_CALC_VERSION,
      details: { counts: report.counts, basis: report.basis, findings: report.findings.filter((f) => f.severity !== "info") },
    }];
    const reviewReason = ctx.offline ? "Offline stand-in: the fixture power tree is not derived from your requirements; review it"
      : report.counts.warnings ? `Power calculator warnings to review: ${report.findings.filter((f) => f.severity === "warning").slice(0, 4).map((f) => f.message).join("; ")}`
      : assumptions ? `${assumptions} power tree input(s) are assumptions; confirm them against datasheets`
      : null;
    return { status: "passed", validations, reviewReason, summary: `${tree.title}: ${powerSummary(report)}` };
  },
};
