import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdits, extractPriorWork, mergeRegister, registerText, splitDocument, validatePlan, type ExtractedItem, type LanguageModel, type PlanOutput } from "../src/index.ts";

const item = (o: Partial<ExtractedItem> & { file: string; part?: number }) => ({
  subsystem: "display" as const, kind: "part" as const, title: "10.1-inch display", detail: "IPS panel", mpn: "RVT101HVHNWC00-B", manufacturer: "Riverdi",
  status: "considered" as const, issues: [] as string[], quote: "Riverdi RVT101HVHNWC00-B", origin: "flux", ...o,
});

test("long documents are split at headings, newest first", () => {
  const doc = `# Study\n\n## Rev0.3 newest\n${"a".repeat(600)}\n\n## Rev0.2\n${"b".repeat(600)}\n\n## Rev0.1\n${"c".repeat(600)}`;
  const parts = splitDocument(doc, 1000);
  assert.ok(parts.length >= 2);
  assert.match(parts[0]!, /Rev0\.3 newest/);
  assert.equal(parts.join(""), doc, "nothing is lost");
  assert.deepEqual(splitDocument("short", 1000), ["short"]);
});

test("extraction keeps only items quoted word for word, and tells the model which part is newest", async () => {
  const seen: string[] = [];
  const model: LanguageModel = { async generate(req) {
    seen.push(String(req.messages[0]!.content));
    assert.equal(req.effort, "medium");
    return { output: { items: [
      { ...item({ file: "x" }), quote: "the Riverdi   RVT101HVHNWC00-B is retained" },
      { ...item({ file: "x" }), title: "invented", quote: "not in the document at all" },
    ] } as never, assistantMessage: { role: "assistant", content: "" }, usage: { model: "m", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } };
  } };
  const r = await extractPriorWork({ file: "Display Study.md", origin: "Flux audit #3", text: "## Rev0.2\nThe Riverdi RVT101HVHNWC00-B is retained for the display.", note: "selected by Ken" }, model);
  assert.equal(r.items.length, 1);
  assert.equal(r.dropped, 1);
  assert.match(seen[0]!, /^DOCUMENT: Display Study\.md \(Flux audit #3\)\nNOTE FROM THE OWNER: selected by Ken/);
});

test("merging: duplicates join; a rejection wins; owner-stated parts override and are added", () => {
  const reg = mergeRegister([
    item({ file: "Display Study.md", status: "selected", issues: ["frame freeze blocked"] }),
    item({ file: "Mechanical.md", status: "considered", issues: ["cable length open"] }),
    item({ file: "Old.md", subsystem: "timecode", mpn: "DS3231", title: "RTC", status: "considered" }),
    item({ file: "Basis.md", subsystem: "timecode", mpn: "DS3231", title: "RTC", status: "rejected" }),
    item({ file: "Basis.md", subsystem: "timecode", mpn: "SIT5356AI-FQ-33E0-10.000000", title: "TCXO", status: "designed" }),
    item({ file: "Basis.md", subsystem: "timecode", mpn: "SiT5356AI-FQ-33E0-10.000000", title: "TCXO", status: "considered", part: 1 }),
  ], [
    { mpn: "CM5104032", manufacturer: "Raspberry Pi", role: "Compute module", subsystem: "compute", status: "selected", note: null, files: ["cm5.pdf"] },
    { mpn: "RVT101HVHNWC00-B", manufacturer: "Riverdi", role: "Front touchscreen", subsystem: "display", status: "selected", note: "ordered samples", files: [] },
  ]);
  const by = (mpn: string) => reg.find((r) => r.mpn?.toUpperCase().replace(/[^A-Z0-9]/g, "") === mpn.replace(/[^A-Z0-9]/g, ""))!;
  const disp = by("RVT101HVHNWC00B");
  assert.equal(disp.status, "selected");
  assert.equal(disp.stated_by_owner, true);
  assert.deepEqual(disp.issues, ["frame freeze blocked", "cable length open"]);
  assert.equal(disp.sources.length, 3);
  assert.equal(by("DS3231").status, "rejected");
  assert.equal(by("SIT5356AIFQ33E010000000").status, "designed", "within a document the newest part decides");
  assert.equal(by("CM5104032").title, "Compute module");
  assert.deepEqual(reg.map((r) => r.id), reg.map((_, i) => `PR-${i + 1}`));
  assert.ok(reg.findIndex((r) => r.subsystem === "display") < reg.findIndex((r) => r.subsystem === "compute"), "grouped by subsystem in a fixed order");

  const edited = applyEdits(reg, { [by("DS3231").id]: { excluded: true }, [by("CM5104032").id]: { status: "designed", note: "carrier schematic done" } });
  assert.ok(!edited.some((r) => r.mpn === "DS3231"));
  const cm5 = edited.find((r) => r.mpn === "CM5104032")!;
  assert.equal(cm5.status, "designed");
  assert.match(cm5.detail, /\[Owner: carrier schematic done\]$/);
  const text = registerText(edited);
  assert.match(text, /^Earlier-work register/);
  assert.match(text, /^display:\n {2}- \[PR-\d+\] \(selected, owner\) part: RVT101HVHNWC00-B \(Riverdi\) — 10\.1-inch display\. Front touchscreen\. ordered samples\. IPS panel\. Issues: frame freeze blocked; cable length open\.$/m);
});

const plan = (basis: PlanOutput["tasks"][number]["basis"]): PlanOutput => ({
  summary: "s", deferred_requirements: [], assumptions: [],
  tasks: [{ key: "display", title: "Display integration", discipline: "components", description: "", upstream_keys: [], requirement_refs: ["REQ-1"],
            acceptance_tests: [{ description: "fit", method: "human_review", validation_kind: null }], risk_level: "medium", required_tools: [],
            approval_required: false, approval_reason: null, estimated_hours: 2, basis }],
});

test("the plan must address committed earlier work, and a replacement needs concerns and alternatives", () => {
  const must = [{ id: "PR-1", label: "RVT101HVHNWC00-B display (selected)" }, { id: "PR-2", label: "CM5104032 (selected)" }];
  const ids = ["PR-1", "PR-2", "PW-1"];
  const keep = { mode: "reuse" as const, sources: ["PR-1"], reason: "keep the display", concerns: [], alternatives: [] };
  assert.deepEqual(validatePlan(plan(keep), ["REQ-1"], ids, must).map((p) => p.code), ["prior_work_ignored"]);
  assert.match(validatePlan(plan(keep), ["REQ-1"], ids, must)[0]!.message, /PR-2 CM5104032 \(selected\)/);
  assert.deepEqual(validatePlan(plan({ ...keep, sources: ["PR-1", "PR-2"] }), ["REQ-1"], ids, must), []);
  assert.deepEqual(validatePlan(plan({ mode: "replace", sources: ["PR-1", "PR-2"], reason: "r", concerns: [], alternatives: [] }), ["REQ-1"], ids, must).map((p) => p.code), ["replace_without_reason"]);
  assert.deepEqual(validatePlan(plan({ mode: "replace", sources: ["PR-1", "PR-2"], reason: "r", concerns: ["EOL"], alternatives: ["RVT101HVHNWC00-C: same panel, current"] }), ["REQ-1"], ids, must), []);
});
