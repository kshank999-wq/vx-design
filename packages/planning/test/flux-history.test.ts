import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFluxHistory, OfflineModel } from "../src/index.ts";

test("offline history extraction quotes the source exactly", async () => {
  const docs = [{ file: "chat.md", text: "**Alex:** We decided to use the AP2112K because the MCP1700 dropout was too high.\n\n**Sam:** DRC passed with no errors on rev C.\nWhat about BNC?" }];
  const { history } = await extractFluxHistory(docs, new OfflineModel());
  assert.deepEqual(history.decisions.map((d) => [d.rationale, d.file]), [["the MCP1700 dropout was too high.", "chat.md"]]);
  assert.deepEqual(history.claims.map((c) => c.kind), ["drc"]);
  for (const x of [...history.decisions, ...history.claims]) assert.ok(docs[0]!.text.includes(x.quote), x.quote);
  assert.deepEqual((await extractFluxHistory([], new OfflineModel())).history, { decisions: [], claims: [] });
});
