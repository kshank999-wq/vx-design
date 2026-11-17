import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PlannedTask, TASK_TRANSITIONS, TaskStatus, topologicalOrder } from "./index.ts";

const migrationsDir = join(import.meta.dirname, "../../../supabase/migrations");
const sql = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .map((f) => readFileSync(join(migrationsDir, f), "utf8"))
  .join("\n");

test("task_status enum matches SQL", () => {
  const m = sql.match(/create type public\.task_status as enum \(([^)]*)\)/);
  assert.ok(m, "task_status enum not found in migrations");
  const sqlValues = [...m[1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
  assert.deepEqual(sqlValues, TaskStatus.options);
});

test("task transitions match SQL task_transition_allowed", () => {
  const fn = sql.slice(sql.indexOf("function public.task_transition_allowed"));
  for (const from of TaskStatus.options) {
    const line = fn.match(new RegExp(`when '${from}'\\s+then p_to in \\(([^)]*)\\)`));
    const sqlTargets = line ? [...line[1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]) : [];
    assert.deepEqual(sqlTargets, [...TASK_TRANSITIONS[from]], `transitions from ${from}`);
  }
});

const task = (key: string, upstreamKeys: string[] = []) =>
  PlannedTask.parse({ key, title: key, discipline: "architecture", upstreamKeys });

test("topologicalOrder puts upstream tasks first", () => {
  const order = topologicalOrder([task("sch", ["pwr"]), task("pwr", ["arch"]), task("arch")]);
  assert.deepEqual(order, ["arch", "pwr", "sch"]);
});

test("topologicalOrder rejects cycles and unknown keys", () => {
  assert.throws(() => topologicalOrder([task("a", ["b"]), task("b", ["a"])]), /cycle/);
  assert.throws(() => topologicalOrder([task("a", ["missing"])]), /unknown task/);
});
