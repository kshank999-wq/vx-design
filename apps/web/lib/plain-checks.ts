/**
 * VX Design's checks in plain language, for people who are not electrical engineers: what was checked, and whether it
 * passed, passed with notes, or needs attention. The engineering wording stays available behind "details".
 */
export interface CheckRow { kind: string; result: string; summary: string }
export type Verdict = "passed" | "notes" | "attention" | "none";

const PASS: Record<string, string> = {
  erc: "The circuit passes the electrical rules check: nothing is left unconnected or wired against its type.",
  drc: "The circuit board passes the design rules check: spacing, sizes and connections are within what a board maker can build.",
  footprint_check: "Every part exists in the standard parts library and fits its place on the board.",
  bom_check: "Part numbers and ratings were checked against the manufacturers' datasheets.",
  fit_check: "The parts fit inside the enclosure with the clearances needed.",
  dfm: "The manufacturing files were read back independently and match the design.",
  power_budget: "The power budget adds up: every supply can deliver what it feeds.",
  acceptance_test: "The engineering write-up answers every requirement it covers.",
  simulation: "The calculation or simulation meets the requirement.",
};
const NOTE: Record<string, string> = {
  erc: "The electrical rules check passed with minor notes (normal on a first draft; no errors).",
  drc: "The design rules check passed with minor notes (no errors).",
  footprint_check: "Every part is in the library; a few use a close-fitting standard footprint.",
  bom_check: "Some part numbers could not be fully confirmed from datasheets yet; sourcing checks them again with live distributor data.",
  fit_check: "The parts fit, with some tight spots noted in the report.",
  dfm: "The manufacturing files match, with notes for the board maker.",
  acceptance_test: "The write-up covers the work; some points are left open for a later step (listed in it).",
  simulation: "The calculation passed with notes.",
};
const FAIL: Record<string, string> = {
  erc: "The electrical rules check found errors in the circuit.",
  drc: "The board has design rule errors a board maker would reject.",
  footprint_check: "Some parts are missing from the library or do not fit their place on the board.",
  bom_check: "Some parts do not match their datasheets.",
  fit_check: "Something does not fit inside the enclosure.",
  dfm: "The manufacturing files do not match the design.",
  acceptance_test: "The write-up does not answer some requirements.",
  simulation: "A calculation shows a requirement is not met.",
  power_budget: "A supply cannot deliver what it feeds.",
};

export function plainCheck(c: CheckRow): { level: "pass" | "note" | "fail"; text: string } {
  const level = c.result === "pass" ? "pass" : c.result === "warning" ? "note" : "fail";
  const table = level === "pass" ? PASS : level === "note" ? NOTE : FAIL;
  const short = c.summary.replace(/^Reused from v\d+ \([^)]*\): /, "").replace(/\s+/g, " ").slice(0, 160);
  return { level, text: table[c.kind] ?? (level === "pass" ? `Checked: ${short}` : level === "note" ? `Note: ${short}` : `Problem: ${short}`) };
}

export function verdict(checks: CheckRow[]): { verdict: Verdict; label: string } {
  if (!checks.length) return { verdict: "none", label: "No automatic checks apply to this step: it is a written decision for you to read" };
  const fails = checks.filter((c) => c.result === "fail" || c.result === "error").length;
  const notes = checks.filter((c) => c.result === "warning").length;
  if (fails) return { verdict: "attention", label: `Needs attention: ${fails} of ${checks.length} checks did not pass` };
  if (notes) return { verdict: "notes", label: `Passed: all ${checks.length} checks passed, ${notes} with notes` };
  return { verdict: "passed", label: `Passed: all ${checks.length} checks passed` };
}
