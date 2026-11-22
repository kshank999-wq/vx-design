import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { MeteredModel, ModelOutputError, usageCost, type AiCallEvent, type LanguageModel } from "../src/index.ts";

const usage = { model: "claude-opus-5-5", inputTokens: 100_000, outputTokens: 50_000, cacheReadTokens: 200_000, cacheWriteTokens: 4_000 };

test("price table: Opus 5.5 at $4 in, $20 out, $0.20 cache read, $5 cache write per million; unknown models fail safe", () => {
  assert.equal(usageCost(usage).toFixed(4), (0.4 + 1.0 + 0.04 + 0.02).toFixed(4));
  assert.ok(usageCost({ ...usage, model: "claude-future-9" }) > usageCost(usage));
  assert.equal(usageCost({ ...usage, model: "offline-heuristic" }), 0);
});

test("every call is recorded, a billed failure too, and a failing sink never fails the work", async () => {
  const events: AiCallEvent[] = [];
  let fail = false;
  const inner: LanguageModel = { async generate() {
    if (fail) throw new ModelOutputError("plan: the reply was cut off", usage);
    return { output: { ok: true } as never, assistantMessage: { role: "assistant", content: "" }, usage };
  } };
  const m = new MeteredModel(inner, (e) => { events.push(e); });
  await m.generate({ purpose: "generate_plan", system: "", messages: [], schema: z.object({ ok: z.boolean() }) });
  fail = true;
  await assert.rejects(m.generate({ purpose: "repair_plan", system: "", messages: [], schema: z.object({ ok: z.boolean() }) }), /cut off/);
  assert.deepEqual(events.map((e) => [e.purpose, e.failed, e.costUsd.toFixed(2)]), [["generate_plan", false, "1.46"], ["repair_plan", true, "1.46"]]);
  assert.ok(events.every((e) => e.durationMs >= 0));
  fail = false;
  const broken = new MeteredModel(inner, () => { throw new Error("database down"); });
  const r = await broken.generate({ purpose: "x", system: "", messages: [], schema: z.object({ ok: z.boolean() }) });
  assert.equal(r.usage.model, "claude-opus-5-5");
});
