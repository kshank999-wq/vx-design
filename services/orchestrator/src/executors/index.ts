import type { Executor } from "../execution.ts";
import type { TaskRow } from "../db.ts";
import type { EngineeringTools } from "../engineering.ts";
import { briefExecutor } from "./brief.ts";
import { enclosureExecutor } from "./enclosure.ts";
import { fabExecutor } from "./fab.ts";
import { pcbExecutor } from "./pcb.ts";
import { powerExecutor } from "./power.ts";
import { schematicExecutor } from "./schematic.ts";
import { simulationExecutor } from "./simulation.ts";
import { verificationExecutor } from "./verification.ts";
import { manufacturingDocExecutor, rfqExecutor } from "./manufacturing.ts";
import { sourcingExecutor } from "./sourcing.ts";
import type { SourcingProvider } from "@vx/integrations";

/**
 * Disciplines no worker can execute yet. They are blocked with a plain reason rather than
 * simulated: a placeholder board or a "passed" DRC would be worse than nothing.
 * (Schematic, simulation, PCB layout, manufacturing, enclosure and sourcing tasks are not listed: only workers with the KiCad engineering image claim them.)
 */
const PENDING: Record<string, string> = {
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
    verificationExecutor,
    manufacturingDocExecutor,
    rfqExecutor,
    ...(engineering ? [schematicExecutor(engineering), simulationExecutor(engineering), pcbExecutor(engineering), fabExecutor(engineering), enclosureExecutor(engineering)] : []),
    // Only a worker with at least one configured distributor (or the fixture stand-in) takes sourcing tasks.
    ...(sourcing.some((p) => p.configured()) ? [sourcingExecutor(sourcing.filter((p) => p.configured()))] : []),
    pendingExecutor,
  ];
}

/** Executors of a worker without the engineering image. */
export const EXECUTORS: Executor[] = executorsFor(null);
