import { test } from "node:test";
import assert from "node:assert/strict";
import { digestTask, OfflineModel, renderDigestPrompt, TaskDigest } from "../src/index.ts";

const input = {
  project: "Timecode slate",
  task: { title: "Power tree and budget", discipline: "power", description: "Size the battery." },
  summary: "Power tree: 3 rails, 41 mA average.",
  checks: [{ kind: "power_budget", result: "pass", summary: "Runtime 14.2 h meets 12 h" }],
  outputs: [{ name: "power-budget/report", text: "# Budget\n" + "x".repeat(10_000) }],
  answered: [{ question: "Which markets first?", answer: "US only" }],
};

test("the digest prompt carries the checks, trimmed outputs and earlier answers", () => {
  const p = renderDigestPrompt(input);
  assert.match(p, /Finished step: Power tree and budget \(power\)/);
  assert.match(p, /- pass: Runtime 14\.2 h meets 12 h/);
  assert.match(p, /Which markets first\? → US only/);
  assert.ok(p.length < 9_000, "a long output is trimmed");
});

test("offline digest is labelled as a stand-in and asks nothing", async () => {
  const { digest, usage } = await digestTask(input, new OfflineModel());
  assert.match(digest.summary, /^Offline stand-in, not AI: "Power tree and budget" is finished/);
  assert.deepEqual(digest.questions, []);
  assert.equal(usage.outputTokens >= 0, true);
});

test("at most three questions", () => {
  const q = { question: "Colour?", why: "Looks", recommendation: "Black", options: ["Black", "White"] };
  assert.equal(TaskDigest.safeParse({ summary: "ok", questions: [q, q, q] }).success, true);
  assert.equal(TaskDigest.safeParse({ summary: "ok", questions: [q, q, q, q] }).success, false);
});

test("the look of the frozen design is described from its image (offline stand-in labelled)", async () => {
  const { describeLook } = await import("../src/index.ts");
  const { look } = await describeLook({ project: "Slate", name: "Mock-up REF-1", note: null, cmf: "matte black",
    image: { bytes: new Uint8Array([137, 80, 78, 71]), mime: "image/png" } }, new OfflineModel());
  assert.match(look.description, /^Offline stand-in, not AI/);
});
