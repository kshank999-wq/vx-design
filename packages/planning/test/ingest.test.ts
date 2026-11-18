import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun } from "docx";
import { parseDocument, parseText, DOCX_MIME, PDF_MIME } from "../src/ingest/parsers.ts";
import { renderForPrompt, verifyCitation } from "../src/ingest/document.ts";

const SAMPLE = readFileSync(join(import.meta.dirname, "../../../tests/fixtures/specs/sample-timecode-board.md"));

test("markdown: sections, numbered ids, lists and tables", () => {
  const doc = parseText(SAMPLE.toString(), "text/markdown", SAMPLE);
  assert.equal(doc.title, "Sample Timecode Board Specification");
  assert.deepEqual(doc.sections.map((s) => s.id), ["S0", "S1", "S2", "S2.1", "S3", "S4"]);
  const s21 = doc.sections.find((s) => s.id === "S2.1")!;
  assert.deepEqual(s21.path, ["Electrical requirements"]);
  assert.equal(s21.blocks[0]!.id, "S2.1.p1");
  assert.equal(s21.blocks[0]!.kind, "list_item");
  const table = doc.sections.find((s) => s.id === "S3")!.blocks.filter((b) => b.kind === "table_row");
  assert.equal(table.length, 4); // header + 3 rows, separator row skipped
  assert.equal(table[2]!.text, "Layer count | 4 layers");
});

test("ids are stable when unrelated headings are added", () => {
  const base = "# T\n\n## 1. A\n\ntext a\n\n### Notes\n\nnote\n\n## 2. B\n\ntext b";
  const edited = "# T\n\n## Intro\n\nnew\n\n## 1. A\n\ntext a\n\n### Notes\n\nnote\n\n## 2. B\n\ntext b";
  const ids = (s: string) => parseText(s).sections.map((x) => x.id);
  assert.deepEqual(ids(base), ["S1", "S1-a", "S2"]);
  assert.deepEqual(ids(edited), ["S-a", "S1", "S1-a", "S2"]);
});

test("citations: verbatim match, normalization, wrong-block correction, rejection", () => {
  const doc = parseText(SAMPLE.toString(), "text/markdown", SAMPLE);
  const ok = verifyCitation(doc, "S2.p2", "Total current draw shall not exceed 60 mA");
  assert.deepEqual(ok, { ok: true, blockId: "S2.p2", sectionId: "S2" });
  // Curly quotes / extra spaces in the model's excerpt still match.
  assert.equal(verifyCitation(doc, "S2.p2", "Total  current draw shall\nnot exceed 60 mA").ok, true);
  // Cited the wrong block: corrected to where the text really is.
  assert.deepEqual(verifyCitation(doc, "S1.p1", "jam-sync its internal clock within 2 frames"),
    { ok: true, blockId: "S2.1.p3", sectionId: "S2.1" });
  // Paraphrase or invented text is rejected.
  assert.equal(verifyCitation(doc, "S2.p2", "Current draw must be below 50 mA").ok, false);
  assert.equal(verifyCitation(doc, "S2.p2", "60 mA").ok, false);
});

test("docx: heading styles, numbered and unnumbered headings, lists, tables", async () => {
  const docx = new Document({
    sections: [{
      children: [
        new Paragraph({ text: "Board Spec", heading: HeadingLevel.TITLE }),
        new Paragraph({ text: "Intro paragraph." }),
        new Paragraph({ text: "1. Power", heading: HeadingLevel.HEADING_1 }),
        new Paragraph({ text: "Input shall be 5 V nominal.", bullet: { level: 0 } }),
        new Paragraph({ text: "Limits", heading: HeadingLevel.HEADING_2 }),
        new Table({ rows: [
          new TableRow({ children: [new TableCell({ children: [new Paragraph("Max current")] }), new TableCell({ children: [new Paragraph("60 mA")] })] }),
        ] }),
        new Paragraph({ children: [new TextRun("Regulator shall be an LDO.")] }),
      ],
    }],
  });
  const buf = new Uint8Array(await Packer.toBuffer(docx));
  const doc = await parseDocument(buf, DOCX_MIME);
  assert.equal(doc.title, "Board Spec");
  assert.deepEqual(doc.sections.map((s) => [s.id, s.title]), [["S0", "Preamble"], ["S1", "Power"], ["S1-a", "Limits"]]);
  const limits = doc.sections[2]!;
  assert.deepEqual(limits.blocks.map((b) => [b.kind, b.text]), [["table_row", "Max current | 60 mA"], ["paragraph", "Regulator shall be an LDO."]]);
  assert.equal(doc.sections[1]!.blocks[0]!.kind, "list_item");
  assert.match(renderForPrompt(doc), /\[S1-a\.p1\] Max current \| 60 mA/);
});

test("pdf: text extraction with page numbers and numbered headings", async () => {
  const pdf = minimalPdf([["1. Power", "The board shall draw under 60 mA."], ["2. Mechanical", "Outline 40 mm x 25 mm maximum."]]);
  const doc = await parseDocument(pdf, PDF_MIME);
  assert.deepEqual(doc.sections.map((s) => s.id), ["S1", "S2"]);
  assert.equal(doc.sections[1]!.blocks[0]!.page, 2);
  assert.equal(verifyCitation(doc, "S1.p1", "draw under 60 mA").ok, true);
});

test("unsupported types are rejected with a clear message", async () => {
  await assert.rejects(parseDocument(new Uint8Array([1, 2]), "image/png"), /Unsupported document type/);
});

/** Builds a valid multi-page PDF with one text line per row (Helvetica, no compression). */
function minimalPdf(pages: string[][]): Uint8Array {
  const objects: string[] = [];
  const pageIds: number[] = [];
  const font = 3 + pages.length * 2;
  pages.forEach((lines, i) => {
    const pageId = 3 + i * 2;
    pageIds.push(pageId);
    const ops = lines.map((l, j) => `BT /F1 12 Tf 72 ${720 - j * 40} Td (${l}) Tj ET`).join("\n");
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${pageId + 1} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`;
    objects[pageId + 1] = `<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`;
  });
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((p) => `${p} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[font] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i++) out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

test("HTML pages: main content by heading, without navigation or scripts", async () => {
  const { parseDocument } = await import("../src/ingest/parsers.ts");
  const html = `<!doctype html><html><head><title>LDO-1 product page</title><script>track()</script><style>p{}</style></head>
    <body><nav><a>Home</a><a>Products</a></nav><main><h1>LDO-1</h1><p>Low-dropout regulator, 300 mA.</p>
    <h2>Key specs</h2><ul><li>Dropout 250 mV</li><li>Iq 1 µA</li></ul><table><tr><th>Vin</th><td>2.2–5.5 V</td></tr></table></main>
    <footer>© Example</footer></body></html>`;
  const doc = await parseDocument(new TextEncoder().encode(html), "text/html", "ldo.html");
  const text = JSON.stringify(doc);
  assert.equal(doc.title, "LDO-1 product page");
  assert.ok(text.includes("Dropout 250 mV") && text.includes("Vin | 2.2-5.5 V") && text.includes("Key specs"));
  assert.ok(!text.includes("track()") && !text.includes("Products") && !text.includes("© Example"));
});
