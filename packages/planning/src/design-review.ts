/**
 * Design review for verification tasks before release (schematic review, engineering sign-off). The tool checks are
 * gathered by code (every upstream task's ERC, DRC, parity, fit, sourcing, power and simulation results); the model
 * then reads each board's circuit against the requirements, as a second engineer would, and lists findings. The
 * findings never pass or fail anything by themselves: they go to the person who signs off.
 */
import { z } from "zod";
import type { LanguageModel, Usage } from "./llm/model.ts";
import type { BriefRequirement } from "./brief.ts";
import type { CircuitDesign } from "./circuit.ts";

export const REVIEW_PROMPT_VERSION = "design-review-v1";

export const DesignReview = z.object({
  summary: z.string().describe("Overall verdict for the person signing off, 2-4 sentences."),
  findings: z.array(z.object({
    severity: z.enum(["must_fix", "should_fix", "note"]),
    board: z.string().nullable(),
    refs: z.array(z.string()).describe("Component refs or net names involved"),
    issue: z.string(),
    recommendation: z.string(),
    requirement_ref: z.string().nullable(),
  })),
  requirement_coverage: z.array(z.object({
    ref: z.string(),
    status: z.enum(["met_by_design", "partly", "not_addressed", "needs_test"]),
    evidence: z.string().describe("Where in the design or checks this is shown"),
  })),
});
export type DesignReview = z.infer<typeof DesignReview>;

export interface UpstreamCheck { taskKey: string; title: string; kind: string; result: string; summary: string }
export interface ReviewInput {
  projectContext: string;
  task: { key: string; title: string; description: string | null };
  requirements: BriefRequirement[];
  boards: { board: string; taskKey: string; design: CircuitDesign }[];
  checks: UpstreamCheck[];
  notes: { taskKey: string; title: string; content: string }[];
}

const SYSTEM = `You are the senior electronics engineer reviewing a product's design before it is released to manufacturing. Tool results (ERC, DRC, parity, fit, sourcing, simulation) are given; do not repeat them, use them. Read each board's circuit as data (components with symbols, footprints, values, part numbers; nets with pins) and look for what tools do not catch: wrong or missing connections between parts and boards, missing pull-ups or terminations, decoupling, protection on external connectors (ESD, reverse polarity, overvoltage), regulator stability and ratings against the power tree, interface voltage mismatches, timing-critical signals, parts used outside their ratings, and requirements the design does not meet.

must_fix: the product will not work, is unsafe, or misses a must requirement. should_fix: a real risk or a likely field problem. note: improvements. Be specific: name refs and nets. Do not invent problems to fill the list; an empty list is fine for a sound design. For each linked requirement, say whether the design meets it, partly, not at all, or whether it can only be shown by a hardware test.`;

export function renderReviewPrompt(input: ReviewInput): string {
  const reqs = input.requirements.map((r) => `- ${r.refCode} [${r.kind}, ${r.priority}] ${r.text}`).join("\n") || "- (none linked)";
  const checks = input.checks.map((c) => `- ${c.taskKey} · ${c.kind} · ${c.result.toUpperCase()}: ${c.summary}`).join("\n") || "- (no tool checks upstream)";
  const boards = input.boards.map((b) => `### Board "${b.board}" (from ${b.taskKey})\n${JSON.stringify({ components: b.design.components.map(({ claims: _c, datasheet: _d, ...c }) => c), nets: b.design.nets, no_connect: b.design.no_connect })}`).join("\n\n") || "(no circuit designs upstream)";
  const notes = input.notes.map((n) => `### ${n.title} (${n.taskKey})\n${n.content.slice(0, 6000)}`).join("\n\n");
  return `Project: ${input.projectContext}\n\nReview task: ${input.task.title} (${input.task.key})\n${input.task.description ?? ""}\n\n` +
    `Requirements to check:\n${reqs}\n\nTool checks of the upstream work:\n${checks}\n\nCircuits:\n${boards}` +
    (notes ? `\n\nAnalyses and decisions upstream:\n${notes}` : "") + "\n\nReview the design.";
}

export async function reviewDesign(input: ReviewInput, model: LanguageModel): Promise<{ review: DesignReview; usage: Usage }> {
  const r = await model.generate({ purpose: "design_review", system: SYSTEM, messages: [{ role: "user", content: renderReviewPrompt(input) }], schema: DesignReview });
  return { review: r.output, usage: r.usage };
}

export function renderReviewMarkdown(title: string, checks: UpstreamCheck[], review: DesignReview | null, extra: string[] = []): string {
  const failed = checks.filter((c) => c.result === "fail" || c.result === "error");
  const warn = checks.filter((c) => c.result === "warning");
  const sev = { must_fix: "Must fix", should_fix: "Should fix", note: "Note" } as const;
  return [
    `# ${title}`, "",
    ...(review ? [review.summary, ""] : []),
    "## Tool checks of the upstream work", "",
    `${checks.length} check(s): ${checks.length - failed.length - warn.length} pass, ${warn.length} warning(s), ${failed.length} fail.`, "",
    ...[...failed, ...warn].map((c) => `- **${c.result.toUpperCase()}** ${c.taskKey} (${c.kind}): ${c.summary}`), "",
    ...(review ? [
      "## Findings (design review)", "",
      ...(review.findings.length ? review.findings.map((f) => `- **${sev[f.severity]}**${f.board ? ` · ${f.board}` : ""}${f.refs.length ? ` · ${f.refs.join(", ")}` : ""}: ${f.issue} → ${f.recommendation}${f.requirement_ref ? ` (${f.requirement_ref})` : ""}`) : ["- None."]), "",
      "## Requirements", "", ...review.requirement_coverage.map((c) => `- ${c.ref}: ${c.status.replace(/_/g, " ")} — ${c.evidence}`), "",
    ] : []),
    ...extra,
  ].join("\n");
}

export const OFFLINE_REVIEW: DesignReview = {
  summary: "Offline stand-in: no design review was reasoned about; the tool checks above are real.",
  findings: [], requirement_coverage: [],
};
