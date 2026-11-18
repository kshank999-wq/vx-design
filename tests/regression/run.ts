/**
 * Regression suite (G6): `pnpm test:regression` runs every case twice and checks that
 *   1. the two runs give identical output (repeatable), and
 *   2. the output matches the committed golden snapshot (unchanged), naming which inputs or versions changed if not.
 * `--update` rewrites the snapshots after an intended change (review the diff in git). `--engineering` adds the KiCad
 * tier: schematic, layout and fab package built twice in separate engineering-worker containers.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CASES, ROOT, sha, type CaseResult } from "./cases.ts";
import { runEngineeringTier } from "./engineering-host.ts";

const update = process.argv.includes("--update");
const engineering = process.argv.includes("--engineering");
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);
const GOLDEN = join(ROOT, "tests/regression/golden");

function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])]));
  return v;
}
const canon = (v: unknown) => JSON.stringify(stable(v), null, 1);

function firstDiff(a: string, b: string, max = 15): string {
  const al = a.split("\n"), bl = b.split("\n");
  const out: string[] = [];
  for (let i = 0; i < Math.max(al.length, bl.length) && out.length < max; i++) {
    if (al[i] !== bl[i]) out.push(`line ${i + 1}:\n      golden: ${al[i]?.trim() ?? "(none)"}\n      now:    ${bl[i]?.trim() ?? "(none)"}`);
  }
  return out.join("\n    ") || "(no line difference)";
}

interface Golden { case: string; describe: string; inputs: Record<string, string>; versions: Record<string, string>; output_sha256: string; output: unknown }

let failed = 0;
const cases = [...CASES.map((c) => ({ name: c.name, describe: c.describe, runTwice: async () => [await c.run(), await c.run()] as [CaseResult, CaseResult] }))];
if (engineering) cases.push(...await runEngineeringTier());
for (const c of cases.filter((x) => !only || x.name === only)) {
  const t = Date.now();
  let a: CaseResult, b: CaseResult;
  try { [a, b] = await c.runTwice(); } catch (e) { console.log(`✗ ${c.name}: ${(e as Error).message}`); failed++; continue; }
  const ca = canon(a.output), cb = canon(b.output);
  const ms = Date.now() - t;
  if (ca !== cb) { console.log(`✗ ${c.name}: two runs differ (not repeatable)\n    ${firstDiff(ca, cb)}`); failed++; continue; }
  const file = join(GOLDEN, `${c.name}.json`);
  const now: Golden = { case: c.name, describe: c.describe, inputs: a.inputs, versions: a.versions, output_sha256: sha(ca), output: stable(a.output) };
  if (update || !existsSync(file)) {
    writeFileSync(file, JSON.stringify(now, null, 1) + "\n");
    console.log(`✎ ${c.name}: snapshot ${update ? "updated" : "created"} (repeatable; ${now.output_sha256.slice(0, 12)}, ${ms} ms)`);
    continue;
  }
  const g = JSON.parse(readFileSync(file, "utf8")) as Golden;
  if (g.output_sha256 === now.output_sha256) { console.log(`✓ ${c.name}: repeatable and unchanged (${now.output_sha256.slice(0, 12)}, ${ms} ms)`); continue; }
  failed++;
  const changedIn = Object.keys({ ...g.inputs, ...now.inputs }).filter((k) => g.inputs[k] !== now.inputs[k]);
  const changedV = Object.keys({ ...g.versions, ...now.versions }).filter((k) => g.versions[k] !== now.versions[k]);
  console.log(`✗ ${c.name}: output changed (golden ${g.output_sha256.slice(0, 12)}, now ${now.output_sha256.slice(0, 12)})`);
  console.log(`    inputs changed: ${changedIn.join(", ") || "none"}; versions changed: ${changedV.map((k) => `${k} ${g.versions[k]} → ${now.versions[k]}`).join(", ") || "none"}`);
  console.log(`    first difference at ${firstDiff(canon(g.output), canon(now.output))}`);
  console.log("    if intended: pnpm test:regression --update, and review the snapshot diff");
}
console.log(failed ? `\n${failed} regression case(s) failed.` : "\nRegression suite passed.");
process.exit(failed ? 1 : 0);
