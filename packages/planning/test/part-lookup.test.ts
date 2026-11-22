import { test } from "node:test";
import assert from "node:assert/strict";
import { identityFromRecord, partNumberCandidates } from "../src/index.ts";

test("part numbers from the datasheet's labels, file name and package name, kept only when the datasheet confirms them", () => {
  const sheet = "USB 3.1 Type-C receptacle\nOrdering information\n10164227-1001A1RLF   mid-mount, 16 positions\nRev 5  2024-03-11  Page 1 of 9";
  assert.deepEqual(partNumberCandidates(sheet, "10164227.pdf", "Amphenol 10164227-1001A1RLF"), ["10164227-1001A1RLF"]);
  // A drawing named after the ordering code with a suffix the text writes without it.
  const drawing = "MICRO SD CARD CONNECTOR  DM1AA-SF-PEJ(82)  CL0609-0004-8-82  SCALE 5:1";
  assert.deepEqual(partNumberCandidates(drawing, "DM1AA-SF-PEJ(82)_CL06090004882_2d.pdf", "HIROSE SD CARD READER"), ["DM1AA-SF-PEJ(82)", "DM1AA-SF-PEJ", "CL06090004882"]);
  // A labelled code wins; a name the text never mentions is not taken; dates, revisions and units are not part numbers.
  const labelled = "GL3224 USB 3.0 card reader controller\nPart Number: GL3224-OIY50\nRev 1.06 2019 3.3V 48MHz";
  assert.deepEqual(partNumberCandidates(labelled, "DATA SHEET.pdf", "Genesys GL3224 Rev1.06 2019"), ["GL3224-OIY50", "GL3224"]);
  assert.deepEqual(partNumberCandidates("Readme for the 3D model", "Readme.pdf", "XYZ-12345"), []);
});

test("a distributor record becomes a part: its own number, maker, description, specifications, package and lifecycle", () => {
  const id = identityFromRecord({ mpn: "10164227-1001A1RLF", manufacturer: "Amphenol ICC (FCI)", description: "USB-C (USB TYPE-C) USB 3.2 Gen 2 (USB 3.1 Gen 2, Superspeed + (USB 3.1)) Receptacle Connector 24 (16+8 Dummy) Position Surface Mount, Right Angle; Through Hole",
    package: null, lifecycle: "active", specs: { "Current Rating (Amps)": "5A", "Mounting Type": "Surface Mount, Right Angle; Through Hole", Shielding: "Shielded", Empty: "", Dash: "-" } });
  assert.equal(id.mpn, "10164227-1001A1RLF");
  assert.equal(id.subsystem, "connectors_cabling");
  assert.deepEqual(id.specs.map((s) => s.name), ["Current Rating (Amps)", "Mounting Type", "Shielding", "Lifecycle"]);
  assert.deepEqual(identityFromRecord({ mpn: "AP2112K-3.3TRG1", manufacturer: "Diodes", description: "LDO regulator 3.3V 600mA", package: "SOT-23-5", specs: {} }).specs, [{ name: "Package", value: "SOT-23-5" }]);
});
