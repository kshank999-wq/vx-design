import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkDocument, EXCERPT_HARD_LIMIT } from "../src/ingest/chunks.ts";
import { buildDocument } from "../src/ingest/document.ts";
import { parseText } from "../src/ingest/parsers.ts";

test("excerpts stay inside a section and cite it", () => {
  const doc = parseText("# Note\n\n## 1. Layout\n\n### 1.2 Guard rings\n\nSurround the crystal.\n\nKeep switchers away.\n\n## 2. Power\n\nCharge between 0 and 45 C.");
  const ex = chunkDocument(doc);
  assert.deepEqual(ex.map((e) => e.locator), ["§1.2 Guard rings", "§2 Power"]);
  assert.equal(ex[0]!.text, "Surround the crystal.\nKeep switchers away.");
  assert.equal(ex[0]!.section_path, "Layout > Guard rings");
  assert.deepEqual(ex[0]!.block_ids, ["S1.2.p1", "S1.2.p2"]);
  assert.deepEqual(ex.map((e) => e.ordinal), [1, 2]);
});

test("long sections split near the size limit; page ranges in the locator", () => {
  const sentence = "The guard ring is tied to ground at one point near the oscillator.";
  const items = [
    { type: "heading" as const, text: "3 Clearances", level: 1 },
    ...Array.from({ length: 30 }, (_, i) => ({ type: "block" as const, kind: "paragraph" as const, text: `${i}. ${sentence}`, page: 4 + Math.floor(i / 10) })),
  ];
  const ex = chunkDocument(buildDocument(items, "x", "application/pdf"), { maxChars: 500 });
  assert.ok(ex.length > 3);
  assert.ok(ex.every((e) => e.text.length <= 500));
  assert.equal(ex[0]!.locator, "§3 Clearances, p. 4");
  assert.ok(ex.some((e) => /p\. 4–5|p\. 5–6/.test(e.locator)), "an excerpt spanning a page break shows the range");
  assert.equal(ex.map((e) => e.text).join("\n").split("\n").length, 30, "no text lost or duplicated");
});

test("one huge paragraph is split at sentences and never exceeds the database limit", () => {
  const big = Array.from({ length: 400 }, (_, i) => `Sentence ${i} about thermal relief on pads.`).join(" ");
  const ex = chunkDocument(buildDocument([{ type: "heading", text: "Body", level: 1 }, { type: "block", kind: "paragraph", text: big }], big, "text/plain"),
    { maxChars: 99_999 });
  assert.ok(ex.every((e) => e.text.length <= EXCERPT_HARD_LIMIT));
  assert.equal(ex.map((e) => e.text).join(" "), big);
  assert.ok(ex.every((e) => e.text.endsWith(".")), "splits at sentence ends");
});
