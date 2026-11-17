import type { Executor } from "../execution.ts";
import type { TaskRow } from "../db.ts";
import { briefExecutor } from "./brief.ts";

/**
 * Disciplines whose executors are not built yet. They are blocked with a plain reason rather
 * than simulated: a placeholder schematic or "passed" DRC would be worse than nothing.
 */
const PENDING: Record<string, string> = {
  schematic: "Schematic capture runs in the KiCad engineering worker, which arrives in G3.",
  pcb_layout: "PCB layout and DRC run in the KiCad engineering worker, which arrives in G4.",
  simulation: "ngspice simulation runs in the engineering worker, which arrives in G3.",
  verification: "Verification needs the G3/G4 design outputs (ERC, DRC, 3D fit) to check against.",
  manufacturing: "Fabrication outputs (Gerbers, drill, BOM, CPL, panel) arrive in G4.5.",
  sourcing: "Distributor sourcing needs DigiKey, Mouser or Nexar API keys; those integrations are untested (see the G0 capability matrix).",
};

const pendingExecutor: Executor = {
  id: "not-yet-available",
  version: "1",
  describe: "Blocks tasks whose discipline has no executor yet",
  canRun: (task: TaskRow) => task.discipline in PENDING,
  async run(ctx) {
    return { status: "blocked", reason: `No executor yet: ${PENDING[ctx.task.discipline]}` };
  },
};

/** Order matters: the first executor whose canRun matches handles the task. */
export const EXECUTORS: Executor[] = [briefExecutor, pendingExecutor];
