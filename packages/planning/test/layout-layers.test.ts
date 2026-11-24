import { test } from "node:test";
import assert from "node:assert/strict";
import { profileForLayers, requiredLayersFromNotes } from "../src/layout.ts";

test("layer requirement comes from the latest guidance that names one", () => {
  assert.equal(requiredLayersFromNotes([]), null);
  assert.equal(requiredLayersFromNotes(["Guidance from the owner/team: switch this board to 4 layers"]), 4);
  assert.equal(requiredLayersFromNotes(["use a 4-layer board", "actually go back to 2 layers"]), 2);
  assert.equal(requiredLayersFromNotes(["move U3 closer to J1"]), null);
});

test("profile for a layer count", () => {
  const p = [{ name: "jlcpcb-2layer-standard" }, { name: "jlcpcb-4layer-standard" }];
  assert.equal(profileForLayers(p, 4), "jlcpcb-4layer-standard");
  assert.equal(profileForLayers(p, 2), "jlcpcb-2layer-standard");
  assert.equal(profileForLayers(p, 6), null);
});
