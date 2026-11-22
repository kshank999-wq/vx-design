/**
 * Verification executor, two kinds of verification task:
 *
 * - Before release (nothing upstream is a manufacturing task): a design review. Code gathers the checks every
 *   upstream task recorded (ERC, DRC, parity, fit, sourcing, power, simulation); any failed check fails the review.
 *   The model then reads each board's circuit against the requirements and lists findings. A person signs off on
 *   every review, whatever the run mode: the report is what they sign.
 * - After manufacturing (a fab package upstream): a hardware test. Software cannot pass it. Draft test procedures
 *   for the task's requirements are added to the Validation page (limits read from the requirement text), and the
 *   task waits until approved procedures have passing runs on built units for all of them.
 */
import { draftProcedures, renderReviewMarkdown, reviewDesign, CircuitDesign, REVIEW_PROMPT_VERSION, type DesignReview, type UpstreamCheck } from "@vx/planning";
import type { Validation } from "../db.ts";
import type { Executor, ExecutorContext, ExecutorResult } from "../execution.ts";

export const verificationExecutor: Executor = {
  id: "verification",
  version: REVIEW_PROMPT_VERSION,
  describe: "Design review of upstream checks and circuits with sign-off, or hardware test procedures after manufacturing",
  disciplines: ["verification"],
  canRun: (task) => task.discipline === "verification",

  async run(ctx: ExecutorContext): Promise<ExecutorResult> {
    const { task, db } = ctx;
    const ctxData = await ctx.step("context", async () => {
      const [up, reqs, project] = await Promise.all([db.allUpstream(task.id), db.taskRequirements(task.id), db.project(task.project_id)]);
      const vals = await db.latestValidations(up.map((u) => u.id));
      const keyOf = new Map(up.map((u) => [u.id, u]));
      const checks: UpstreamCheck[] = vals.map((v) => ({ taskKey: keyOf.get(v.task_id)?.key ?? "?", title: keyOf.get(v.task_id)?.title ?? "", kind: v.kind, result: v.result, summary: v.summary }));
      return { postFab: up.some((u) => u.discipline === "manufacturing"), checks, project: { name: project.name, description: project.description },
               reqs: reqs.map((r) => ({ refCode: r.ref_code, kind: r.kind, priority: r.priority, text: r.text, acceptance: r.acceptance_criteria ?? null })) };
    });

    if (ctxData.postFab) return hardwareTest(ctx, ctxData.reqs);

    // Design review before release.
    const failed = ctxData.checks.filter((c) => c.result === "fail" || c.result === "error");
    const review = await ctx.step("review", async (): Promise<DesignReview | null> => {
      const boards = [];
      for (const b of await db.upstreamBoards(task.id, "design", ["schematic"])) {
        const parsed = CircuitDesign.safeParse(JSON.parse(await db.downloadText(b.storagePath)));
        if (parsed.success) boards.push({ board: b.board ?? b.taskKey, taskKey: b.taskKey, design: parsed.data });
      }
      if (!boards.length && !ctxData.reqs.length) return null;
      const notes = (await db.upstreamOutputs(task.id)).filter((u) => u.content && /analysis|brief/.test(u.name)).map((u) => ({ taskKey: u.taskKey, title: u.title, content: u.content! }));
      const r = await reviewDesign({ projectContext: `${ctxData.project.name}${ctxData.project.description ? `: ${ctxData.project.description}` : ""}`,
        task: { key: task.key, title: task.title, description: task.description }, requirements: ctxData.reqs, boards, checks: ctxData.checks, notes }, ctx.model);
      await ctx.chargeModelUsage([r.usage], "design_review");
      return r.review;
    });

    const stored = await ctx.step("store", () => ctx.storeArtifact({
      name: `${task.key}/review`, kind: "report", filename: "review.md", contentType: "text/markdown; charset=utf-8",
      content: renderReviewMarkdown(task.title, ctxData.checks, review), toolName: "vx-review", toolVersion: REVIEW_PROMPT_VERSION,
      toolConfig: { model: ctx.modelLabel, offline: ctx.offline }, summary: review?.summary,
    }));
    const must = review?.findings.filter((f) => f.severity === "must_fix") ?? [];
    const should = review?.findings.filter((f) => f.severity === "should_fix") ?? [];
    const validations: Validation[] = [
      { kind: "acceptance_test", result: failed.length ? "fail" : ctxData.checks.some((c) => c.result === "warning") ? "warning" : "pass", evidence_category: "cad_check",
        summary: `Upstream tool checks: ${ctxData.checks.length} recorded, ${failed.length} failing` + (failed.length ? ` (${failed.slice(0, 5).map((c) => `${c.taskKey} ${c.kind}`).join(", ")})` : ""),
        artifact_version_id: stored.versionId, tool_name: "vx-review", tool_version: REVIEW_PROMPT_VERSION },
    ];
    if (review) validations.push({ kind: "other", result: must.length ? "fail" : should.length ? "warning" : "pass", evidence_category: "unverified_assumption",
      summary: `Design review: ${must.length} must-fix, ${should.length} should-fix, ${review.findings.length - must.length - should.length} note(s)`,
      details: { findings: review.findings }, artifact_version_id: stored.versionId, tool_name: "vx-review", tool_version: REVIEW_PROMPT_VERSION });
    if (failed.length) {
      return { status: "failed", retryable: false, validations,
        error: `${failed.length} upstream check(s) fail: ${failed.slice(0, 8).map((c) => `${c.taskKey}: ${c.summary}`).join("; ")}. Fix those tasks, then continue the run to review again.` };
    }
    return { status: "passed", validations,
      summary: `${task.title}: ${ctxData.checks.length} upstream checks pass` + (review ? `; review found ${must.length} must-fix and ${should.length} should-fix item(s)` : ""),
      // A review is a sign-off: a person accepts it in every run mode.
      reviewReason: `Engineering sign-off: read the review` + (must.length ? ` (${must.length} must-fix finding(s): return the affected tasks with notes, or accept them knowingly)` : "") };
  },
};

async function hardwareTest(ctx: ExecutorContext, reqs: { refCode: string; kind: string; text: string; acceptance: string | null }[]): Promise<ExecutorResult> {
  const { task, db } = ctx;
  const added = await ctx.step("procedures", async () => {
    const existing = await db.testProcedures(task.project_id);
    const covered = new Set(existing.flatMap((p) => p.requirement_refs));
    const drafts = draftProcedures(reqs.map((r) => ({ ref_code: r.refCode, kind: r.kind, text: r.text, acceptance_criteria: r.acceptance })), covered);
    const codes: string[] = [];
    for (const d of drafts) {
      codes.push(await db.addTestProcedure(task.project_id, { title: d.title, stage: d.stage, requirement_refs: d.requirement_refs,
        setup: `Drafted for plan task ${task.key} (${task.title}). ${task.description ?? ""}`.trim(), steps: d.steps, measurements: d.measurements }));
    }
    if (!reqs.length && !existing.some((p) => p.title.startsWith(task.title))) {
      codes.push(await db.addTestProcedure(task.project_id, { title: task.title.slice(0, 200), stage: "functional", requirement_refs: [],
        setup: `Drafted for plan task ${task.key}. ${task.description ?? ""}`.trim(), steps: "Write the steps for this check.",
        measurements: [{ key: "result_ok", label: `${task.title}: passes`, kind: "boolean", expected: "yes", requirement_ref: null, basis: "no requirement linked: a yes/no check" }] }));
    }
    return codes;
  });
  const status = await db.requirementVerification(task.project_id);
  const mine = reqs.length ? status.filter((s) => reqs.some((r) => r.refCode === s.ref_code)) : [];
  const verified = reqs.length > 0 && mine.length === reqs.length && mine.every((s) => s.status === "verified");
  if (verified) {
    return { status: "passed", summary: `${task.title}: every linked requirement has passing hardware test runs`, reviewReason: null,
      validations: mine.map((s) => ({ kind: "acceptance_test", result: "pass", evidence_category: "hardware_test",
        summary: `${s.ref_code}: verified on ${s.units_passed} unit(s) by ${s.procedures.join(", ")}`, tool_name: "vx-validation", tool_version: "s6" })) };
  }
  const open = mine.filter((s) => s.status !== "verified").map((s) => `${s.ref_code} (${s.status.replace(/_/g, " ")})`);
  return { status: "blocked", reason: `Hardware test: waiting for built units. ` +
    (added.length ? `Draft test procedure(s) ${added.join(", ")} were added to the Validation page; review and approve them, ` : "Approve the test procedures on the Validation page, ") +
    `record runs on built units, then continue the run (Continue on the run page) to check again.` + (open.length ? ` Not yet verified: ${open.slice(0, 10).join(", ")}.` : "") };
}
