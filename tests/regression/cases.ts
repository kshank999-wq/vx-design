/**
 * Regression cases (G6): each runs a deterministic pipeline on fixed inputs and returns a normalised output, plus the
 * hashes of its inputs and the versions of the code that produced it, so a changed result can be traced to a changed
 * input, prompt, calculator or tool.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runAudit, AUDIT_VERSION } from "../../packages/flux/src/index.ts";
import { fluxFixture } from "../../packages/flux/test/fixture.ts";
import { buildRfqPacket } from "../../services/orchestrator/src/rfq-packet.ts";
import { calculate, POWER_CALC_VERSION } from "../../packages/power/src/index.ts";
import { chunkDocument, extractRequirements, generatePlan, generateConceptBrief, OfflineModel, parseDocument,
         OFFLINE_FIXTURE_POWER, CONCEPT_PROMPT_VERSION } from "../../packages/planning/src/index.ts";
import { FixtureImageProvider } from "../../packages/integrations/src/imaging/fixture.ts";
import { inspectUpload } from "../../packages/security/src/index.ts";

export const ROOT = join(import.meta.dirname, "../..");
export const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const enc = (s: string) => new TextEncoder().encode(s);

export interface CaseResult { inputs: Record<string, string>; versions: Record<string, string>; output: unknown }
export interface Case { name: string; describe: string; run(): Promise<CaseResult> }

const pkgVersion = (rel: string) => { const p = JSON.parse(readFileSync(join(ROOT, rel, "package.json"), "utf8")); return `${p.name}@${p.version}`; };

export const CASES: Case[] = [
  {
    name: "flux-audit", describe: "G5 audit of the synthetic three-revision Flux export",
    async run() {
      const uploads = fluxFixture();
      const r = runAudit({ uploads, revisions: [{ label: "Rev A", date: "2026-10-02" }, { label: "Rev B", date: "2026-11-02" }, { label: "Rev C", date: "2026-11-09" }] });
      return { inputs: Object.fromEntries(uploads.map((u) => [u.name, sha(u.data)])), versions: { audit: AUDIT_VERSION, flux: pkgVersion("packages/flux") }, output: r };
    },
  },
  {
    name: "rfq-packet", describe: "M-RFQ packet from a fixed manifest, requirements and file",
    async run() {
      const fab = enc("fab package bytes for the regression suite");
      const p = buildRfqPacket({
        rfq: { rfq_no: 7, title: "Timecode board", category: "pcba", sharing_scope: "drawings", response_deadline: "2026-12-31",
               manifest: { project_code: "SLATE", buyer: { company: "VX Design" }, classification: "prototype PCBA", quantities: { prototype: 5 },
                           tooling_ownership: "buyer", shipping_terms: "DAP", quote_breakdown: ["unit price"], drawing_revision: "A", requirement_refs: ["REQ-1"] } },
        requirements: [{ ref_code: "REQ-1", kind: "electrical", priority: "must", text: "Runs from USB-C 5 V." }],
        attachments: [{ name: "timecode/fab-package", version: 1, sha256: sha(fab), ext: "zip", data: fab }],
      });
      return { inputs: { fab: sha(fab) }, versions: { orchestrator: pkgVersion("services/orchestrator") }, output: { sha256: p.sha256, files: p.files } };
    },
  },
  {
    name: "power-calc", describe: "Power calculator on the offline power tree",
    async run() {
      return { inputs: { tree: sha(JSON.stringify(OFFLINE_FIXTURE_POWER)) }, versions: { calc: POWER_CALC_VERSION }, output: calculate(OFFLINE_FIXTURE_POWER) };
    },
  },
  {
    name: "spec-to-plan", describe: "G1 offline path: parse the sample spec, extract requirements, plan",
    async run() {
      const file = join(ROOT, "tests/fixtures/specs/sample-timecode-board.md");
      const bytes = readFileSync(file);
      const doc = await parseDocument(new Uint8Array(bytes), "text/markdown", "sample-timecode-board.md");
      const model = new OfflineModel();
      const ex = await extractRequirements(doc, model);
      const reqs = ex.requirements.map((r, i) => ({ refCode: `REQ-${r.kind.slice(0, 3).toUpperCase()}-${String(i + 1).padStart(3, "0")}`, kind: r.kind, priority: r.priority,
                                                    text: r.statement, status: "confirmed" as const }));
      const plan = await generatePlan(reqs, model);
      return { inputs: { spec: sha(bytes) }, versions: { planning: pkgVersion("packages/planning") },
               output: { sections: doc.sections.length, requirements: ex.requirements, plan: plan.plan ?? plan } };
    },
  },
  {
    name: "kb-chunks", describe: "Knowledge-base excerpts from the KB fixtures",
    async run() {
      const dir = join(ROOT, "tests/fixtures/kb");
      const inputs: Record<string, string> = {}, out: Record<string, unknown> = {};
      for (const f of readdirSync(dir).filter((x) => x.endsWith(".md")).sort()) {
        const bytes = readFileSync(join(dir, f));
        inputs[f] = sha(bytes);
        out[f] = chunkDocument(await parseDocument(new Uint8Array(bytes), "text/markdown", f));
      }
      return { inputs, versions: { planning: pkgVersion("packages/planning") }, output: out };
    },
  },
  {
    name: "concept-offline", describe: "M-CON offline brief and placeholder images",
    async run() {
      const { brief } = await generateConceptBrief({ project: { name: "Slate", description: null }, requirements: [], direction: "rugged", count: 2 }, new OfflineModel());
      const provider = new FixtureImageProvider();
      const images = [];
      for (const v of brief.variants.slice(0, 2)) { const img = await provider.generate({ prompt: v.prompt, references: [], aspectRatio: "4:3" }); images.push({ name: v.name, sha256: sha(img.data), seed: img.seed }); }
      return { inputs: {}, versions: { prompt: CONCEPT_PROMPT_VERSION }, output: { brief, images } };
    },
  },
  {
    name: "upload-inspection", describe: "G6 upload verdicts over a fixed corpus",
    async run() {
      const corpus: [string, Uint8Array][] = [
        ["spec.pdf", enc("%PDF-1.7\n%%EOF")], ["evil.pdf", new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0])], ["notes.md", enc("# Notes\nok")],
        ["run.sh", enc("#!/bin/sh\necho hi")], ["logo.svg", enc('<svg xmlns="http://www.w3.org/2000/svg" onload="x()"/>')],
      ];
      const policy = { maxBytes: 1e6, accept: ["pdf", "docx", "text", "svg"] as never };
      return { inputs: Object.fromEntries(corpus.map(([n, b]) => [n, sha(b)])), versions: { security: pkgVersion("packages/security") },
               output: corpus.map(([n, b]) => ({ name: n, ...inspectUpload(n, b, policy) })) };
    },
  },
];
