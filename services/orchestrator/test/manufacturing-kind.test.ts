import { test } from "node:test";
import assert from "node:assert/strict";
import { manufacturingKind } from "../src/executors/manufacturing.ts";

test("manufacturing tasks go to fab packaging, documents or the RFQ package by what they produce", () => {
  const k = (key: string, title: string) => manufacturingKind({ key, title, description: null });
  assert.equal(k("fab-outputs", "Fabrication and assembly outputs"), "fab");
  assert.equal(k("fab-package", "Fab package"), "fab");
  assert.equal(k("mfg-test-plan", "Bring-up checklist, manufacturing test and fixtures"), "document");
  assert.equal(k("rfq-package", "RFQ package, quotes and vendor contracts"), "rfq");
  assert.equal(k("mfg", "Manufacturing release"), "fab", "unclear: the fab package, as before");
});
