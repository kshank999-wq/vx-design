/**
 * Board layout for PCB tasks. The model proposes an outline, mounting holes and a position for
 * every component of an approved circuit; the engineering worker checks courtyards against the
 * outline and each other, builds the KiCad board, autoroutes it and runs DRC with schematic
 * parity. Problems go back to the model with exact geometry (courtyard extents, allowed
 * position ranges, unrouted nets) until the board is clean or the repair budget is spent.
 */
import { z } from "zod";
import { ProgressTracker } from "./progress.ts";
import type { LanguageModel, Usage } from "./llm/model.ts";
import type { BriefAcceptanceTest, BriefRequirement, BriefUpstream } from "./brief.ts";
import type { CircuitDesign } from "./circuit.ts";

export const LAYOUT_PROMPT_VERSION = "layout-v1";
export const MAX_LAYOUT_REPAIRS = 3;

export const BoardLayout = z.object({
  board: z.object({
    width_mm: z.number().describe("Board outline width (x), mm"),
    height_mm: z.number().describe("Board outline height (y), mm"),
    corner_radius_mm: z.number().describe("Outline corner radius, 0 for square corners"),
    mounting_holes: z.array(z.object({
      x_mm: z.number(), y_mm: z.number(),
      size: z.enum(["M2", "M2.5", "M3"]),
    })).describe("Plated mounting holes; their keep-out (pad plus courtyard) is about 2x the screw size in diameter"),
  }),
  fab_profile: z.string().describe("Design-rule profile, one of the listed fab profiles"),
  ground_pour: z.string().nullable().describe("Net to pour on both copper layers (normally GND), or null"),
  placements: z.array(z.object({
    ref: z.string(),
    x_mm: z.number().describe("Footprint origin x from the board's top-left corner, mm"),
    y_mm: z.number().describe("Footprint origin y from the board's top-left corner (y grows downward), mm"),
    rotation_deg: z.number().describe("0, 90, 180 or 270 (counter-clockwise, as in KiCad)"),
    side: z.enum(["top", "bottom"]),
  })).describe("One entry per component of the circuit"),
  rationale: z.string().describe("Placement reasoning in 2-4 sentences: grouping, connector edges, decoupling"),
  assumptions: z.array(z.string()),
  open_questions: z.array(z.string()),
});
export type BoardLayout = z.infer<typeof BoardLayout>;

/** Courtyard facts of a footprint at rotation 0, relative to its origin (from the KiCad library). */
export interface FootprintFacts {
  ref: string;
  footprint: string;
  value?: string;
  courtyard_mm?: { width: number; height: number; left: number; top: number; right: number; bottom: number };
  pads?: number;
  mount?: "smd" | "through_hole";
  error?: string;
}

export interface LayoutInput {
  projectContext: string;
  task: { key: string; title: string; description: string | null };
  requirements: BriefRequirement[];
  acceptanceTests: BriefAcceptanceTest[];
  upstream: BriefUpstream[];
  reviewNotes: string[];
  circuit: CircuitDesign;
  footprints: FootprintFacts[];
  fabProfiles: { name: string; description: string }[];
}

export interface LayoutCheck {
  ok: boolean;
  problems: string[];
  warnings: string[];
  stage: "placement" | "schematic" | "routing" | "drc" | "built";
}

export class LayoutDesignError extends Error {
  readonly problems: string[];
  readonly rounds: number;
  constructor(problems: string[], rounds: number) {
    super(`board layout still has ${problems.length} problem(s) after ${rounds} round(s): ${problems.slice(0, 5).join("; ")}`);
    this.problems = problems;
    this.rounds = rounds;
  }
}

export interface LayoutResult {
  promptVersion: string;
  layout: BoardLayout;
  rounds: number;
  check: LayoutCheck;
  history: { round: number; stage: string; problems: number }[];
  usage: Usage[];
}

const SYSTEM = `You are a senior PCB designer placing components for a small two-layer board that will be autorouted (Freerouting) and checked with KiCad DRC.

Coordinates are millimetres from the board's top-left corner; x grows right, y grows down. Each placement positions the footprint origin. You are given every footprint's courtyard extents relative to its origin at rotation 0 (left/top are negative offsets); rotating by 90 swaps width and height. Courtyards must lie fully inside the outline and must not overlap other courtyards on the same side. Through-hole parts and mounting holes occupy both sides.

Good placement:
- Connectors at a board edge, oriented so the mating side faces outward.
- Decoupling and bulk capacitors within a few mm of the pins they serve; regulators between their input and output parts.
- Parts that share nets close together, signal flow in one direction, generous gaps (at least 1-2 mm between courtyards) so the router has room.
- Keep everything on the top side unless the board is too small; prefer one-sided assembly.
- Size the board to the requirements (outline, mounting) when they give one; otherwise make it compact but not cramped (courtyards covering under about 40% of the area routes reliably).
- Use a ground pour on GND unless there is a reason not to.

Record assumptions (e.g. an outline you chose because none was specified) and open questions. Return the complete layout.`;

function fmtFootprint(f: FootprintFacts): string {
  if (f.error || !f.courtyard_mm) return `- ${f.ref} ${f.footprint}: ${f.error ?? "no courtyard data"}`;
  const c = f.courtyard_mm;
  return `- ${f.ref} (${f.value ?? ""}) ${f.footprint}: ${f.mount}, ${f.pads} pads, courtyard ${c.width} x ${c.height} mm ` +
    `(x ${c.left}..${c.right}, y ${c.top}..${c.bottom} around the origin at rotation 0)`;
}

export function renderLayoutPrompt(input: LayoutInput): string {
  const reqs = input.requirements.map((r) => `- ${r.refCode} [${r.kind}, ${r.priority}] ${r.text}`).join("\n") || "- (none linked)";
  const tests = input.acceptanceTests.map((t) => `- ${t.id} (${t.method}): ${t.description}`).join("\n") || "- (none)";
  const upstream = input.upstream.map((u) => `### ${u.title} (${u.taskKey})\n${u.content}`).join("\n\n") || "(no text outputs)";
  const parts = input.circuit.components.map((c) => `- ${c.ref}: ${c.value} — ${c.purpose}`).join("\n");
  const nets = input.circuit.nets.map((n) => `- ${n.name}: ${n.pins.join(", ")}`).join("\n");
  const notes = input.reviewNotes.length
    ? `\n\nA reviewer returned the previous layout with these notes; address them:\n${input.reviewNotes.map((n) => `- ${n}`).join("\n")}` : "";
  return `Project: ${input.projectContext}\n\nTask: ${input.task.title} (${input.task.key})\n${input.task.description ?? ""}\n\n` +
    `Requirements:\n${reqs}\n\nAcceptance tests:\n${tests}\n\n` +
    `Circuit: ${input.circuit.title}\n${input.circuit.summary}\n\nComponents:\n${parts}\n\nNets:\n${nets}\n\n` +
    `Footprints (KiCad library facts):\n${input.footprints.map(fmtFootprint).join("\n")}\n\n` +
    `Fab profiles:\n${input.fabProfiles.map((p) => `- ${p.name}: ${p.description}`).join("\n")}\n\n` +
    `Upstream outputs:\n${upstream}${notes}\n\nPlace the board.`;
}

/**
 * Propose a layout, check it (placement, routing, DRC with schematic parity) and repair until it
 * passes or MAX_LAYOUT_REPAIRS rounds are spent.
 */
export async function generateLayout(
  input: LayoutInput,
  model: LanguageModel,
  check: (layout: BoardLayout, round: number) => Promise<LayoutCheck>,
  onRound?: (round: number, check: LayoutCheck, usage: Usage) => Promise<void>,
): Promise<LayoutResult> {
  const usage: Usage[] = [];
  const history: LayoutResult["history"] = [];
  const messages: Parameters<LanguageModel["generate"]>[0]["messages"] = [{ role: "user", content: renderLayoutPrompt(input) }];
  const progress = new ProgressTracker();
  for (let round = 1; ; round++) {
    const result = await model.generate({
      purpose: round === 1 ? "board_layout" : "board_layout_repair", system: SYSTEM, messages, schema: BoardLayout, cache: "follow-up",
    });
    usage.push(result.usage);
    const c = await check(result.output, round);
    history.push({ round, stage: c.stage, problems: c.problems.length });
    await onRound?.(round, c, result.usage);
    if (c.ok) return { promptVersion: LAYOUT_PROMPT_VERSION, layout: result.output, rounds: round, check: c, history, usage };
    const stall = progress.check(result.output, c.problems);
    if (stall) throw new LayoutDesignError([...c.problems, stall], round);
    if (round > MAX_LAYOUT_REPAIRS) throw new LayoutDesignError(c.problems, round);
    messages.push(result.assistantMessage, {
      role: "user",
      content: `The layout failed at the ${c.stage} stage:\n${c.problems.map((p) => `- ${p}`).join("\n")}` +
        (c.warnings.length ? `\n\nWarnings (fix if they matter):\n${c.warnings.map((w) => `- ${w}`).join("\n")}` : "") +
        "\n\nReturn the complete corrected layout.",
    });
  }
}

/**
 * Layout used by the offline stand-in, for OFFLINE_FIXTURE_CIRCUIT only. Fixed, not reasoned about,
 * and labelled as such wherever it appears.
 */
export const OFFLINE_FIXTURE_LAYOUT: BoardLayout = {
  board: {
    width_mm: 34, height_mm: 22, corner_radius_mm: 1.5,
    mounting_holes: [
      { x_mm: 3.5, y_mm: 3.5, size: "M3" }, { x_mm: 30.5, y_mm: 3.5, size: "M3" },
      { x_mm: 3.5, y_mm: 18.5, size: "M3" }, { x_mm: 30.5, y_mm: 18.5, size: "M3" },
    ],
  },
  fab_profile: "jlcpcb-2layer-standard",
  ground_pour: "GND",
  placements: [
    { ref: "J1", x_mm: 4, y_mm: 9.7, rotation_deg: 0, side: "top" },
    { ref: "C1", x_mm: 10, y_mm: 11, rotation_deg: 90, side: "top" },
    { ref: "U1", x_mm: 15.5, y_mm: 11, rotation_deg: 0, side: "top" },
    { ref: "C2", x_mm: 21, y_mm: 11, rotation_deg: 90, side: "top" },
    { ref: "R1", x_mm: 25, y_mm: 11, rotation_deg: 90, side: "top" },
    { ref: "D1", x_mm: 29, y_mm: 11, rotation_deg: 90, side: "top" },
  ],
  rationale: "Offline stand-in: a fixed layout for the fixture circuit (input left, regulator centre, LED right, M3 corner holes). Not derived from your requirements.",
  assumptions: ["Offline stand-in: no placement reasoning was performed."],
  open_questions: [],
};
