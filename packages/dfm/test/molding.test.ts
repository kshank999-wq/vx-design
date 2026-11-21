import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeMolding, moldingSheet, requiredDraft, toolSuggestion } from "../src/index.ts";

type P = [number, number, number];
/** Quads (corners counter-clockwise seen from outside) to triangles. */
const quads = (qs: P[][]) => qs.flatMap((q) => [[...q[0]!, ...q[1]!, ...q[2]!], [...q[0]!, ...q[2]!, ...q[3]!]]);
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, inward = false) {
  const q: P[][] = [
    [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]], [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]],
    [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [[x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]],
    [[x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]], [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]],
  ];
  return quads(inward ? q.map((x) => [...x].reverse()) : q);
}
/** An open-top cup 40 × 30 × 20 mm with 2 mm walls and floor. */
function cup() {
  const outer = box(0, 0, 0, 40, 30, 20).filter((_, i) => i !== 2 && i !== 3);   // drop the outer top
  const inner = box(2, 2, 2, 38, 28, 20.0001, true).filter((_, i) => i !== 2 && i !== 3);   // drop the inner top
  const rim: P[][] = [
    [[0, 0, 20], [40, 0, 20], [38, 2, 20], [2, 2, 20]], [[40, 0, 20], [40, 30, 20], [38, 28, 20], [38, 2, 20]],
    [[40, 30, 20], [0, 30, 20], [2, 28, 20], [38, 28, 20]], [[0, 30, 20], [0, 0, 20], [2, 2, 20], [2, 28, 20]],
  ];
  return [...outer, ...inner, ...quads(rim)];
}

test("a cup with vertical walls: no draft, no undercuts, 2 mm walls", () => {
  const a = analyzeMolding(cup(), "pc_abs", { finish: "MT-11010" });
  assert.equal(a.required_draft_deg, 2.5, "material 1° plus 1.5° for a light texture");
  assert.ok(a.zero_draft_pct > 40, `side walls have no draft: ${a.zero_draft_pct}%`);
  assert.equal(a.undercut_pct, 0);
  assert.equal(a.wall?.nominal_mm, 2);
  assert.ok(a.wall!.thick_pct < 5, "only the rim reads along the wall");
  assert.ok(!a.findings.some((f) => /thicker than/.test(f.text)));
  assert.ok(a.findings.some((f) => f.level === "error" && /no draft: add at least 2\.5°/.test(f.text)));
  assert.ok(Math.abs(a.projected_cm2 - 12) < 0.01, `projected area ${a.projected_cm2}`);
  assert.equal(a.shot_g, Math.round(a.volume_cm3 * 1.15 * 10) / 10);
});

test("a solid block is flagged thick; two stacked blocks are undercuts for a vertical pull, not a sideways one", () => {
  const solid = analyzeMolding(box(0, 0, 0, 20, 20, 20), "abs");
  assert.equal(solid.wall?.nominal_mm, 20);
  assert.ok(solid.findings.some((f) => /thicker than 3\.5 mm/.test(f.text)));
  const stacked = [...box(0, 0, 0, 10, 10, 3), ...box(0, 0, 6, 10, 10, 9)];
  assert.ok(analyzeMolding(stacked, "abs").undercut_pct > 20, "facing faces block each other along z");
  assert.equal(analyzeMolding(stacked, "abs", { pull: "+x" }).undercut_pct, 0, "pulled sideways they release");
});

test("tool suggestion and the mold maker's sheet", () => {
  assert.match(toolSuggestion(5000).tool, /Class 104/);
  assert.match(toolSuggestion(500_000).tool, /Class 101/);
  assert.equal(toolSuggestion(150_000).cavities, "2 to 4 cavities");
  assert.equal(requiredDraft("pp", "SPI-A2"), 1.5);
  const route = { name: "Front bezel", prototype_option: "fdm_asa", prototype_qty: 3, production_process: "injection_molding", production_material: "pc_abs",
                  production_volume: 5000, finish: "matte black", notes: null };
  const md = moldingSheet("Slate", "2026-11-21", route, { finish: "MT-11010", grade: "Cycoloy C2950 or equal", flammability: "UL94 V-0", critical_dims: "display opening 222.5 ± 0.1" },
    analyzeMolding(cup(), "pc_abs", { finish: "MT-11010" }), ["bezel.stl"]);
  assert.match(md, /^- \*\*Material:\*\* PC\/ABS, Cycoloy C2950 or equal, UL94 V-0$/m);
  assert.match(md, /mold finish MT-11010 \(light texture\)/);
  assert.match(md, /^- \*\*Suggested tool:\*\* SPI Class 104/m);
  assert.match(md, /^- \*\*Critical dimensions:\*\* display opening 222\.5 ± 0\.1$/m);
  assert.match(md, /^- \*\*Fix:\*\* .*no draft/m);
  assert.match(md, /^## Please quote$/m);
});
