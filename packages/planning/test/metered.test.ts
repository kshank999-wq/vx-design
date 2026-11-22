import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { MeteredModel, ModelOutputError, SpendStoppedError, usageCost, type AiCallEvent, type LanguageModel } from "../src/index.ts";

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

test("cache breakpoints only where a follow-up is expected: the opening message, then each repair round's latest", async () => {
  const { cacheBreakpoints } = await import("../src/index.ts");
  const msgs = [{ role: "user" as const, content: "big context" }, { role: "assistant" as const, content: [{ type: "thinking" as const, thinking: "", signature: "s" }, { type: "text" as const, text: "{}" }] },
                { role: "user" as const, content: "fix these problems" }];
  assert.deepEqual(cacheBreakpoints(msgs), msgs, "no hint: nothing cached");
  const one = cacheBreakpoints(msgs.slice(0, 1), "follow-up");
  assert.deepEqual(one[0]!.content, [{ type: "text", text: "big context", cache_control: { type: "ephemeral" } }]);
  const three = cacheBreakpoints(msgs, "follow-up");
  assert.deepEqual(three[2]!.content, [{ type: "text", text: "fix these problems", cache_control: { type: "ephemeral" } }]);
  assert.equal(three[1], msgs[1], "earlier assistant turns are left exactly as returned");
  const own = [{ role: "user" as const, content: [{ type: "text" as const, text: "ctx", cache_control: { type: "ephemeral" as const } }, { type: "text" as const, text: "q" }] }];
  assert.deepEqual(cacheBreakpoints(own, "follow-up"), own, "a caller's own breakpoint is kept as it is");
});

test("a guard stops a call before it is made; a guard that cannot run lets it through", async () => {
  let calls = 0;
  const inner: LanguageModel = { async generate() { calls++; return { output: { ok: true } as never, assistantMessage: { role: "assistant", content: "" }, usage }; } };
  const events: AiCallEvent[] = [];
  const req = { purpose: "chat", system: "", messages: [], schema: z.object({ ok: z.boolean() }) };
  const stopped = new MeteredModel(inner, (e) => { events.push(e); }, () => "the prepaid balance is used up ($0.00)");
  await assert.rejects(stopped.generate(req), (e: unknown) => e instanceof SpendStoppedError && /balance is used up/.test((e as Error).message));
  assert.equal(calls, 0);
  assert.equal(events.length, 0);
  await new MeteredModel(inner, () => {}, () => null).generate(req);
  await new MeteredModel(inner, () => {}, () => { throw new Error("database down"); }).generate(req);
  assert.equal(calls, 2);
});
