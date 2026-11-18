import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { ocrChunks, ocrPdf, tsvToText } from "../src/ocr.ts";

test("tsv to lines and paragraphs, with mean confidence; non-text rows dropped", () => {
  const head = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext";
  const w = (b: number, p: number, l: number, conf: number, t: string) => `5\t1\t${b}\t${p}\t${l}\t1\t0\t0\t1\t1\t${conf}\t${t}`;
  const tsv = [head, "1\t1\t0\t0\t0\t0\t0\t0\t1\t1\t-1\t", w(1, 1, 1, 90, "TOLERANCES"), w(1, 1, 1, 80, "±0.1"), w(1, 1, 2, 70, "unless"),
               w(1, 2, 1, 96, "MATERIAL:"), w(1, 2, 1, -1, " ")].join("\n");
  assert.deepEqual(tsvToText(tsv), { text: "TOLERANCES ±0.1 unless\n\nMATERIAL:", confidence: 84 });
});

test("excerpts split at paragraphs and located by page", () => {
  const long = "x".repeat(1000);
  const c = ocrChunks([{ page: 1, text: `${long}\n\n${long}`, confidence: 90 }, { page: 2, text: "short", confidence: 90 }, { page: 3, text: "  ", confidence: null }]);
  assert.deepEqual(c.map((x) => [x.ordinal, x.locator, x.text.length]), [[1, "p. 1 (OCR)", 1000], [2, "p. 1 (OCR)", 1000], [3, "p. 2 (OCR)", 5]]);
});

const have = (cmd: string, flag = "--version") => { try { execFileSync(cmd, [flag], { stdio: "ignore" }); return true; } catch { return false; } };
test("a rendered page with no text layer is read back by OCR", { skip: !(have("tesseract") && have("pdftoppm", "-v") && have("python3")) && "needs tesseract, pdftoppm and python3" }, async () => {
  // A one-page PDF whose only content is an image of text (no text layer), made with Pillow.
  const pdf = execFileSync("python3", ["-c", `
import io, sys
from PIL import Image, ImageDraw, ImageFont
img = Image.new("L", (1700, 600), 255)
d = ImageDraw.Draw(img)
try: f = ImageFont.truetype("DejaVuSans.ttf", 64)
except Exception: f = ImageFont.load_default()
d.text((80, 120), "MAXIMUM INPUT VOLTAGE 6 V", fill=0, font=f)
d.text((80, 300), "OPERATING TEMPERATURE -40 TO 125 C", fill=0, font=f)
buf = io.BytesIO(); img.save(buf, "PDF", resolution=200); sys.stdout.buffer.write(buf.getvalue())`]);
  const pages = await ocrPdf(new Uint8Array(pdf));
  assert.equal(pages.length, 1);
  assert.match(pages[0]!.text, /MAXIMUM INPUT VOLTAGE 6 V/);
  assert.match(pages[0]!.text, /OPERATING TEMPERATURE/);
  assert.ok((pages[0]!.confidence ?? 0) > 60);
});
