import { test } from "node:test";
import assert from "node:assert/strict";
import { fitsBuildVolumes, massEstimate, needsFromRequirements, optionByKey, printSettings, printSheet, stlStats, suggestPrototypes } from "../src/index.ts";

test("suggestions follow what the part needs and the production material", () => {
  const outdoor = suggestPrototypes({ outdoor: true, impact: true }, { process: "injection_molding", material: "pc_abs" });
  assert.ok(outdoor.length > 0 && outdoor.length <= 4);
  assert.ok(!outdoor.some((s) => s.option.key === "fdm_pla" || s.option.key === "sla_standard"), "sun-sensitive, brittle options are not suggested");
  assert.ok(outdoor[0]!.option.uv >= 4, `top suggestion is UV stable: ${outdoor[0]!.option.key}`);
  assert.ok(outdoor.every((s) => s.reasons.length + s.cautions.length > 0));
  const hot = suggestPrototypes({ max_temp_c: 80 });
  assert.ok(hot.every((s) => s.option.heat_c >= 90), "heat below the part's maximum (plus margin) rules an option out");
  assert.ok(suggestPrototypes({ flexible: true }).every((s) => s.option.rubber));
  assert.ok(suggestPrototypes({ clear: true }).every((s) => s.option.clear));
  const pilot = suggestPrototypes({ cosmetic: true, quantity: 30 }, { process: "injection_molding", material: "abs" });
  assert.equal(pilot[0]!.option.process, "urethane_cast", "a pilot batch that must look molded: cast urethane");
  assert.match(pilot[0]!.reasons.join("; "), /economical for 30 parts/);
  const quick = suggestPrototypes({});
  assert.equal(quick[0]!.option.process, "fdm", "nothing special: cheapest and fastest first");
});

test("needs are read from requirement text", () => {
  const n = needsFromRequirements(["The slate shall operate from -10 °C to 50 °C in direct sunlight.", "It shall survive a 1.2 m drop onto concrete."]);
  assert.equal(n.outdoor, true);
  assert.equal(n.impact, true);
  assert.equal(n.max_temp_c, 50);
  assert.deepEqual(needsFromRequirements(["Show timecode."]), { outdoor: undefined, max_temp_c: null, impact: undefined, snap_fits: undefined, cosmetic: undefined });
});

// A 10 × 20 × 30 mm box as 12 triangles.
function box(ascii: boolean) {
  const v = [[0, 0, 0], [10, 0, 0], [10, 20, 0], [0, 20, 0], [0, 0, 30], [10, 0, 30], [10, 20, 30], [0, 20, 30]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  if (ascii) return new TextEncoder().encode(`solid b\n${f.map((t) => `facet normal 0 0 0\nouter loop\n${t.map((i) => `vertex ${v[i]!.join(" ")}`).join("\n")}\nendloop\nendfacet`).join("\n")}\nendsolid b\n`);
  const buf = new ArrayBuffer(84 + f.length * 50); const dv = new DataView(buf);
  dv.setUint32(80, f.length, true);
  f.forEach((t, i) => t.forEach((vi, k) => v[vi]!.forEach((c, a) => dv.setFloat32(84 + i * 50 + 12 + (k * 3 + a) * 4, c, true))));
  return new Uint8Array(buf);
}

test("STL size, volume, build-volume fit and material estimate", () => {
  for (const ascii of [true, false]) {
    const s = stlStats(box(ascii));
    assert.deepEqual(s, { triangles: 12, size_mm: [10, 20, 30], volume_cm3: 6 });
  }
  assert.throws(() => stlStats(new TextEncoder().encode("hello")), /not an STL/);
  const fit = fitsBuildVolumes([300, 100, 50]);
  assert.equal(fit.find((f) => f.process === "fdm")!.fits, false);
  assert.equal(fit.find((f) => f.process === "sls_mjf")!.fits, true);
  assert.deepEqual(massEstimate(optionByKey("fdm_petg")!, 10), [8, 11]);
  assert.deepEqual(massEstimate(optionByKey("mjf_pa12")!, 10), [10, 10]);
  assert.match(printSettings(optionByKey("fdm_asa")!).lines.join("\n"), /Enclosed printer/);
});

test("print sheet: material, settings, size, estimate and what the print stands in for", () => {
  const route = { name: "Enclosure base", prototype_option: "fdm_asa", prototype_qty: 3, production_process: "injection_molding", production_material: "pc_abs",
                  production_volume: 5000, finish: "matte black", notes: null };
  const { markdown, csv } = printSheet("Slate", "2026-11-21", [
    { folder: "01-enclosure-base", route, files: ["enclosure-base.stl", "enclosure-base.step"], stats: { triangles: 12, size_mm: [10, 20, 30], volume_cm3: 6 } },
    { folder: "02-button", route: { ...route, name: "Button, \"big\"", prototype_option: "sla_standard", production_material: "pc_abs", finish: null }, files: [], stats: null },
  ]);
  assert.match(markdown, /^## Enclosure base$/m);
  assert.match(markdown, /^- \*\*Print in:\*\* ASA, 3D printing, FDM \(filament\)$/m);
  assert.match(markdown, /^- \*\*Material per part \(estimate\):\*\* 4 to 6 g$/m);
  assert.match(markdown, /Injection molding in PC\/ABS\. This print is a fair stand-in/);
  assert.match(markdown, /^- Enclosed printer, no drafts/m);
  assert.match(markdown, /strength, drop and heat results will not carry over/);
  assert.equal(csv.split("\n")[1], "Enclosure base,enclosure-base.stl enclosure-base.step,fdm,ASA,3,matte black,10x20x30,6,4-6");
  assert.match(csv, /^"Button, ""big""",/m);
});
