/**
 * Design briefs: the written engineering record for tasks that do not (yet) have a CAD or
 * calculation tool behind them — architecture choices, power and mechanical envelopes,
 * documentation. The model drafts; deterministic checks decide whether the brief answers
 * every requirement and acceptance test the task was given.
 *
 * A brief is evidence of category "unverified_assumption": it records reasoning for a
 * person to review. It is never presented as a verified calculation or check.
 */
import { z } from "zod";
import { DecisionClass } from "@vx/contracts";
import type { LanguageModel, Usage } from "./llm/model.ts";

export const BRIEF_PROMPT_VERSION = "brief-v1";
const MAX_REPAIR_ROUNDS = 1;

export interface BriefRequirement {
  refCode: string;
  kind: string;
  priority: string;
  text: string;
}

export interface BriefAcceptanceTest {
  id: string;
  description: string;
  method: string;
}

export interface BriefUpstream {
  taskKey: string;
  title: string;
  /** Markdown of the upstream task's committed brief or report. */
  content: string;
}

export interface BriefInput {
  projectContext: string;
  task: { key: string; title: string; discipline: string; description: string | null };
  requirements: BriefRequirement[];
  acceptanceTests: BriefAcceptanceTest[];
  upstream: BriefUpstream[];
  /** Notes from reviewers who returned an earlier attempt. */
  reviewNotes: string[];
}

export const DesignBrief = z.object({
  summary: z.string().describe("Two or three sentences: what was decided or established."),
  approach: z.string().describe("The engineering reasoning, in Markdown paragraphs."),
  requirement_responses: z.array(z.object({
    ref: z.string(),
    status: z.enum(["addressed", "partially_addressed", "open"]),
    response: z.string(),
    open_question: z.string().nullable(),
  })),
  acceptance_responses: z.array(z.object({
    test_id: z.string(),
    claim: z.enum(["met", "not_met", "needs_review"]),
    explanation: z.string(),
  })),
  proposed_decisions: z.array(z.object({
    decision_class: DecisionClass,
    title: z.string(),
    statement: z.string(),
    rationale: z.string(),
    alternatives: z.array(z.string()),
  })),
  risks: z.array(z.object({ risk: z.string(), mitigation: z.string() })),
  assumptions: z.array(z.string()),
  open_questions: z.array(z.string()),
});
export type DesignBrief = z.infer<typeof DesignBrief>;

const SYSTEM = `You are a senior hardware engineer writing the design brief for one task of a product development plan.

Work only from the requirements, the upstream briefs and the task description you are given. Where a fact needs a datasheet, measurement or calculation you do not have, say so: mark the requirement "partially_addressed" or "open" and ask the specific question. Do not invent part numbers' ratings, prices or test results.

Answer every listed requirement in requirement_responses and every listed acceptance test in acceptance_responses, using their exact ids. Claim an acceptance test "met" only if the brief itself demonstrates it; use "needs_review" when a person must judge it.

List the engineering decisions this brief proposes (component family, power architecture, board size, connector assignments, ...) in proposed_decisions; they are recorded only after a person approves them.`;

export interface BriefProblem {
  code: "unknown_requirement" | "missing_requirement" | "unknown_test" | "missing_test" | "empty";
  message: string;
}

export function validateBrief(brief: DesignBrief, input: BriefInput): BriefProblem[] {
  const problems: BriefProblem[] = [];
  const refs = new Set(input.requirements.map((r) => r.refCode));
  const tests = new Set(input.acceptanceTests.map((t) => t.id));
  const answeredRefs = new Set(brief.requirement_responses.map((r) => r.ref));
  const answeredTests = new Set(brief.acceptance_responses.map((t) => t.test_id));
  if (!brief.summary.trim() || !brief.approach.trim()) {
    problems.push({ code: "empty", message: "summary and approach must not be empty" });
  }
  for (const r of answeredRefs) if (!refs.has(r)) problems.push({ code: "unknown_requirement", message: `${r} is not one of this task's requirements` });
  for (const r of refs) if (!answeredRefs.has(r)) problems.push({ code: "missing_requirement", message: `no response for ${r}` });
  for (const t of answeredTests) if (!tests.has(t)) problems.push({ code: "unknown_test", message: `${t} is not one of this task's acceptance tests` });
  for (const t of tests) if (!answeredTests.has(t)) problems.push({ code: "missing_test", message: `no response for acceptance test ${t}` });
  return problems;
}

export interface BriefResult {
  promptVersion: string;
  brief: DesignBrief;
  attempts: number;
  usage: Usage[];
}

export class BriefValidationError extends Error {
  readonly problems: BriefProblem[];
  constructor(problems: BriefProblem[]) {
    super(`brief failed validation: ${problems.map((p) => p.message).join("; ")}`);
    this.problems = problems;
  }
}

export function renderBriefPrompt(input: BriefInput): string {
  const reqs = input.requirements.map((r) => `- ${r.refCode} [${r.kind}, ${r.priority}] ${r.text}`).join("\n") || "- (none linked)";
  const tests = input.acceptanceTests.map((t) => `- ${t.id} (${t.method}): ${t.description}`).join("\n") || "- (none)";
  const upstream = input.upstream.map((u) => `### ${u.title} (${u.taskKey})\n${u.content}`).join("\n\n") || "(no upstream outputs)";
  const notes = input.reviewNotes.length ? `\n\nA reviewer returned the previous attempt with these notes; address them:\n${input.reviewNotes.map((n) => `- ${n}`).join("\n")}` : "";
  return `Project: ${input.projectContext}\n\n` +
    `Task: ${input.task.title} (${input.task.key}, discipline ${input.task.discipline})\n${input.task.description ?? ""}\n\n` +
    `Requirements:\n${reqs}\n\nAcceptance tests:\n${tests}\n\nUpstream outputs:\n${upstream}${notes}\n\nWrite the design brief.`;
}

export async function generateBrief(input: BriefInput, model: LanguageModel): Promise<BriefResult> {
  const usage: Usage[] = [];
  const messages: Parameters<LanguageModel["generate"]>[0]["messages"] = [{ role: "user", content: renderBriefPrompt(input) }];
  for (let attempt = 1; ; attempt++) {
    const result = await model.generate({
      purpose: attempt === 1 ? "design_brief" : "design_brief_repair", system: SYSTEM, messages, schema: DesignBrief,
    });
    usage.push(result.usage);
    const problems = validateBrief(result.output, input);
    if (!problems.length) return { promptVersion: BRIEF_PROMPT_VERSION, brief: result.output, attempts: attempt, usage };
    if (attempt > MAX_REPAIR_ROUNDS) throw new BriefValidationError(problems);
    messages.push(result.assistantMessage, {
      role: "user",
      content: "The brief failed validation:\n" + problems.map((p) => `- ${p.message}`).join("\n") + "\n\nReturn the complete corrected brief.",
    });
  }
}

const CLAIM_LABEL = { met: "Met", not_met: "Not met", needs_review: "Needs review" } as const;
const STATUS_LABEL = { addressed: "Addressed", partially_addressed: "Partly addressed", open: "Open" } as const;

/** Markdown document stored as the task's output artifact. */
export function renderBriefMarkdown(brief: DesignBrief, input: BriefInput, meta: { generator: string; offline: boolean }): string {
  const req = new Map(input.requirements.map((r) => [r.refCode, r]));
  const test = new Map(input.acceptanceTests.map((t) => [t.id, t]));
  const lines = [
    `# ${input.task.title}`,
    "",
    `Design brief for task \`${input.task.key}\` (${input.task.discipline}). Generated by ${meta.generator}.`,
    meta.offline
      ? "\n> **Offline stand-in.** This brief was produced by the offline heuristic, not by AI or an engineer. It contains no engineering analysis."
      : "\n> Evidence category: unverified AI reasoning. Review before relying on it; it is not an electrical or mechanical validation.",
    "",
    "## Summary",
    brief.summary,
    "",
    "## Approach",
    brief.approach,
    "",
    "## Requirements",
    "| Ref | Status | Response |",
    "| --- | --- | --- |",
    ...brief.requirement_responses.map((r) =>
      `| ${r.ref} | ${STATUS_LABEL[r.status]} | ${cell(r.response)}${r.open_question ? `<br>**Open:** ${cell(r.open_question)}` : ""} |`),
    "",
    "## Acceptance tests",
    ...brief.acceptance_responses.map((a) => `- **${a.test_id}** ${test.get(a.test_id)?.description ?? ""}: ${CLAIM_LABEL[a.claim]}. ${a.explanation}`),
  ];
  if (brief.proposed_decisions.length) {
    lines.push("", "## Proposed decisions (not recorded until approved)");
    for (const d of brief.proposed_decisions) {
      lines.push(`- **${d.title}** (${d.decision_class}): ${d.statement} ${d.rationale}` +
        (d.alternatives.length ? ` Alternatives: ${d.alternatives.join("; ")}.` : ""));
    }
  }
  if (brief.risks.length) lines.push("", "## Risks", ...brief.risks.map((r) => `- ${r.risk} Mitigation: ${r.mitigation}`));
  if (brief.assumptions.length) lines.push("", "## Assumptions", ...brief.assumptions.map((a) => `- ${a}`));
  if (brief.open_questions.length) lines.push("", "## Open questions", ...brief.open_questions.map((q) => `- ${q}`));
  lines.push("", "## Requirement text", ...[...req.values()].map((r) => `- **${r.refCode}** ${r.text}`), "");
  return lines.join("\n");
}

function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n+/g, " ");
}
