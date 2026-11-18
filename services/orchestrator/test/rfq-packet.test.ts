import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import { buildRfqPacket, rfqRef, safeName, type PacketInput } from "../src/rfq-packet.ts";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const fab = new TextEncoder().encode("gerbers...");
const base = (): PacketInput => ({
  rfq: { rfq_no: 1, title: "Timecode board, 5 assembled", category: "pcba", sharing_scope: "drawings", response_deadline: "2026-12-02",
         manifest: { project_code: "SLATE", buyer: { company: "VX Design", contact_name: "Pat" }, classification: "prototype PCBA",
                     quantities: { prototype: 5, production: 500 }, tooling_ownership: "buyer", shipping_terms: "DAP",
                     quote_breakdown: ["unit price", "NRE"], drawing_revision: "A", requirement_refs: ["REQ-ELEC-002"],
                     ctq_dimensions: [{ feature: "Board outline", nominal: "60 x 40 mm", tolerance: "±0.2 mm" }] } },
  requirements: [
    { ref_code: "REQ-ELEC-002", kind: "electrical", priority: "must", text: "Runs from 5 V | USB-C" },
    { ref_code: "REQ-SECRET-9", kind: "commercial", priority: "must", text: "Target margin 60%" },
  ],
  attachments: [{ name: "timecode/fab-package", version: 3, sha256: sha(fab), ext: "zip", data: fab }],
});

test("packet holds exactly what the RFQ selects, with checksums", () => {
  const p = buildRfqPacket(base());
  assert.equal(p.ref, "SLATE-RFQ-001");
  assert.deepEqual(p.files.map((f) => f.name), ["00-README.txt", "01-cover-letter.md", "02-rfq-manifest.json", "02-rfq-manifest.md",
    "03-nda-template.md", "04-requirements.md", "SHA256SUMS", "files/timecode-fab-package-v3.zip"]);
  const zip = unzipSync(p.zip);
  assert.deepEqual(Object.keys(zip).sort(), p.files.map((f) => `SLATE-RFQ-001/${f.name}`).sort());
  const text = (n: string) => new TextDecoder().decode(zip[`SLATE-RFQ-001/${n}`]);
  assert.match(text("04-requirements.md"), /REQ-ELEC-002 \| electrical \| must \| Runs from 5 V \\\| USB-C/);
  assert.doesNotMatch(new TextDecoder().decode(p.zip), /Target margin/, "unselected requirements are not disclosed");
  assert.match(text("03-nda-template.md"), /Template for legal review\. Not legal advice and not signed/);
  assert.match(text("01-cover-letter.md"), /VX Design asks for your quotation for prototype PCBA/);
  const manifest = JSON.parse(text("02-rfq-manifest.json"));
  assert.equal(manifest.rfq, "SLATE-RFQ-001");
  assert.deepEqual(manifest.three_d_and_drawing_files, ["files/timecode-fab-package-v3.zip"]);
  assert.equal(manifest.response_deadline, "2026-12-02");
  for (const line of text("SHA256SUMS").trim().split("\n")) {
    const [h, n] = line.split("  ");
    assert.equal(sha(zip[`SLATE-RFQ-001/${n}`]!), h, n);
  }
  assert.equal(p.files.find((f) => f.name.startsWith("files/"))!.sha256, sha(fab));
});

test("packet is reproducible: same input, same hash", () => {
  assert.equal(buildRfqPacket(base()).sha256, buildRfqPacket(base()).sha256);
  const other = base();
  (other.rfq.manifest as { quantities: { prototype: number } }).quantities.prototype = 10;
  assert.notEqual(buildRfqPacket(base()).sha256, buildRfqPacket(other).sha256);
});

test("a file that does not match its recorded hash is refused", () => {
  const p = base();
  p.attachments[0]!.sha256 = "0".repeat(64);
  assert.throws(() => buildRfqPacket(p), /does not match its recorded sha256/);
});

test("summary-only: no files, no NDA template; unknown requirements are refused", () => {
  const p = base();
  p.rfq.sharing_scope = "summary_only";
  assert.throws(() => buildRfqPacket(p), /summary-only RFQs carry no files/);
  p.attachments = [];
  const names = buildRfqPacket(p).files.map((f) => f.name);
  assert.ok(!names.includes("03-nda-template.md"));
  (p.rfq.manifest as { requirement_refs: string[] }).requirement_refs = ["REQ-NOPE"];
  assert.throws(() => buildRfqPacket(p), /requirements that do not exist: REQ-NOPE/);
});

test("names", () => {
  assert.equal(rfqRef("", 12), "VX-RFQ-012");
  assert.equal(safeName("../../etc/passwd"), "..-..-etc-passwd");
  assert.equal(safeName("enclosure base (rev A)"), "enclosure-base-rev-A");
});
