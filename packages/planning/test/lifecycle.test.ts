import { test } from "node:test";
import assert from "node:assert/strict";
import { assessPart, diffBoms, diffManifests, priceHistory, unitPriceAt, type OfferFact } from "../src/lifecycle.ts";

const now = new Date("2026-11-18T12:00:00Z");
const offer = (seller: string, stock: number, price: number, at: string): OfferFact =>
  ({ seller, stock, currency: "USD", observed_at: at, prices: [{ quantity: 1, unit_price: price * 2 }, { quantity: 100, unit_price: price }] });

test("price breaks", () => {
  const p = [{ quantity: 1, unit_price: 0.5 }, { quantity: 100, unit_price: 0.3 }, { quantity: 1000, unit_price: 0.2 }];
  assert.equal(unitPriceAt(p, 250), 0.3);
  assert.equal(unitPriceAt(p, 1000), 0.2);
  assert.equal(unitPriceAt([{ quantity: 10, unit_price: 1 }], 1), 1, "below every break: the smallest break");
  assert.equal(unitPriceAt([], 5), null);
});

test("an active, well-stocked part has no risk", () => {
  const r = assessPart({ lifecycle: "active", notices: [], need: 300,
    offers: [offer("DigiKey", 5000, 0.1, "2026-11-01T00:00:00Z"), offer("Mouser", 2000, 0.11, "2026-11-01T00:00:00Z")] }, now);
  assert.equal(r.risk, "none");
  assert.deepEqual(r.reasons, []);
  assert.equal(r.stock, 7000);
});

test("end-of-life notice: high, with days to the last order", () => {
  const r = assessPart({ lifecycle: "active", need: 300, offers: [offer("DigiKey", 5000, 0.1, "2026-11-01T00:00:00Z"), offer("Mouser", 10, 0.1, "2026-11-01T00:00:00Z")],
    notices: [{ kind: "eol", title: "EOL", last_order_on: "2027-03-18", recorded_at: "2026-11-01T00:00:00Z" }] }, now);
  assert.equal(r.risk, "high");
  assert.equal(r.days_to_last_order, 120);
  assert.match(r.reasons[0]!, /last order 2027-03-18/);
});

test("stock, single source, recent PCN and price rises are reasons; the latest observation per seller counts", () => {
  const r = assessPart({ lifecycle: "nrnd", need: 600,
    offers: [offer("DigiKey", 9000, 0.1, "2026-06-01T00:00:00Z"), offer("DigiKey", 400, 0.14, "2026-11-10T00:00:00Z"), offer("Mouser", 0, 0.15, "2026-11-10T00:00:00Z")],
    notices: [{ kind: "pcn", title: "Assembly site change", issued_on: "2026-10-01", effective_on: "2027-01-01", recorded_at: "2026-10-02T00:00:00Z" }] }, now);
  assert.equal(r.risk, "medium");
  assert.deepEqual(r.reasons, ["not recommended for new designs", "change notice to review: Assembly site change (effective 2027-01-01)",
    "distributor stock 400 is below the 600 needed", "stocked by one distributor only (DigiKey)", "price up 40% since 2026-06-01"]);
});

test("no offers, no stock", () => {
  assert.deepEqual(assessPart({ lifecycle: "unknown", need: 1, offers: [], notices: [] }, now).reasons, ["lifecycle unknown", "no distributor data"]);
  assert.equal(assessPart({ lifecycle: "active", need: 1, offers: [offer("A", 0, 1, "2026-11-01T00:00:00Z")], notices: [] }, now).risk, "high");
});

test("price history: best price per day at the quantity", () => {
  const h = priceHistory([offer("A", 1, 0.2, "2026-01-05T10:00:00Z"), offer("B", 1, 0.18, "2026-01-05T11:00:00Z"), offer("A", 1, 0.27, "2026-09-01T00:00:00Z")], 100);
  assert.deepEqual(h.points.map((p) => [p.date, p.unit_price, p.seller]), [["2026-01-05", 0.18, "B"], ["2026-09-01", 0.27, "A"]]);
  assert.equal(h.change_pct, 50);
});

test("revision changes: files and BOM by reference", () => {
  const d = diffManifests(
    [{ artifact: "fab", kind: "fab_package", version: 1, sha256: "a" }, { artifact: "bom", kind: "bom", version: 1, sha256: "b" }, { artifact: "step", kind: "step", version: 1, sha256: "c" }],
    [{ artifact: "fab", kind: "fab_package", version: 2, sha256: "x" }, { artifact: "bom", kind: "bom", version: 1, sha256: "b" }, { artifact: "stl", kind: "stl", version: 1, sha256: "d" }]);
  assert.deepEqual(d, { added: [{ artifact: "stl", kind: "stl", version: 1, sha256: "d" }], removed: [{ artifact: "step", kind: "step", version: 1, sha256: "c" }],
                        changed: [{ artifact: "fab", from: 1, to: 2 }], unchanged: 1 });
  const b = diffBoms(
    [{ refs: ["U1"], mpn: "AP2112K" }, { refs: ["R1", "R2", "R10"], mpn: "RC0402-10K" }, { refs: ["C9"], mpn: "CL05" }],
    [{ refs: ["U1"], mpn: "TLV755P" }, { refs: ["R1", "R10", "R2"], mpn: "RC0402-10K" }, { refs: ["J1"], mpn: "USB4105" }]);
  assert.deepEqual(b, [{ kind: "added", refs: ["J1"], from: null, to: "USB4105" }, { kind: "changed", refs: ["U1"], from: "AP2112K", to: "TLV755P" },
                       { kind: "removed", refs: ["C9"], from: "CL05", to: null }]);
});
