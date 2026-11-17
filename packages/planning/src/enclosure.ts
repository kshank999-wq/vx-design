/**
 * Enclosure for enclosure tasks. The model chooses the process, wall, clearances, fastening and openings
 * from the requirements and the board's 3D facts; the engineering worker builds the housing around the
 * board's own outline and 3D models and checks fit (every part against base and lid), connector access and
 * process rules. Problems go back to the model until the housing fits or the repair budget is spent.
 */
import { z } from "zod";
import type { LanguageModel, Usage } from "./llm/model.ts";
import type { BriefAcceptanceTest, BriefRequirement, BriefUpstream } from "./brief.ts";

export const ENCLOSURE_PROMPT_VERSION = "enclosure-v1";
export const MAX_ENCLOSURE_REPAIRS = 3;

export const EnclosureDesign = z.object({
  process: z.enum(["fdm", "sla", "sls", "cnc_aluminum"]),
  material: z.string().describe("e.g. PETG, ASA, PA12, 6061-T6"),
  wall_mm: z.number(),
  edge_gap_mm: z.number().describe("Gap between the board edge and the inner wall"),
  top_clearance_mm: z.number().describe("Gap above the tallest part inside (parts with a top opening may pass through the lid)"),
  standoff_height_mm: z.number().describe("Floor to the board's underside; must clear through-hole pins and take the fastener"),
  fastening: z.enum(["heat_set_insert", "self_tapping", "tapped"]).describe("How board screws hold in the standoffs"),
  openings: z.array(z.object({
    kind: z.enum(["edge", "top"]).describe("edge: through the nearest wall, for connectors and switches; top: through the lid"),
    ref: z.string(),
    side: z.enum(["left", "right", "front", "back"]).nullable().describe("edge openings: the wall, or null for the nearest"),
    shape: z.enum(["rect", "round"]).describe("top openings"),
    size_mm: z.number().nullable().describe("round top openings: diameter (e.g. a light hole), or null to fit the part"),
    margin_mm: z.number().describe("Clearance around the part in the opening"),
  })),
  rationale: z.string(),
  assumptions: z.array(z.string()),
  open_questions: z.array(z.string()),
});
export type EnclosureDesign = z.infer<typeof EnclosureDesign>;

export interface EnclosureFacts {
  board: { width_mm: number; height_mm: number; thickness_mm: number };
  holes: { ref: string; x: number; y: number; size: string }[];
  parts: { ref: string; value: string; side: string; has_model: boolean; height_above_board_mm?: number; bottom_z_mm?: number;
           nearest_edge?: string; edge_distance_mm?: number }[];
  processes: Record<string, { label: string; min_wall_mm: number; fastenings: string[]; min_inner_radius_mm: number; build_mm: number[] }>;
  fastener_depth_mm: Record<string, Record<string, number>>;
}

export interface EnclosureInput {
  projectContext: string;
  task: { key: string; title: string; description: string | null };
  requirements: BriefRequirement[];
  acceptanceTests: BriefAcceptanceTest[];
  upstream: BriefUpstream[];
  reviewNotes: string[];
  facts: EnclosureFacts;
  components: { ref: string; value: string; purpose: string }[];
}

export interface EnclosureCheck { ok: boolean; problems: string[]; warnings: string[]; stage: "spec" | "fit" | "built" }

export class EnclosureDesignError extends Error {
  readonly problems: string[];
  readonly rounds: number;
  constructor(problems: string[], rounds: number) {
    super(`enclosure still has ${problems.length} problem(s) after ${rounds} round(s): ${problems.slice(0, 5).join("; ")}`);
    this.problems = problems;
    this.rounds = rounds;
  }
}

const SYSTEM = `You are a senior mechanical engineer designing a two-part housing (base with standoffs, lid with a locating lip) for a small circuit board, for prototyping.

The housing is generated around the board's real outline and every part's 3D model, then checked: any overlap between a part (or the board) and the base or lid is an error that names the part; parts that need to reach outside get openings:
- edge openings go through the nearest wall (or the side you name) and are sized from the part's 3D model: use them for connectors, switches and buttons on the board edge. A connector far from the wall is flagged as recessed.
- top openings go through the lid: windows for tall headers or displays, round light holes for LEDs (give a diameter), button holes.
The lid sits above the tallest part without a top opening plus the top clearance.

Choose the process and material from the requirements (default FDM PETG for a first prototype), a wall at or above the process minimum, standoffs tall enough to clear through-hole pins below the board and to take the fastener, and a fastening the process supports (heat-set inserts or thread-forming screws in prints, tapped holes in aluminium). Record assumptions (e.g. an enclosure style you chose because none was specified) and open questions.`;

export function renderEnclosurePrompt(input: EnclosureInput): string {
  const f = input.facts;
  const reqs = input.requirements.map((r) => `- ${r.refCode} [${r.kind}, ${r.priority}] ${r.text}`).join("\n") || "- (none linked)";
  const tests = input.acceptanceTests.map((t) => `- ${t.id} (${t.method}): ${t.description}`).join("\n") || "- (none)";
  const upstream = input.upstream.map((u) => `### ${u.title} (${u.taskKey})\n${u.content}`).join("\n\n") || "(no text outputs)";
  const purpose = new Map(input.components.map((c) => [c.ref, c.purpose]));
  const parts = f.parts.map((p) => p.has_model
    ? `- ${p.ref} (${p.value}${purpose.get(p.ref) ? `, ${purpose.get(p.ref)}` : ""}): ${p.side} side, ${p.height_above_board_mm} mm above the board, ` +
      `bottom at z ${p.bottom_z_mm} mm, ${p.edge_distance_mm} mm from the ${p.nearest_edge} edge`
    : `- ${p.ref} (${p.value}): no 3D model, so its fit cannot be checked`).join("\n");
  const notes = input.reviewNotes.length ? `\n\nA reviewer returned the previous enclosure with these notes; address them:\n${input.reviewNotes.map((n) => `- ${n}`).join("\n")}` : "";
  return `Project: ${input.projectContext}\n\nTask: ${input.task.title} (${input.task.key})\n${input.task.description ?? ""}\n\n` +
    `Requirements:\n${reqs}\n\nAcceptance tests:\n${tests}\n\n` +
    `Board: ${f.board.width_mm} x ${f.board.height_mm} mm, ${f.board.thickness_mm} mm thick; mounting holes: ` +
    `${f.holes.map((h) => `${h.ref} ${h.size} at (${h.x}, ${h.y})`).join(", ") || "none"}\n\nParts (3D extents from the board's models):\n${parts}\n\n` +
    `Processes:\n${Object.entries(f.processes).map(([k, p]) => `- ${k}: ${p.label}; minimum wall ${p.min_wall_mm} mm; fastenings ${p.fastenings.join(", ")}` +
      (p.min_inner_radius_mm ? `; inner corner radius at least ${p.min_inner_radius_mm} mm (equals the edge gap)` : "") +
      `; build volume ${p.build_mm.join(" x ")} mm`).join("\n")}\n` +
    `Fastener depth needed in the standoff: ${Object.entries(f.fastener_depth_mm).map(([k, v]) => `${k} ${Object.entries(v).map(([s, d]) => `${s} ${d} mm`).join(", ")}`).join("; ")}\n\n` +
    `Upstream outputs:\n${upstream}${notes}\n\nDesign the enclosure.`;
}

export async function generateEnclosure(
  input: EnclosureInput, model: LanguageModel,
  check: (design: EnclosureDesign, round: number) => Promise<EnclosureCheck>,
  onRound?: (round: number, check: EnclosureCheck, usage: Usage) => Promise<void>,
): Promise<{ promptVersion: string; design: EnclosureDesign; rounds: number; check: EnclosureCheck; usage: Usage[];
             history: { round: number; stage: string; problems: number }[] }> {
  const usage: Usage[] = [];
  const history: { round: number; stage: string; problems: number }[] = [];
  const messages: Parameters<LanguageModel["generate"]>[0]["messages"] = [{ role: "user", content: renderEnclosurePrompt(input) }];
  for (let round = 1; ; round++) {
    const r = await model.generate({ purpose: round === 1 ? "enclosure_design" : "enclosure_design_repair", system: SYSTEM, messages, schema: EnclosureDesign });
    usage.push(r.usage);
    const c = await check(r.output, round);
    history.push({ round, stage: c.stage, problems: c.problems.length });
    await onRound?.(round, c, r.usage);
    if (c.ok) return { promptVersion: ENCLOSURE_PROMPT_VERSION, design: r.output, rounds: round, check: c, usage, history };
    if (round > MAX_ENCLOSURE_REPAIRS) throw new EnclosureDesignError(c.problems, round);
    messages.push(r.assistantMessage, {
      role: "user",
      content: `The enclosure failed at the ${c.stage} stage:\n${c.problems.map((p) => `- ${p}`).join("\n")}` +
        (c.warnings.length ? `\n\nWarnings (fix if they matter):\n${c.warnings.map((w) => `- ${w}`).join("\n")}` : "") +
        "\n\nReturn the complete corrected enclosure design.",
    });
  }
}

/** Offline stand-in for the fixture board (LDO+LED): labelled, not derived from your requirements. */
export const OFFLINE_FIXTURE_ENCLOSURE: EnclosureDesign = {
  process: "fdm", material: "PETG", wall_mm: 2, edge_gap_mm: 0.5, top_clearance_mm: 2, standoff_height_mm: 6,
  fastening: "heat_set_insert",
  openings: [
    { kind: "top", ref: "J1", side: null, shape: "rect", size_mm: null, margin_mm: 0.5 },
    { kind: "top", ref: "D1", side: null, shape: "round", size_mm: 2.5, margin_mm: 0.5 },
  ],
  rationale: "Offline fixture: a two-part FDM housing; the input header passes through a window in the lid and the LED shows through a light hole; M3 heat-set inserts in 6 mm standoffs.",
  assumptions: ["Offline stand-in: no enclosure reasoning was performed."],
  open_questions: [],
};
