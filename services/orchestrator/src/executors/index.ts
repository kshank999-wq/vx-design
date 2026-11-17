import type { Executor } from "../execution.ts";
import type { TaskRow } from "../db.ts";
import type { EngineeringTools } from "../engineering.ts";
import { briefExecutor } from "./brief.ts";
import { schematicExecutor } from "./schematic.ts";

/**
 * Disciplines no worker can execute yet. They are blocked with a plain reason rather than
 * simulated: a placeholder board or a "passed" DRC would be worse than nothing.
 * (Schematic tasks are not listed: only workers with the KiCad engineering image claim them.)
 */
const PENDING: Record<string, string> = {
  pcb_layout: "PCB layout and DRC run in the KiCad engineering worker, which arrives in G4.",
  simulation: "ngspice simulation is verified in the engineering image (G0) but has no task executor yet.",
  verification: "Verification needs the G4 board outputs (DRC, 3D fit) to check against.",
  manufacturing: "Fabrication outputs (Gerbers, drill, BOM, CPL, panel) arrive in G4.5.",
  sourcing: "Distributor sourcing needs DigiKey, Mouser or Nexar API keys; those integrations are untested (see the G0 capability matrix).",
};

const pendingExecutor: Executor = {
  id: "not-yet-available",
  version: "1",
  describe: "Blocks tasks whose discipline has no executor yet",
  disciplines: Object.keys(PENDING),
  canRun: (task: TaskRow) => task.discipline in PENDING,
  async run(ctx) {
    return { status: "blocked", reason: `No executor yet: ${PENDING[ctx.task.discipline]}` };
  },
};

/** Executors for this worker. Order matters: the first whose canRun matches handles the task. */
export function executorsFor(engineering: EngineeringTools | null): Executor[] {
  return [briefExecutor, ...(engineering ? [schematicExecutor(engineering)] : []), pendingExecutor];
}

/** Executors of a worker without the engineering image. */
export const EXECUTORS: Executor[] = executorsFor(null);
