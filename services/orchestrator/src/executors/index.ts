import type { Executor } from "../execution.ts";
import type { TaskRow } from "../db.ts";
import type { EngineeringTools } from "../engineering.ts";
import { briefExecutor } from "./brief.ts";
import { fabExecutor } from "./fab.ts";
import { pcbExecutor } from "./pcb.ts";
import { powerExecutor } from "./power.ts";
import { schematicExecutor } from "./schematic.ts";
import { sourcingExecutor } from "./sourcing.ts";
import type { SourcingProvider } from "@vx/integrations";

/**
 * Disciplines no worker can execute yet. They are blocked with a plain reason rather than
 * simulated: a placeholder board or a "passed" DRC would be worse than nothing.
 * (Schematic, PCB layout, manufacturing and sourcing tasks are not listed: only workers with the KiCad engineering image claim them.)
 */
const PENDING: Record<string, string> = {
  simulation: "ngspice simulation is verified in the engineering image (G0) but has no task executor yet.",
  verification: "Verification (enclosure fit, bring-up checks) has no executor yet; the board's DRC and 3D outputs are on the layout task.",
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
export function executorsFor(engineering: EngineeringTools | null, sourcing: SourcingProvider[] = []): Executor[] {
  return [
    briefExecutor,
    powerExecutor,
    ...(engineering ? [schematicExecutor(engineering), pcbExecutor(engineering), fabExecutor(engineering)] : []),
    // Only a worker with at least one configured distributor (or the fixture stand-in) takes sourcing tasks.
    ...(sourcing.some((p) => p.configured()) ? [sourcingExecutor(sourcing.filter((p) => p.configured()))] : []),
    pendingExecutor,
  ];
}

/** Executors of a worker without the engineering image. */
export const EXECUTORS: Executor[] = executorsFor(null);
