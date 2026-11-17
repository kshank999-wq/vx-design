/**
 * Design-brief executor: drafts the written engineering record for a task with Claude,
 * checks it answers every requirement and acceptance test, and stores it as Markdown.
 *
 * Steps (each checkpointed, so a resumed attempt skips finished ones):
 *   context -> draft (model call, charged to the run) -> render -> store
 */
import { BRIEF_PROMPT_VERSION, BriefValidationError, generateBrief, renderBriefMarkdown,
         type BriefInput, type DesignBrief } from "@vx/planning";
import type { Executor, ExecutorContext, ExecutorResult } from "../execution.ts";
import type { Validation } from "../db.ts";

// Power and enclosure tasks have their own executors (power calculator; enclosure generator with fit checks).
const DISCIPLINES = new Set(["architecture", "components", "thermal", "mechanical", "documentation"]);
const ARTIFACT_KIND: Record<string, string> = {};

export const briefExecutor: Executor = {
  id: "design-brief",
  version: BRIEF_PROMPT_VERSION,
  describe: "Design brief drafted by the model and checked against the task's requirements and acceptance tests",
  disciplines: [...DISCIPLINES],
  canRun: (task) => DISCIPLINES.has(task.discipline),

  async run(ctx: ExecutorContext): Promise<ExecutorResult> {
    const { task, db } = ctx;

    const input = await ctx.step("context", async (): Promise<BriefInput> => {
      const [project, reqs, upstream, notes] = await Promise.all([
        db.project(task.project_id), db.taskRequirements(task.id), db.upstreamOutputs(task.id), db.reviewNotes(task.id),
      ]);
      return {
        projectContext: `${project.name}${project.description ? `: ${project.description}` : ""}`,
        task: { key: task.key, title: task.title, discipline: task.discipline, description: task.description },
        requirements: reqs.map((r) => ({ refCode: r.ref_code, kind: r.kind, priority: r.priority, text: r.text })),
        acceptanceTests: task.acceptance_tests.map((a) => ({ id: a.id, description: a.description, method: a.method })),
        upstream: upstream.filter((u) => u.content).map((u) => ({ taskKey: u.taskKey, title: u.title, content: u.content! })),
        reviewNotes: notes,
      };
    });

    let brief: DesignBrief;
    try {
      ({ brief } = await ctx.step("draft", async () => {
        try {
          const r = await generateBrief(input, ctx.model);
          await ctx.chargeModelUsage(r.usage, "design_brief");
          return { brief: r.brief, attempts: r.attempts };
        } catch (e) {
          if (e instanceof BriefValidationError) await ctx.log(`brief failed validation: ${e.message}`, {}, "warn");
          throw e;
        }
      }));
    } catch (e) {
      if (e instanceof BriefValidationError) {
        return { status: "failed", retryable: true, error: e.message, validations: [{
          kind: "acceptance_test", result: "fail", evidence_category: "unverified_assumption",
          summary: "Brief did not answer every requirement and acceptance test", details: { problems: e.problems } }] };
      }
      throw e;
    }

    const markdown = await ctx.step("render", async () =>
      renderBriefMarkdown(brief, input, { generator: ctx.modelLabel, offline: ctx.offline }));

    const stored = await ctx.step("store", () => ctx.storeArtifact({
      name: `${task.key}/brief`, kind: ARTIFACT_KIND[task.discipline] ?? "report", filename: "brief.md",
      content: markdown, contentType: "text/markdown; charset=utf-8",
      toolName: "vx-design-brief", toolVersion: BRIEF_PROMPT_VERSION,
      toolConfig: { model: ctx.modelLabel, offline: ctx.offline }, summary: brief.summary,
    }));

    const open = brief.requirement_responses.filter((r) => r.status !== "addressed");
    const needsReview = brief.acceptance_responses.filter((a) => a.claim !== "met").map((a) => a.test_id);
    const humanTests = input.acceptanceTests.filter((t) => t.method === "human_review").map((t) => t.id);
    const notMet = brief.acceptance_responses.filter((a) => a.claim === "not_met").map((a) => a.test_id);

    const validations: Validation[] = [{
      kind: "acceptance_test",
      result: open.length || notMet.length ? "warning" : "pass",
      evidence_category: "unverified_assumption",
      summary: `Brief answers ${brief.requirement_responses.length} requirement(s) and ${brief.acceptance_responses.length} acceptance test(s)` +
        (open.length ? `; ${open.length} requirement(s) still open or partial` : "") +
        (notMet.length ? `; model reports ${notMet.join(", ")} not met` : ""),
      details: { open: open.map((r) => r.ref), needs_review: needsReview, offline: ctx.offline },
      artifact_version_id: stored.versionId,
      tool_name: "vx-design-brief",
      tool_version: BRIEF_PROMPT_VERSION,
    }];

    // A brief is reasoning, not verification: tests that need a person's judgement gate the
    // task unless the run is Autonomous, where the report lists them for review instead.
    const reviewIds = [...new Set([...humanTests, ...needsReview])];
    const reviewReason = ctx.run.mode !== "autonomous" && (reviewIds.length || ctx.offline)
      ? (ctx.offline ? "Offline stand-in output: a person must review it"
                     : `Acceptance test(s) ${reviewIds.join(", ")} need human review`)
      : null;

    return { status: "passed", validations, summary: brief.summary, reviewReason };
  },
};
