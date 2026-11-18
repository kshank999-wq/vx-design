/**
 * RFQ packet (M-RFQ, spec §12): one supplier-neutral ZIP per RFQ. Deterministic: the same RFQ, requirements and
 * files give the same bytes and so the same sha256, which the owner's disclosure approval is bound to.
 *
 * Contents: README, cover letter, the manifest (JSON and readable), an NDA template for legal review (when files are
 * shared), the requirements the owner chose to disclose, the chosen committed design files, and SHA256SUMS.
 * Never included: other suppliers, contacts, quotes, costs, internal notes or anything not explicitly selected.
 */
import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import { CATEGORY_LABEL, RfqManifest, SHARING_SCOPE_LABEL, type ManufacturingCategory } from "@vx/contracts";

export interface PacketInput {
  rfq: { rfq_no: number; title: string; category: ManufacturingCategory; sharing_scope: "summary_only" | "drawings" | "full_design";
         response_deadline: string; manifest: unknown };
  requirements: { ref_code: string; kind: string; priority: string; text: string }[];
  attachments: { name: string; version: number; sha256: string; ext: string; data: Uint8Array }[];
}
export interface PacketFile { name: string; sha256: string; size: number; source: string }
export interface Packet { ref: string; files: PacketFile[]; zip: Uint8Array; sha256: string }

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);   // code-unit order, locale-independent
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const enc = (s: string) => new TextEncoder().encode(s.replace(/\r?\n/g, "\n"));
const MTIME = new Date(Date.UTC(1980, 0, 1));   // fixed, so the ZIP is reproducible

export function rfqRef(projectCode: string, no: number): string {
  return `${projectCode || "VX"}-RFQ-${String(no).padStart(3, "0")}`;
}

export function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 120) || "file";
}

const list = (xs: readonly string[] | undefined, empty = "None stated.") => xs?.length ? xs.map((x) => `- ${x}`).join("\n") : empty;

export function buildRfqPacket(input: PacketInput): Packet {
  const m = RfqManifest.parse(input.rfq.manifest ?? {});
  const ref = rfqRef(m.project_code, input.rfq.rfq_no);
  const scope = input.rfq.sharing_scope;
  if (scope === "summary_only" && input.attachments.length) throw new Error("summary-only RFQs carry no files");
  const wanted = new Set(m.requirement_refs);
  const reqs = input.requirements.filter((r) => wanted.has(r.ref_code)).sort((a, b) => byName(a.ref_code, b.ref_code));
  const missing = [...wanted].filter((r) => !reqs.some((x) => x.ref_code === r));
  if (missing.length) throw new Error(`the manifest lists requirements that do not exist: ${missing.join(", ")}`);

  const files = new Map<string, { data: Uint8Array; source: string }>();
  const add = (name: string, data: Uint8Array | string, source: string) => {
    if (files.has(name)) throw new Error(`duplicate file in packet: ${name}`);
    files.set(name, { data: typeof data === "string" ? enc(data) : data, source });
  };

  const attachmentNames = input.attachments
    .slice().sort((a, b) => byName(a.name, b.name) || a.version - b.version)
    .map((a) => {
      if (sha(a.data) !== a.sha256) throw new Error(`${a.name} v${a.version} does not match its recorded sha256`);
      const name = `files/${safeName(a.name.replaceAll("/", "-"))}-v${a.version}${a.ext ? `.${a.ext}` : ""}`;
      add(name, a.data, `design file ${a.name} v${a.version}`);
      return name;
    });

  const deadline = input.rfq.response_deadline;
  const q = m.quantities;
  const manifestJson = {
    rfq: ref, title: input.rfq.title, category: input.rfq.category, project_code: m.project_code,
    buyer: m.buyer, classification: m.classification,
    quantities: q, materials: m.materials, finish: m.finish ?? null, ctq_dimensions: m.ctq_dimensions,
    drawing_revision: m.drawing_revision ?? null, three_d_and_drawing_files: attachmentNames,
    standards: m.standards, compliance: m.compliance ?? null, tests_inspection: m.tests_inspection ?? null,
    tooling_ownership: m.tooling_ownership, shipping_terms: m.shipping_terms, response_deadline: deadline,
    quote_breakdown: m.quote_breakdown, requirements: reqs.map((r) => r.ref_code),
    sharing_scope: scope, nda: scope === "full_design" ? "signed NDA required before release" : "recorded per supplier by the buyer",
    notes: m.notes ?? null,
  };

  add("00-README.txt", [
    `${ref}: ${input.rfq.title}`,
    "",
    `Request for quotation from ${m.buyer.company}. Category: ${CATEGORY_LABEL[input.rfq.category]}.`,
    `Quotes are due by ${deadline}. Submit them in the VX Design supplier portal (the link in the email you received).`,
    "",
    "Contents:",
    "  01-cover-letter.md      what we are asking for",
    "  02-rfq-manifest.json    the request in machine-readable form (02-rfq-manifest.md is the same, readable)",
    ...(scope !== "summary_only" ? ["  03-nda-template.md      NDA template (for both parties' legal review; not signed)"] : []),
    ...(reqs.length ? ["  04-requirements.md      requirements that apply to this part"] : []),
    ...(attachmentNames.length ? ["  files/                  drawings and design files"] : []),
    "  SHA256SUMS              checksums of every file in this packet",
    "",
    `Sharing scope: ${SHARING_SCOPE_LABEL[scope]}. This packet is confidential and shared only for quoting.`,
    "Do not pass it on, and delete it if you decline.",
    "",
  ].join("\n"), "generated");

  add("01-cover-letter.md", [
    `# ${ref}: ${input.rfq.title}`,
    "",
    "Dear supplier,",
    "",
    `${m.buyer.company} asks for your quotation for ${m.classification || input.rfq.title}` +
      ` (${CATEGORY_LABEL[input.rfq.category].toLowerCase()}).`,
    "",
    `- Prototype quantity: ${q.prototype}` + (q.production ? `\n- Production quantity: ${q.production}` : "") +
      (q.forecast_annual ? `\n- Annual forecast: ${q.forecast_annual} (a forecast, not a commitment)` : ""),
    `- Shipping terms: ${m.shipping_terms}`,
    `- Tooling ownership: ${m.tooling_ownership.replace("_", " ")}`,
    `- Response deadline: ${deadline}`,
    "",
    "Please break your quote down into:",
    list(m.quote_breakdown),
    "",
    "Tell us about anything in the drawings or requirements you cannot meet, and suggest changes that would",
    "lower cost or lead time. The details are in the manifest" + (attachmentNames.length ? " and the files folder." : "."),
    "",
    "Thank you,",
    m.buyer.contact_name ? `${m.buyer.contact_name}, ${m.buyer.company}` : m.buyer.company,
    "",
  ].join("\n"), "generated");

  add("02-rfq-manifest.json", JSON.stringify(manifestJson, null, 2) + "\n", "generated from the RFQ");
  add("02-rfq-manifest.md", [
    `# ${ref} manifest`,
    "",
    `| Field | Value |`,
    `|---|---|`,
    `| Project code | ${m.project_code} |`,
    `| Buyer | ${m.buyer.company} |`,
    `| Classification | ${m.classification} |`,
    `| Quantities | prototype ${q.prototype}${q.production ? `, production ${q.production}` : ""}${q.forecast_annual ? `, forecast ${q.forecast_annual}/yr` : ""} |`,
    `| Materials | ${m.materials.join("; ") || "see drawings"} |`,
    `| Finish | ${m.finish ?? "see drawings"} |`,
    `| Drawing revision | ${m.drawing_revision ?? "n/a"} |`,
    `| Standards | ${m.standards.join("; ") || "none stated"} |`,
    `| Compliance | ${m.compliance ?? "none stated"} |`,
    `| Tests and inspection | ${m.tests_inspection ?? "none stated"} |`,
    `| Tooling ownership | ${m.tooling_ownership} |`,
    `| Shipping terms | ${m.shipping_terms} |`,
    `| Response deadline | ${deadline} |`,
    `| Sharing scope | ${SHARING_SCOPE_LABEL[scope]} |`,
    "",
    "## Critical-to-quality dimensions",
    m.ctq_dimensions.length ? ["| Feature | Nominal | Tolerance |", "|---|---|---|",
      ...m.ctq_dimensions.map((d) => `| ${d.feature} | ${d.nominal} | ${d.tolerance} |`)].join("\n") : "See drawings.",
    "",
    "## Files",
    list(attachmentNames, "No files (summary only)."),
    "",
    ...(m.notes ? ["## Notes", m.notes, ""] : []),
  ].join("\n"), "generated from the RFQ");

  if (scope !== "summary_only") {
    add("03-nda-template.md", [
      "# Mutual non-disclosure agreement: TEMPLATE",
      "",
      "> **Template for legal review. Not legal advice and not signed.** Both parties' counsel must review and adapt it",
      "> (governing law, term, remedies) before anyone signs. Supplier NDAs may be used instead.",
      "",
      `Parties: ${m.buyer.company} ("Buyer") and the supplier named on signature ("Supplier").`,
      "",
      `1. Purpose. Evaluating and quoting ${ref} (${input.rfq.title}), and if agreed, making the parts.`,
      "2. Confidential information. Everything in the RFQ packet and anything else marked or reasonably understood as",
      "   confidential, including drawings, CAD files, schematics, layouts, requirements, quantities and prices.",
      "3. Obligations. Use it only for the purpose; share it only with employees and subcontractors who need it and are",
      "   bound by equal duties; protect it at least as carefully as your own confidential information.",
      "4. Exclusions. Information that is public through no fault of the recipient, already known, independently",
      "   developed, or rightfully received from a third party.",
      "5. No licence. No rights in the design or intellectual property are granted; tooling ownership is as stated in",
      "   the RFQ.",
      "6. Return or destruction. On request or when quoting ends without an order, delete or return it and confirm.",
      "7. Term. [__] years from disclosure. Governing law: [__].",
      "",
      "Signed for the Buyer: ____________________  Date: ________",
      "Signed for the Supplier: _________________  Date: ________",
      "",
    ].join("\n"), "template");
  }

  if (reqs.length) {
    add("04-requirements.md", [
      `# Requirements for ${ref}`,
      "",
      "| Ref | Kind | Priority | Requirement |",
      "|---|---|---|---|",
      ...reqs.map((r) => `| ${r.ref_code} | ${r.kind} | ${r.priority} | ${r.text.replace(/\|/g, "\\|").replace(/\s+/g, " ")} |`),
      "",
    ].join("\n"), "selected project requirements");
  }

  const sums = [...files.entries()].sort(([a], [b]) => byName(a, b)).map(([n, f]) => `${sha(f.data)}  ${n}`).join("\n") + "\n";
  add("SHA256SUMS", sums, "generated");

  const ordered = [...files.entries()].sort(([a], [b]) => byName(a, b));
  const zip = zipSync(Object.fromEntries(ordered.map(([n, f]) => [`${ref}/${n}`, [f.data, { mtime: MTIME }]])), { level: 6 });
  return {
    ref, zip, sha256: sha(zip),
    files: ordered.map(([name, f]) => ({ name, sha256: sha(f.data), size: f.data.length, source: f.source })),
  };
}
