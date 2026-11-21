import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePlan, OfflineModel, planContext, priorWorkFromFluxAudit, validatePlan, type FluxAuditLike, type PlanOutput } from "../src/index.ts";

const audit: FluxAuditLike = {
  current: {
    revision: "2026-11-20",
    components: [
      { designator: "C1", mpn: null, manufacturer: null, value: "100nF", design: { role: "Decoupling", details: "U1 VDD pin 19" } },
      { designator: "C3", mpn: null, manufacturer: null, value: "100nF", design: { role: "Decoupling", details: "U1 VDD pin 32" } },
      { designator: "U1", mpn: "STM32L476RGT6", manufacturer: "STMicroelectronics", value: null, design: { role: "Timecode MCU", details: "Autonomous LTC" } },
      { designator: "C9", mpn: "X", manufacturer: null, value: null, dnp: true },
    ],
    connectors: [{ designator: "J1", mpn: "FTSH-105-01-L-DV-007-K", pins: [1, 2, 3, 4, 5, 6] }],
    power_rails: [{ net: "GND" }, { net: "TC_3V3" }],
    board: { width_mm: 160, height_mm: 100, thickness_mm: 1.46, copper_layers: 4 },
  },
  findings: [
    { severity: "warning", title: "The layout is not routed", category: "routing" },
    { severity: "info", title: "Layout connectivity matches the schematic netlist", category: "connectivity" },
    { severity: "warning", title: "18 part(s) without a manufacturer part number", category: "sourcing" },
  ],
  history: { decisions: [{ statement: "Use a TCXO for the timecode clock", quote: "10 MHz TCXO", file: "flux.zip!/notes/addendum.md" }], claims: [{ claim: "ERC clean", status: "unverifiable" }] },
  migration: [{ title: "Route the board", scope: "The parts are placed but no copper is routed." }],
};

test("plan context: prior work and references with ids, grouped parts, unverified history", () => {
  const pw = priorWorkFromFluxAudit("PW-1", "Flux audit #1: VC Smart Slate", audit);
  assert.equal(pw.routed, false);
  assert.equal(pw.parts.length, 3, "do-not-fit parts are left out");
  const { text, sources } = planContext({
    project: { name: "VC Smart Slate", description: "Touchscreen slate" },
    intake: { quantity: 50, target_cost: null }, freeze: { envelope: "220 × 140 × 28 mm", cmf: "anodised aluminium" },
    references: [{ id: "REF-1", kind: "mockup", title: "Front view", note: "Screen 7 in", filename: "front.png" }],
    priorWork: [pw],
  });
  assert.deepEqual(sources.map((s) => s.id), ["REF-1", "PW-1"]);
  assert.match(text, /^Project: VC Smart Slate — Touchscreen slate$/m);
  assert.match(text, /^- quantity: 50$/m);
  assert.doesNotMatch(text, /target cost/);
  assert.match(text, /^- envelope: 220 × 140 × 28 mm$/m);
  assert.match(text, /^- \[REF-1\] Front view \(mockup, file front\.png\): Screen 7 in$/m);
  assert.match(text, /^Prior work \[PW-1\] Flux audit #1: VC Smart Slate, revision 2026-11-20 \(imported; nothing in it is verified\):$/m);
  assert.match(text, /^- board: 160 × 100 mm, 1\.46 mm thick, 4 copper layers; parts placed but NOT routed$/m);
  assert.match(text, /^ {2}- C1, C3: 100nF, no part number chosen — Decoupling: U1 VDD pin 19$/m, "same value and role on one line");
  assert.match(text, /^ {2}- U1: STM32L476RGT6 \(STMicroelectronics\) — Timecode MCU: Autonomous LTC$/m);
  assert.match(text, /^- connectors: J1 FTSH-105-01-L-DV-007-K \(6 pins\)$/m);
  assert.match(text, /^ {2}- Use a TCXO for the timecode clock \(addendum\.md\)$/m);
  assert.match(text, /^ {2}- warning: The layout is not routed$/m);
  assert.doesNotMatch(text, /info: Layout connectivity/, "info findings are not open problems");
  assert.equal(planContext({ project: { name: "X" } }).text, "Project: X", "nothing to add, nothing added");
});

const plan = (basis: PlanOutput["tasks"][number]["basis"]): PlanOutput => ({
  summary: "s", deferred_requirements: [], assumptions: [],
  tasks: [{ key: "sch", title: "Schematic", discipline: "schematic", description: "", upstream_keys: [], requirement_refs: ["REQ-1"],
            acceptance_tests: [{ description: "ERC", method: "validation", validation_kind: "erc" }], risk_level: "medium", required_tools: [],
            approval_required: false, approval_reason: null, estimated_hours: 2, basis }],
});

test("basis is required when there is something to build on, and must cite real inputs", () => {
  assert.deepEqual(validatePlan(plan(null), ["REQ-1"], []), [], "no inputs: no basis needed");
  assert.deepEqual(validatePlan(plan(null), ["REQ-1"], ["PW-1"]).map((p) => p.code), ["no_basis"]);
  assert.deepEqual(validatePlan(plan({ mode: "adapt", sources: ["PW-9"], reason: "r" }), ["REQ-1"], ["PW-1"]).map((p) => p.code), ["unknown_source"]);
  assert.deepEqual(validatePlan(plan({ mode: "reuse", sources: [], reason: "r" }), ["REQ-1"], ["PW-1"]).map((p) => p.code), ["basis_without_source"]);
  assert.deepEqual(validatePlan(plan({ mode: "adapt", sources: ["PW-1"], reason: "r" }), ["REQ-1"], ["PW-1"]), []);
  assert.deepEqual(validatePlan(plan({ mode: "new", sources: [], reason: "nothing exists" }), ["REQ-1"], ["PW-1"]), []);
});

test("offline plan builds on the inputs it is given", async () => {
  const pw = priorWorkFromFluxAudit("PW-1", "Flux audit #1", audit);
  const ctx = planContext({ project: { name: "Slate" }, references: [{ id: "REF-1", kind: "mockup", title: "Front", filename: "f.png" }], priorWork: [pw] });
  const reqs = [{ refCode: "REQ-FUN-001", kind: "functional", priority: "must", status: "confirmed", text: "Show timecode", acceptanceCriteria: "Readable at 3 m" }];
  const r = await generatePlan(reqs, new OfflineModel(), { projectContext: ctx.text, inputIds: ctx.sources.map((s) => s.id) });
  const by = new Map(r.tasks.map((t) => [t.key, t.basis]));
  assert.deepEqual(by.get("schematic"), { mode: "adapt", sources: ["PW-1"], reason: "Start from the prior design and re-check it (offline plan)." });
  assert.deepEqual(by.get("enclosure-envelope")?.sources, ["REF-1"]);
  assert.equal(by.get("power-budget")?.mode, "new");
  const bare = await generatePlan(reqs, new OfflineModel(), {});
  assert.ok(bare.tasks.every((t) => t.basis === null), "without inputs the offline plan states no basis");
});

test("a reply cut off at the token limit says so, with the budget used", async () => {
  const { ClaudeModel } = await import("../src/llm/model.ts");
  const { z } = await import("zod");
  let asked = 0;
  const client = { beta: { messages: { stream: (body: { max_tokens: number }) => {
    asked = body.max_tokens;
    return { on() {}, finalMessage: async () => { throw new Error("Failed to parse structured output: SyntaxError: Unterminated string in JSON at position 67900"); } };
  } } } };
  const m = new ClaudeModel({ client: client as never });
  await assert.rejects(m.generate({ purpose: "generate_plan", system: "s", messages: [{ role: "user", content: "x" }], schema: z.object({}), maxTokens: 128000 }),
    /generate_plan: the reply was cut off at the 128000-token limit \(the model's reasoning and its answer share it\)/);
  assert.equal(asked, 128000, "the call's own budget is used");
});
