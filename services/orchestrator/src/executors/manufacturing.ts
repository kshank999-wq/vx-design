/**
 * Manufacturing tasks are of three kinds, told apart by what the task says it produces:
 * - fab outputs (Gerbers, drills, pick-and-place, panels): the fab-package executor (engineering worker);
 * - documents (bring-up checklists, factory test plans, fixtures, assembly instructions): a design brief;
 * - the RFQ package for manufacturers: every committed manufacturing output upstream (fab packages, BOMs, CPL,
 *   drawings, board and enclosure models, service and compliance documents) is gathered into a draft release, and a
 *   brief covers the quote request (quantities, what is included, what suppliers must confirm). A person checks the
 *   release's readiness, issues it, and sends RFQs from the RFQ page: nothing goes out from here.
 */
import type { TaskRow } from "../db.ts";
import type { Executor, ExecutorContext, ExecutorResult } from "../execution.ts";
import { briefExecutor } from "./brief.ts";

export type ManufacturingKind = "fab" | "document" | "rfq";

export function manufacturingKind(t: Pick<TaskRow, "title" | "key" | "description">): ManufacturingKind {
  const head = `${t.key} ${t.title}`;
  if (/\b(rfq|quotes?|quotations?|vendors?|suppliers?|contracts?|sourcing package|tender)\b/i.test(head)) return "rfq";
  if (/\b(gerbers?|fab(rication)?|odb\+*|pick[- ]and[- ]place|panel\w*|outputs?|cam)\b/i.test(head)) return "fab";
  if (/\b(test|checklist|bring[- ]up|fixtures?|procedures?|instructions?|plan|documentation|work instructions)\b/i.test(head)) return "document";
  return "fab";
}

export const manufacturingDocExecutor: Executor = {
  id: "manufacturing-document",
  version: briefExecutor.version,
  describe: "Manufacturing documents (test plans, checklists, fixtures) as design briefs",
  disciplines: ["manufacturing"],
  canRun: (task) => task.discipline === "manufacturing" && manufacturingKind(task) === "document",
  run: (ctx) => briefExecutor.run(ctx),
};

// Outputs worth sending to manufacturers, by artifact name suffix.
const FOR_RFQ = /\/(fab-package|gerbers|assembly-bom|cpl|fab-notes|assembly-top|assembly-bottom|drill-map|ipc2581|odb|ipc356-netlist|outline-dxf|board-step|sourced-bom|sourced-bom-csv|enclosure-step|enclosure-stl|print-pack|brief|review)$/;

export const rfqExecutor: Executor = {
  id: "rfq-package",
  version: `${briefExecutor.version}+rfq-1`,
  describe: "RFQ package: committed manufacturing outputs gathered into a draft release, with a quote-request brief",
  disciplines: ["manufacturing"],
  canRun: (task) => task.discipline === "manufacturing" && manufacturingKind(task) === "rfq",

  async run(ctx: ExecutorContext): Promise<ExecutorResult> {
    const { task, db } = ctx;
    const release = await ctx.step("release", async () => {
      const up = await db.allUpstream(task.id);
      const outs = (await db.committedOutputs(up.map((u) => u.id))).filter((o) => FOR_RFQ.test(o.name)
        && (!o.name.endsWith("/brief") || ["documentation", "manufacturing"].includes(up.find((u) => u.id === o.taskId)?.discipline ?? ""))
        && (!o.name.endsWith("/review") || up.find((u) => u.id === o.taskId)?.discipline === "verification"));
      const fab = outs.filter((o) => o.name.endsWith("/fab-package"));
      if (!fab.length) return null;
      const revision = `RFQ-${task.key}`.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 20);
      const rev = `${revision.slice(0, 15)}-${Date.now().toString(36).slice(-4)}`;
      const notes = `Prepared by plan task ${task.key} (${task.title}): ${fab.length} fab package(s) and ${outs.length - fab.length} supporting file(s). ` +
        "Check readiness, issue it, then send RFQs from the RFQ page.";
      const r = await db.draftRelease(task.project_id, rev, notes, outs.map((o) => o.versionId));
      return { ...r, revision: rev, files: outs.map((o) => o.name) };
    });
    if (!release) {
      return { status: "blocked", reason: "The RFQ package needs committed fab packages upstream (the fab outputs task, approved). Approve it, then continue the run." };
    }
    await ctx.log(`draft release ${release.revision} (#${release.releaseNo}) with ${release.files.length} file(s)`, { files: release.files });
    const brief = await briefExecutor.run(ctx);
    if (brief.status !== "passed") return brief;
    return {
      ...brief,
      validations: [...brief.validations, { kind: "other", result: "pass", evidence_category: "cad_check",
        summary: `Draft release ${release.revision} prepared with ${release.files.length} committed file(s): ${release.files.filter((f) => f.endsWith("/fab-package")).join(", ")} and supporting files`,
        details: { release_id: release.id, files: release.files } }],
      summary: `${brief.summary} Draft release ${release.revision} holds the manufacturer package (${release.files.length} files).`,
      reviewReason: `Read the quote request, then on Releases check readiness of ${release.revision} and issue it; send RFQs from the RFQ page`,
    };
  },
};
