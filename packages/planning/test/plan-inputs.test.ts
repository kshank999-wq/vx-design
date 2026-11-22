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
  assert.deepEqual(validatePlan(plan({ mode: "adapt", sources: ["PW-9"], reason: "r", concerns: [], alternatives: [] }), ["REQ-1"], ["PW-1"]).map((p) => p.code), ["unknown_source"]);
  assert.deepEqual(validatePlan(plan({ mode: "reuse", sources: [], reason: "r", concerns: [], alternatives: [] }), ["REQ-1"], ["PW-1"]).map((p) => p.code), ["basis_without_source"]);
  assert.deepEqual(validatePlan(plan({ mode: "adapt", sources: ["PW-1"], reason: "r", concerns: [], alternatives: [] }), ["REQ-1"], ["PW-1"]), []);
  assert.deepEqual(validatePlan(plan({ mode: "new", sources: [], reason: "nothing exists", concerns: [], alternatives: [] }), ["REQ-1"], ["PW-1"]), []);
});

test("offline plan builds on the inputs it is given", async () => {
  const pw = priorWorkFromFluxAudit("PW-1", "Flux audit #1", audit);
  const ctx = planContext({ project: { name: "Slate" }, references: [{ id: "REF-1", kind: "mockup", title: "Front", filename: "f.png" }], priorWork: [pw] });
  const reqs = [{ refCode: "REQ-FUN-001", kind: "functional", priority: "must", status: "confirmed", text: "Show timecode", acceptanceCriteria: "Readable at 3 m" }];
  const r = await generatePlan(reqs, new OfflineModel(), { projectContext: ctx.text, inputIds: ctx.sources.map((s) => s.id) });
  const by = new Map(r.tasks.map((t) => [t.key, t.basis]));
  assert.deepEqual(by.get("schematic"), { mode: "adapt", sources: ["PW-1"], reason: "Start from the prior design and re-check it (offline plan).", concerns: [], alternatives: [] });
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

test("manufacturing routes go to the planner", () => {
  const { text } = planContext({ project: { name: "X" }, routes: ["Enclosure base: prototype ASA (fdm) × 3; production Injection molding, PC/ABS"] });
  assert.match(text, /^Manufacturing routes \(prototype now, production later\)\. Design each part for its production process/m);
  assert.match(text, /^- Enclosure base: prototype ASA \(fdm\) × 3; production Injection molding, PC\/ABS$/m);
});

test("chosen parts and what changed since the last plan go to the planner; the offline plan designs around the parts", async () => {
  const { text, sources } = planContext({
    project: { name: "Slate" },
    parts: [{ id: "PT-1", mpn: "SIT5356AI", manufacturer: "SiTime", summary: "10 MHz Super-TCXO", subsystem: "timecode", status: "selected",
              role: "timecode reference", specs: [{ name: "Stability", value: "0.1 ppm" }], files: ["tcxo.pdf (datasheet)", "tcxo.step (3D model)"] }],
    changes: { version: 2, since: "2026-11-21T10:00:00Z", items: ["1 part added: PT-1 SIT5356AI"], tasks: [{ key: "architecture", title: "Architecture", stage: "S1", status: "done" }] },
  });
  assert.deepEqual(sources, [{ id: "PT-1", kind: "part", label: "SIT5356AI (SiTime)" }]);
  assert.match(text, /^- \[PT-1\] \(selected\) SIT5356AI \(SiTime\): 10 MHz Super-TCXO \[timecode\]$/m);
  assert.match(text, /^ {2}- used for: timecode reference$/m);
  assert.match(text, /^ {2}- specifications: Stability 0\.1 ppm$/m);
  assert.match(text, /^ {2}- files: tcxo\.pdf \(datasheet\), tcxo\.step \(3D model\)$/m);
  assert.match(text, /^Changed since the last plan \(version 2, made 2026-11-21\)\. This plan replaces it/m);
  assert.match(text, /^- 1 part added: PT-1 SIT5356AI$/m);
  assert.match(text, /^Tasks in plan version 2:\n- architecture: Architecture \[S1\] \(done\)$/m);
  const plan = await generatePlan([{ refCode: "REQ-FUN-001", kind: "functional", priority: "must", status: "confirmed", text: "Keep time." }], new OfflineModel(),
    { projectContext: text, inputIds: ["PT-1"], mustAddress: [{ id: "PT-1", label: "SIT5356AI" }] });
  assert.deepEqual(plan.tasks.find((t) => t.key === "architecture")?.basis?.sources, ["PT-1"]);
});

test("a revision works the changes into the existing plan: only affected tasks change, and the merged plan passes the same checks", async () => {
  const { revisePlan, applyRevision } = await import("../src/index.ts");
  const reqs = [
    { refCode: "REQ-FUN-001", kind: "functional", priority: "must", status: "confirmed", text: "Show timecode." },
    { refCode: "REQ-PWR-001", kind: "power", priority: "must", status: "confirmed", text: "Run 8 hours." },
  ];
  const first = await generatePlan(reqs, new OfflineModel());
  const prev = { version: 1, summary: first.summary, deferred: first.deferred, assumptions: first.assumptions,
    tasks: first.tasks.map((t) => ({ key: t.key, title: t.title, discipline: t.discipline, description: t.description ?? "", upstream_keys: t.upstreamKeys,
      requirement_refs: t.requirementRefs, acceptance_tests: t.acceptanceTests.map((a) => ({ description: a.description, method: a.method, validation_kind: a.validationKind ?? null })),
      risk_level: t.riskLevel, required_tools: t.requiredTools, approval_required: t.approvalRequired, approval_reason: t.approvalReason ?? null,
      estimated_hours: t.estimatedHours ?? null, basis: t.basis ?? null })) };
  const more = [...reqs, { refCode: "REQ-FUN-002", kind: "functional", priority: "must", status: "confirmed", text: "Read SD cards." }];
  const r = await revisePlan(prev, more, new OfflineModel(), { changes: ["1 part added: PT-1 DM1AA"], inputIds: ["PT-1"], mustAddress: [{ id: "PT-1", label: "DM1AA" }] });
  assert.equal(r.promptVersion, "plan-revise-v1");
  assert.deepEqual(r.revision, { from_version: 1, changed: ["architecture"], added: [], removed: [], new_requirements: 1 });
  const arch = r.tasks.find((t) => t.key === "architecture")!;
  assert.ok(arch.requirementRefs.includes("REQ-FUN-002"));
  assert.deepEqual(arch.basis?.sources, ["PT-1"]);
  assert.equal(r.tasks.length, first.tasks.length, "nothing else added or dropped");
  assert.deepEqual({ ...r.tasks.find((t) => t.key === "schematic"), basis: null }, first.tasks.find((t) => t.key === "schematic"), "unaffected tasks are kept as they were");
  assert.equal(r.tasks.find((t) => t.key === "schematic")?.basis?.mode, "new");
  // Removing a task drops links to it; requirements no longer active are dropped from tasks.
  const m = applyRevision(prev, { summary: "s", changed_tasks: [], removed_tasks: [{ key: "enclosure-envelope", reason: "merged" }], deferred_requirements: [], assumptions: [] }, ["REQ-FUN-001"]);
  assert.equal(m.plan.tasks.some((t) => t.key === "enclosure-envelope"), false);
  assert.equal(m.plan.tasks.some((t) => t.upstream_keys.includes("enclosure-envelope")), false);
  assert.ok(m.adjustments.some((a) => /dropped requirement\(s\) no longer active: REQ-PWR-001/.test(a)));
});
