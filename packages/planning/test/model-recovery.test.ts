import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { ClaudeModel, parseJsonReply } from "../src/llm/model.ts";

const Out = z.object({ rails: z.array(z.object({ name: z.string(), v: z.number() })) });
const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

function fakeClient(replies: Array<(params: any) => any>) {
  const seen: any[] = [];
  const client = { beta: { messages: { stream: (params: any) => {
    seen.push(params);
    const r = replies.shift()!;
    return { on() {}, finalMessage: async () => r(params) };
  } } } };
  return { client: client as any, seen };
}

test("a schema too large for constrained decoding is asked again with the schema in the instructions", async () => {
  const { client, seen } = fakeClient([
    () => { throw new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"The compiled grammar is too large, which would cause performance issues."}}'); },
    () => ({ model: "m", usage, stop_reason: "end_turn", content: [{ type: "text", text: '```json\n{"rails":[{"name":"3V3","v":3.3}]}\n```' }] }),
  ]);
  const r = await new ClaudeModel({ client }).generate({ purpose: "power_tree", system: "S", messages: [{ role: "user", content: "x" }], schema: Out });
  assert.deepEqual(r.output, { rails: [{ name: "3V3", v: 3.3 }] });
  assert.ok(seen[0].output_config.format, "first try constrained");
  assert.equal(seen[1].output_config.format, undefined, "second try without the grammar");
  assert.match(seen[1].system[0].text, /must match this JSON Schema exactly/);
});

test("a reply that does not match the schema in the fallback is an error, not bad data", async () => {
  const { client } = fakeClient([
    () => { throw new Error("400 compiled grammar is too large"); },
    () => ({ model: "m", usage, stop_reason: "end_turn", content: [{ type: "text", text: '{"rails":[{"name":"3V3"}]}' }] }),
  ]);
  await assert.rejects(new ClaudeModel({ client }).generate({ purpose: "p", system: "S", messages: [{ role: "user", content: "x" }], schema: Out }), /did not match the expected format/);
});

test("a cut-off reply is asked again once with the full output and less effort; both attempts are billed", async () => {
  const { client, seen } = fakeClient([
    () => ({ model: "m", usage, stop_reason: "max_tokens", content: [] }),
    () => ({ model: "m", usage, stop_reason: "end_turn", content: [], parsed_output: { rails: [] } }),
  ]);
  const r = await new ClaudeModel({ client, effort: "high" }).generate({ purpose: "simulation", system: "S", messages: [{ role: "user", content: "x" }], schema: Out });
  assert.deepEqual(r.output, { rails: [] });
  assert.deepEqual([seen[0].max_tokens, seen[0].output_config.effort], [64000, "high"]);
  assert.deepEqual([seen[1].max_tokens, seen[1].output_config.effort], [128000, "medium"]);
  assert.equal(r.usage.outputTokens, 10);
});

test("JSON is found around prose", () => {
  assert.deepEqual(parseJsonReply('Here it is: {"a":1} done'), { a: 1 });
  assert.equal(parseJsonReply("no json"), undefined);
});
