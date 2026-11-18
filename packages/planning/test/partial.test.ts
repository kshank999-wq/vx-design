import { test } from "node:test";
import assert from "node:assert/strict";
import { partialStringField } from "../src/llm/partial.ts";

test("reads a string field as it arrives", () => {
  const full = JSON.stringify({ answer: "Two tasks wait for you:\n• \"Layout\" — approve\tnow 😀", references: [] });
  let last = "";
  for (let n = 0; n <= full.length; n++) {
    const got = partialStringField(full.slice(0, n), "answer");
    if (got == null) { assert.equal(last, ""); continue; }
    assert.ok(got.startsWith(last), `grows monotonically at ${n}: ${JSON.stringify(last)} → ${JSON.stringify(got)}`);
    last = got;
  }
  assert.equal(last, "Two tasks wait for you:\n• \"Layout\" — approve\tnow 😀");
  assert.equal(partialStringField('{"refs": [], "answer" : "hi', "answer"), "hi");
  assert.equal(partialStringField('{"answ', "answer"), null);
  assert.equal(partialStringField('{"answer": "a\\', "answer"), "a");
  assert.equal(partialStringField('{"answer": "a\\u00', "answer"), "a");
});
