import { test } from "node:test";
import assert from "node:assert/strict";
import { zipSync } from "fflate";
import { ClamdScanner, detect, inspectUpload, inspectZip, scannerFromEnv } from "../src/index.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const DOCS = { maxBytes: 20 * 1048576, accept: ["pdf", "docx", "text"] as const };
// The EICAR test string, assembled so this source file is not itself detected.
const EICAR = enc(["X5O!P%@AP[4\\PZX54(P^)7CC)7}$", "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"].join(""));

test("detects what a file is from its bytes", () => {
  assert.equal(detect(enc("%PDF-1.7\n...")), "pdf");
  assert.equal(detect(new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0])), "executable");
  assert.equal(detect(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1])), "executable");
  assert.equal(detect(enc("#!/bin/sh\nrm -rf /\n")), "script");
  assert.equal(detect(enc("ISO-10303-21;\nHEADER;")), "step");
  assert.equal(detect(enc('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>')), "svg");
  assert.equal(detect(enc("The slate shall run for 8 hours.")), "text");
  assert.equal(detect(zipSync({ "word/document.xml": enc("<w/>") })), "zip");
});

test("accepts real documents and refuses disguised or dangerous ones", () => {
  assert.ok(inspectUpload("spec.pdf", enc("%PDF-1.7\n%%EOF"), { ...DOCS, accept: [...DOCS.accept] }).ok);
  const docx = inspectUpload("spec.docx", zipSync({ "[Content_Types].xml": enc("<x/>"), "word/document.xml": enc("<w/>") }), { ...DOCS, accept: [...DOCS.accept] });
  assert.equal(docx.detected, "docx"); assert.ok(docx.ok, docx.problems.join());
  const exe = inspectUpload("spec.pdf", new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]), { ...DOCS, accept: [...DOCS.accept] });
  assert.ok(!exe.ok);
  assert.ok(exe.problems.includes("this is a program (executable), not a document"));
  assert.ok(exe.problems.includes("named .pdf but the content is executable"));
  const macro = inspectUpload("spec.docx", zipSync({ "word/document.xml": enc("<w/>"), "word/vbaProject.bin": enc("x") }), { ...DOCS, accept: [...DOCS.accept] });
  assert.ok(macro.problems.includes("contains Office macros"));
  const svg = inspectUpload("logo.svg", enc('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'), { maxBytes: 1e6, accept: ["svg"] });
  assert.deepEqual(svg.problems, ["the SVG contains script or embedded content"]);
  assert.match(inspectUpload("big.pdf", enc("%PDF-1.7"), { maxBytes: 4, accept: ["pdf"] }).problems[0]!, /larger than/);
});

test("archives: traversal, symlinks, encryption, bombs, programs", () => {
  const traversal = inspectZip(zipSync({ "../../etc/cron.d/x": enc("x"), "ok.txt": enc("y") }));
  assert.match(traversal.problems.join(), /1 entry with a path that leaves the archive folder/);
  const link = inspectZip(zipSync({ "link": [enc("/etc/passwd"), { os: 3, attrs: (0o120777 << 16) >>> 0 }] }));
  assert.match(link.problems.join(), /symbolic link/);
  const enc1 = zipSync({ "secret.txt": enc("hello world") });
  const cd = enc1.findIndex((_, i) => enc1[i] === 0x50 && enc1[i + 1] === 0x4b && enc1[i + 2] === 0x01 && enc1[i + 3] === 0x02);
  enc1[cd + 8] = enc1[cd + 8]! | 1;   // mark the entry encrypted in the central directory
  assert.match(inspectZip(enc1).problems.join(), /1 encrypted entry/);
  const bomb = inspectZip(zipSync({ "zeros.bin": [new Uint8Array(8 * 1048576), { level: 9 }] }));
  assert.match(bomb.problems.join(), /compressed more than 200:1/);
  assert.equal(bomb.info!.uncompressed, 8 * 1048576);
  const prog = inspectUpload("flux.zip", zipSync({ "project.json": enc("{}"), "setup.exe": enc("MZ") }), { maxBytes: 1e8, accept: ["zip"] });
  assert.match(prog.problems.join(), /contains program files: setup.exe/);
  assert.ok(inspectUpload("flux.zip", zipSync({ "project.json": enc("{}"), "gerbers/top.gbr": enc("G04*") }), { maxBytes: 1e8, accept: ["zip"] }).ok);
  assert.deepEqual(inspectZip(enc("not a zip")).problems, ["not a readable ZIP (no end-of-archive record)"]);
});

const live = process.env.CLAMD_HOST ? false : "CLAMD_HOST not set (start clamd: see scripts/clamav-test.sh)";
test("clamd: EICAR is found, a clean file passes (live clamd)", { skip: live }, async () => {
  const s = scannerFromEnv()!;
  assert.match(await s.version(), /^ClamAV \d/);
  const bad = await s.scan(EICAR);
  assert.equal(bad.status, "infected");
  assert.ok(bad.signature, "names the signature");
  assert.equal((await s.scan(enc("The slate shall run for 8 hours on one battery."))).status, "clean");
  const big = new Uint8Array(3 * 1048576).fill(65);
  assert.equal((await s.scan(big)).status, "clean", "streams large files in chunks");
});

test("clamd: an unreachable scanner is an error, never clean", async () => {
  const r = await new ClamdScanner("127.0.0.1", 9, 2000).scan(enc("x"));
  assert.equal(r.status, "error");
  assert.ok(r.detail);
});
