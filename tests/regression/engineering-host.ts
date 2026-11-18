/** Runs the engineering tier twice, each in a fresh engineering-worker container, and exposes the results as cases. */
import { execFileSync } from "node:child_process";
import { ROOT, type CaseResult } from "./cases.ts";

const IMAGE = process.env.ENGINEERING_WORKER_IMAGE ?? "vx-engineering-worker";

function runOnce(): Record<string, any> {
  // The repo's vx_eng is mounted over the image's copy, so the tier tests the code in this checkout.
  const out = execFileSync("docker", ["run", "--rm", "-v", `${ROOT}:/repo:ro`, "-v", `${ROOT}/services/engineering/vx_eng:/opt/vx/vx_eng:ro`,
                                      "-e", "VX_ENG_DIR=/opt/vx", "-e", "PYTHONDONTWRITEBYTECODE=1", "--entrypoint", "node", IMAGE,
                                      "/repo/tests/regression/engineering-guest.ts"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 3_600_000 });
  const line = out.split("\n").find((l) => l.startsWith("REGRESSION_JSON "));
  if (!line) throw new Error(`engineering tier printed no result:\n${out.slice(-2000)}`);
  return JSON.parse(line.slice("REGRESSION_JSON ".length));
}

export async function runEngineeringTier() {
  console.log(`engineering tier: two builds in ${IMAGE} (several minutes)…`);
  const a = runOnce(), b = runOnce();
  const as = (r: Record<string, any>, stage: string): CaseResult => ({ inputs: r.inputs, versions: r.versions, output: r[stage] });
  return ["schematic", "layout", "fab"].map((stage) => ({
    name: `eng-${stage}`, describe: `KiCad ${stage} from the offline fixture circuit (engineering-worker image)`,
    runTwice: async () => [as(a, stage), as(b, stage)] as [CaseResult, CaseResult],
  }));
}
