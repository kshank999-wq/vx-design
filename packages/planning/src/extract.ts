/**
 * Requirement extraction with verified citations (spec §5 "Intake").
 */
import { z } from "zod";
import { RequirementKind, RequirementPriority } from "@vx/contracts";
import { findBlock, renderForPrompt, verifyCitation, type ParsedDocument } from "./ingest/document.ts";
import type { LanguageModel, Usage } from "./llm/model.ts";

export const EXTRACTION_PROMPT_VERSION = "extract-v1";

/** Wire schema returned by the model (kept simple for structured outputs). */
const ExtractionOutput = z.object({
  requirements: z.array(z.object({
    statement: z.string().describe("The requirement as one testable sentence, faithful to the source."),
    kind: RequirementKind,
    priority: RequirementPriority,
    block_id: z.string().describe("Id of the block the requirement comes from, e.g. S2.1.p3"),
    excerpt: z.string().describe("Exact, contiguous text copied from that block that supports the requirement."),
    acceptance_criteria: z.string().nullable().describe("How compliance would be verified, or null if the source gives no basis."),
    ambiguity: z.string().nullable().describe("What is unclear or missing, or null if the requirement is unambiguous."),
  })),
  open_questions: z.array(z.object({
    question: z.string(),
    block_id: z.string().nullable(),
  })),
});
type ExtractionOutput = z.infer<typeof ExtractionOutput>;

const SYSTEM = `You extract engineering requirements from hardware product specifications for an electronics and mechanical design team.

Each block of the document is labelled with an id in square brackets. For every requirement:
- Cite the block it comes from and copy an excerpt verbatim from that block. Citations are checked mechanically; an excerpt that is paraphrased or spans two blocks is rejected.
- Write one requirement per testable obligation. Split compound sentences; keep numbers, units and tolerances exactly as written.
- Use "must" for shall/must language, "should" for preferences, "may" for options.
- Record ambiguity (missing tolerance, undefined term, conflicting values) instead of guessing a value.

Do not extract background, rationale or document metadata as requirements. Put questions the team must answer before design starts in open_questions.`;

export const KIND_CODES: Record<RequirementKind, string> = {
  functional: "FUN", electrical: "ELE", power: "PWR", mechanical: "MEC", thermal: "THM", interface: "IFC",
  environmental: "ENV", regulatory: "REG", manufacturing: "MFG", cost: "CST", other: "GEN",
};

export interface ExtractedRequirement {
  refCode: string;
  kind: RequirementKind;
  priority: "must" | "should" | "may";
  status: "extracted" | "ambiguous";
  text: string;
  sectionId: string;
  sectionTitle: string;
  blockId: string;
  page: number | null;
  excerpt: string;
  acceptanceCriteria: string | null;
  notes: string | null;
}

export interface ExtractionResult {
  promptVersion: string;
  requirements: ExtractedRequirement[];
  openQuestions: { question: string; blockId: string | null }[];
  /** Requirements whose citation could not be verified after a correction round. */
  dropped: { statement: string; blockId: string; excerpt: string; reason: string }[];
  usage: Usage[];
}

export async function extractRequirements(doc: ParsedDocument, model: LanguageModel): Promise<ExtractionResult> {
  const usage: Usage[] = [];
  const messages: Parameters<LanguageModel["generate"]>[0]["messages"] = [{
    role: "user",
    content: `Document${doc.title ? ` "${doc.title}"` : ""}:\n\n${renderForPrompt(doc)}\n\nExtract all requirements.`,
  }];

  let result = await model.generate({ purpose: "extract_requirements", system: SYSTEM, messages, schema: ExtractionOutput });
  usage.push(result.usage);
  let failures = checkCitations(doc, result.output);

  if (failures.length) {
    // One correction round: show exactly which citations failed and why.
    messages.push(result.assistantMessage, {
      role: "user",
      content: "These citations could not be verified against the document:\n" +
        failures.map((f) => `- [${f.item.block_id}] "${f.item.excerpt}" (${f.reason})`).join("\n") +
        "\n\nReturn the complete requirement list again with each excerpt copied exactly from its block. " +
        "Drop any requirement the document does not actually state.",
    });
    result = await model.generate({ purpose: "extract_requirements_repair", system: SYSTEM, messages, schema: ExtractionOutput });
    usage.push(result.usage);
    failures = checkCitations(doc, result.output);
  }

  const failed = new Set(failures.map((f) => f.item));
  const verified = result.output.requirements
    .filter((r) => !failed.has(r))
    .map((r) => {
      const check = verifyCitation(doc, r.block_id, r.excerpt);
      const where = findBlock(doc, check.blockId!)!;
      return { r, blockId: check.blockId!, section: where.section, page: where.block.page ?? null };
    });

  // Deterministic ordering and numbering: document order, then model order within a block.
  const blockOrder = new Map<string, number>();
  doc.sections.flatMap((s) => s.blocks).forEach((b, i) => blockOrder.set(b.id, i));
  verified.sort((a, b) => blockOrder.get(a.blockId)! - blockOrder.get(b.blockId)!);
  const counters = new Map<string, number>();
  const seen = new Set<string>();
  const requirements: ExtractedRequirement[] = [];
  for (const v of verified) {
    const dedupeKey = `${v.blockId}|${v.r.statement.toLowerCase().trim()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const code = KIND_CODES[v.r.kind];
    const n = (counters.get(code) ?? 0) + 1;
    counters.set(code, n);
    requirements.push({
      refCode: `REQ-${code}-${String(n).padStart(3, "0")}`,
      kind: v.r.kind,
      priority: v.r.priority,
      status: v.r.ambiguity ? "ambiguous" : "extracted",
      text: v.r.statement.trim(),
      sectionId: v.section.id,
      sectionTitle: v.section.number ? `${v.section.number} ${v.section.title}` : v.section.title,
      blockId: v.blockId,
      page: v.page,
      excerpt: v.r.excerpt.trim(),
      acceptanceCriteria: v.r.acceptance_criteria,
      notes: v.r.ambiguity,
    });
  }

  return {
    promptVersion: EXTRACTION_PROMPT_VERSION,
    requirements,
    openQuestions: result.output.open_questions.map((q) => ({ question: q.question, blockId: q.block_id })),
    dropped: failures.map((f) => ({ statement: f.item.statement, blockId: f.item.block_id, excerpt: f.item.excerpt, reason: f.reason })),
    usage,
  };
}

function checkCitations(doc: ParsedDocument, out: ExtractionOutput) {
  const failures: { item: ExtractionOutput["requirements"][number]; reason: string }[] = [];
  for (const item of out.requirements) {
    const check = verifyCitation(doc, item.block_id, item.excerpt);
    if (!check.ok) failures.push({ item, reason: check.reason ?? "not verifiable" });
  }
  return failures;
}
