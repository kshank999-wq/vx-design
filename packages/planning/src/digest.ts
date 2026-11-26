/**
 * The everyday-language digest of a finished task: a short summary a person without engineering training understands
 * (what was done, what it means for the product, whether the checks passed), and the few questions only the owner can
 * answer, each with a recommendation the work carries on with meanwhile. Written by a small, cheap model from the task's
 * own outputs and checks; the full technical record stays one click away.
 */
import { z } from "zod";
import type { LanguageModel, Usage } from "./llm/model.ts";

export const DIGEST_PROMPT_VERSION = "digest-v2";
export const DIGEST_MODEL = "claude-haiku-5-5";

export const TaskDigest = z.object({
  summary: z.string().describe("2-4 short sentences in everyday language: what was done, what it means for the product, and whether VX Design's checks passed. No jargon, part numbers or abbreviations unless explained."),
  questions: z.array(z.object({
    question: z.string().describe("A decision only the product owner can make (preference, budget, market, feature trade-off), asked plainly"),
    why: z.string().describe("One sentence: why it matters, in everyday language"),
    recommendation: z.string().describe("What VX Design recommends and will assume until answered"),
    options: z.array(z.string()).describe("2-4 short answer choices, the recommendation first"),
  })).max(3).describe("Only real owner decisions raised by this work; engineering details are VX Design's job, not questions. Usually none."),
  file_requests: z.array(z.object({
    kind: z.enum(["datasheet", "3d_model", "drawing", "other"]),
    mpn: z.string().nullable().describe("The part number, exactly as in the parts list, or null for a non-part document"),
    manufacturer: z.string().nullable(),
    title: z.string().describe("The to-do in plain words, e.g. 'Get the electrical datasheet for the ELI101-IPHW display from Future Designs'"),
    why: z.string().describe("One plain sentence: what it lets the team do or check"),
    where_to_look: z.string().describe("Where the owner will find it: the manufacturer's product page and which section (Downloads, CAD models, Documents)"),
  })).max(6).default([]).describe("Files this work needed but did not have and the owner can download from a manufacturer's website (datasheets, STEP 3D models, drawings). Not files already listed among the owner's inputs. Usually none."),
});
export type TaskDigest = z.infer<typeof TaskDigest>;

export interface DigestInput {
  project: string;
  task: { title: string; discipline: string; description: string | null };
  summary: string;
  checks: { kind: string; result: string; summary: string }[];
  outputs: { name: string; text: string }[];
  answered: { question: string; answer: string }[];
}

const SYSTEM = `You explain an engineering team's finished work to the product's owner, who is not an engineer. Write as a clear, friendly project lead: plain words, short sentences, no jargon (if a technical term is unavoidable, say what it means in a few words). Say what was done, what it means for the product (what it will do, cost, size, battery, look), and whether the automatic checks passed. Do not list files or check names.

If this work lacked a document or file that a manufacturer publishes (a part's datasheet, its 3D STEP model, a mechanical drawing), and it is not among the owner's inputs listed in the product description, add it to file_requests so the owner can download it: say exactly which part and file, why it helps, and where on the manufacturer's site to find it. Never ask for a file the inputs already list.

Then raise only the questions that are genuinely the owner's to decide (preferences, priorities, budget, markets, features) and that this work brought up; engineering choices are the team's and are never questions. Each needs a recommendation the team will follow until the owner answers. Do not repeat questions already answered. Most tasks raise none.`;

export function renderDigestPrompt(i: DigestInput): string {
  const checks = i.checks.map((c) => `- ${c.result}: ${c.summary}`).join("\n") || "- (no automatic checks for this step)";
  const outs = i.outputs.map((o) => `### ${o.name}\n${o.text.slice(0, 6000)}`).join("\n\n").slice(0, 16000) || "(no text outputs)";
  const answered = i.answered.length ? `\n\nAlready answered by the owner:\n${i.answered.map((a) => `- ${a.question} → ${a.answer}`).join("\n")}` : "";
  return `Product: ${i.project}\n\nFinished step: ${i.task.title} (${i.task.discipline.replace(/_/g, " ")})\n${i.task.description ?? ""}\n\n` +
    `Team's technical summary: ${i.summary}\n\nAutomatic checks:\n${checks}\n\nWhat it produced:\n${outs}${answered}\n\nWrite the summary and any questions.`;
}

export async function digestTask(i: DigestInput, model: LanguageModel): Promise<{ digest: TaskDigest; usage: Usage }> {
  const r = await model.generate({ purpose: "task_digest", system: SYSTEM, messages: [{ role: "user", content: renderDigestPrompt(i) }], schema: TaskDigest });
  return { digest: r.output, usage: r.usage };
}

/** Offline stand-in: the technical summary, labelled, and no questions. */
export function offlineDigest(prompt: string): TaskDigest {
  const step = /Finished step: (.+?)(?: \([^)]*\))?$/m.exec(prompt)?.[1] ?? "This step";
  return { summary: `Offline stand-in, not AI: "${step}" is finished and its automatic checks passed.`, questions: [], file_requests: [] };
}
