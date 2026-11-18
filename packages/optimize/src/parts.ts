/**
 * Part proposals from the sourced BOM: cheaper, better-stocked, longer-lived or second-source alternates, and
 * consolidating passives. Alternates are re-checked against the line's value, package and voltage rating (the same
 * rule the sourcing step used), so a proposal can never trade a hard constraint for price.
 */
import { candidateProblems, normalizeMpn, parseValue, pricing, type BomComponent, type Offer, type PartRecord, type ResolvedLine,
         type BomResolution } from "@vx/integrations";
import type { ConstraintCheck, Excluded, Impact, OptimizeInput, OptimizeSettings, Proposal } from "./types.ts";
import { fingerprint, requirementTouches } from "./util.ts";

const LIFE_BAD = new Set(["obsolete", "last_time_buy", "nrnd"]);
const money = (n: number) => Math.round(n * 10000) / 10000;

function minVoltage(line: ResolvedLine): number | null {
  for (const r of line.wanted.requirements) {
    const m = /rated (\d+(?:\.\d+)?) V or more|required (\d+(?:\.\d+)?) V or more/.exec(r);
    if (m) return Number(m[1] ?? m[2]);
  }
  return null;
}

function component(line: ResolvedLine): BomComponent {
  return { ref: line.refs[0]!, symbol: "", value: line.wanted.value, footprint: line.wanted.footprint, mpn: null, manufacturer: null };
}

function mergedOffers(records: PartRecord[]): Offer[] {
  const seen = new Set<string>(), out: Offer[] = [];
  for (const r of records) for (const o of r.offers) { const k = `${o.provider}|${o.seller}|${o.sku}`; if (!seen.has(k)) { seen.add(k); out.push(o); } }
  return out;
}

/** Hard-constraint check of a replacement part for a line: value, package, voltage rating, and requirements naming the part. */
export function partConstraints(line: ResolvedLine, rec: PartRecord | null, reqs: OptimizeInput["requirements"]): ConstraintCheck[] {
  const out: ConstraintCheck[] = [];
  if (!rec) {
    out.push({ id: "specs", status: "needs_review", detail: "no current distributor record for the replacement: value, package and rating not re-checked" });
  } else if (line.class === "capacitor" || line.class === "resistor" || line.class === "led" || line.class === "connector") {
    const problems = candidateProblems(rec, line.class, component(line), line.wanted.package, minVoltage(line));
    if (problems.length) out.push({ id: "specs", status: "violated", detail: problems.join("; ") });
    else out.push({ id: "specs", status: "met", detail: `${line.wanted.requirements.join("; ") || "value and package"} stated in the distributor data` });
  } else {
    out.push({ id: "specs", status: "needs_review", detail: "not a generic passive: electrical equivalence needs an engineer's review" });
  }
  const cur = line.selected?.mpn ? normalizeMpn(line.selected.mpn) : null;
  for (const r of requirementTouches(reqs, [...line.refs, ...(line.selected?.mpn ? [line.selected.mpn] : [])])) {
    const names = cur && normalizeMpn(r.text).includes(cur);
    out.push({ id: r.ref_code, status: names && r.priority === "must" ? "violated" : "needs_review",
               detail: names ? `requirement names the current part: "${r.text.slice(0, 160)}"` : `requirement mentions ${line.refs.join(", ")}: "${r.text.slice(0, 160)}"` });
  }
  return out;
}

function lineCost(line: ResolvedLine, offers: Offer[], boards: number, currency: string): number | null {
  return pricing(offers, line.quantityPerBoard, [boards], currency)[0]!.choice?.extended ?? null;
}

function bomPerBoard(bom: BomResolution, boards: number): number | null {
  return bom.totals.find((t) => t.boards === boards)?.perBoard ?? null;
}

function maxBoardsInStock(line: ResolvedLine, offers: Offer[]): number {
  const stock = Math.max(0, ...offers.map((o) => o.stock ?? 0));
  return Math.floor(stock / Math.max(1, line.quantityPerBoard));
}

export function partProposals(input: OptimizeInput, s: OptimizeSettings, excluded: Excluded[]): Proposal[] {
  const bom = input.bom;
  if (!bom) return [];
  const out: Proposal[] = [];
  const cur = bom.currency;
  const qs = bom.quantities;
  const focus = qs.includes(s.focusBoards) ? s.focusBoards : qs[Math.min(qs.length - 1, 2)] ?? qs[0]!;

  for (const line of bom.lines) {
    if (!line.selected) continue;
    const refs = line.refs.join(", ");
    const mine = line.offers;
    const life = line.selected.lifecycle;
    const singleSource = line.flags.some((f) => f.code === "single_source");
    const unbuyable = line.pricing.filter((p) => !p.choice).map((p) => p.boards);
    let proposedForLine = false;

    for (const alt of line.alternates) {
      const recs = input.lookups[normalizeMpn(alt.mpn)] ?? [];
      const rec = recs[0] ?? null;
      const offers = mergedOffers(recs);
      const constraints = partConstraints(line, rec, input.requirements);
      const title = `Use ${alt.mpn} for ${refs}`;
      if (constraints.some((c) => c.status === "violated")) {
        excluded.push({ title, reason: constraints.filter((c) => c.status === "violated").map((c) => `${c.id}: ${c.detail}`).join("; ") });
        continue;
      }
      if (!offers.length) continue;
      const altLife = recs.every((r) => r.lifecycle === "active" || r.lifecycle === "unknown") ? "active" : recs[0]!.lifecycle;
      const impact: Impact[] = [];
      for (const b of qs) {
        const before = lineCost(line, mine, b, cur), after = lineCost(line, offers, b, cur);
        impact.push({ metric: `${refs} cost per board`, at: `${b} boards`, before: before === null ? null : money(before / b),
                      after: after === null ? null : money(after / b), unit: cur, better: "lower" });
      }
      const fb = lineCost(line, mine, focus, cur), fa = lineCost(line, offers, focus, cur);
      const total = bomPerBoard(bom, focus);
      if (fb !== null && fa !== null && total !== null) {
        impact.push({ metric: "BOM cost per board", at: `${focus} boards`, before: money(total), after: money(total - (fb - fa) / focus), unit: cur, better: "lower" });
      }
      const stockB = maxBoardsInStock(line, mine), stockA = maxBoardsInStock(line, offers);
      impact.push({ metric: "boards buildable from one distributor's stock", before: stockB, after: stockA, unit: "boards", better: "higher" });
      impact.push({ metric: "lifecycle", before: life, after: altLife, unit: "", better: "n/a" });

      const savingPct = fb && fa !== null ? (100 * (fb - fa)) / fb : 0;
      const unbuyableFixed = unbuyable.filter((b) => lineCost(line, offers, b, cur) !== null);
      let objective: Proposal["objective"] | null = null, benefit = 0;
      if (LIFE_BAD.has(life) && altLife === "active") { objective = "lifecycle"; benefit = life === "obsolete" ? 40 : life === "last_time_buy" ? 30 : 20; }
      else if (unbuyableFixed.length) { objective = "availability"; benefit = 30; }
      else if (savingPct >= s.minSavingPct && fa! < fb!) { objective = "cost"; benefit = total ? (100 * (fb! - fa!)) / focus / total : savingPct; }
      else if (singleSource && !proposedForLine) {
        out.push(finish({
          objective: "supply", title: `Approve ${alt.mpn} as a second source for ${refs}`, subject: refs,
          change: { kind: "second_source", from: line.selected.mpn, to: alt.mpn },
          impact: [{ metric: "qualified parts for the line", before: 1, after: 2, unit: "parts", better: "higher" }, ...impact],
          basis: { method: "distributor offers priced with the sourcing rules (MOQ, multiples, price breaks, stock)", inputs: [`sourced BOM line ${line.key}`, `offers for ${alt.mpn}`], assumptions: [] },
          ...confidenceOf(constraints, true), effort: "S", cost_note: "No redesign: same value and footprint. Add to the approved vendor list.",
          affects: { interfaces: [], manufacturability: ["purchasing: either part may be fitted"], standards: [] }, constraints, benefit: 10,
          targets: constraints.filter((c) => /^REQ/.test(c.id)).map((c) => c.id),
        }));
        proposedForLine = true;
        continue;
      } else continue;
      out.push(finish({
        objective, title: objective === "cost" ? `${title}: ${savingPct.toFixed(0)}% cheaper at ${focus} boards` : objective === "lifecycle"
          ? `${title}: replaces a ${life.replace(/_/g, " ")} part` : `${title}: buildable at ${unbuyableFixed.join(", ")} boards`,
        subject: refs, change: { kind: "swap_part", from: line.selected.mpn, to: alt.mpn, details: { line: line.key, manufacturer: alt.manufacturer, lcsc: alt.lcsc } },
        impact,
        basis: { method: "distributor offers priced with the sourcing rules (MOQ, multiples, price breaks, stock)",
                 inputs: [`sourced BOM line ${line.key}`, `offers for ${alt.mpn} (${offers.length})`], assumptions: offers.some((o) => o.status === "fixture") ? ["offer data is the offline fixture (invented numbers)"] : [] },
        ...confidenceOf(constraints, !offers.some((o) => o.status === "fixture")), effort: "S",
        cost_note: "Same value, package and footprint: no layout change. Update the BOM and re-run sourcing.",
        affects: { interfaces: [], manufacturability: alt.lcsc ? [`LCSC ${alt.lcsc} for assembly`] : ["no LCSC number: check assembly"], standards: [] },
        constraints, benefit, targets: constraints.filter((c) => /^REQ/.test(c.id)).map((c) => c.id),
      }));
      proposedForLine = true;
    }

    // No qualified alternate: the part itself has to be re-chosen by an engineer.
    if (!proposedForLine && (LIFE_BAD.has(life) || unbuyable.includes(Math.max(...qs)))) {
      out.push(finish({
        objective: LIFE_BAD.has(life) ? "lifecycle" : "availability",
        title: LIFE_BAD.has(life) ? `Replace ${line.selected.mpn} (${refs}): ${life.replace(/_/g, " ")}` : `Find a source for ${refs} at ${Math.max(...qs)} boards`,
        subject: refs, change: { kind: "replace_part", from: line.selected.mpn, to: "to be chosen by an engineer" },
        impact: [{ metric: "lifecycle", before: life, after: "active (target)", unit: "", better: "n/a" },
                 { metric: "boards buildable from one distributor's stock", before: maxBoardsInStock(line, mine), after: null, unit: "boards", better: "higher" }],
        basis: { method: "lifecycle and stock reported by distributors", inputs: [`sourced BOM line ${line.key}`], assumptions: [] },
        confidence: "low", confidence_reason: "no qualified alternate is known yet; the gain depends on the replacement chosen",
        effort: line.class === "other" ? "L" : "M", cost_note: "Electrical and footprint review; may need a layout change.",
        affects: { interfaces: [refs], manufacturability: ["re-sourcing"], standards: [] },
        constraints: [{ id: "specs", status: "needs_review", detail: "replacement not chosen" }],
        benefit: LIFE_BAD.has(life) ? (life === "obsolete" ? 40 : 20) : 30, targets: [],
      }));
    }
  }
  out.push(...consolidation(input, s, focus, excluded));
  return out;
}

/** Passives with the same value and package but different part numbers: buy one part for all of them. */
function consolidation(input: OptimizeInput, s: OptimizeSettings, focus: number, excluded: Excluded[]): Proposal[] {
  const bom = input.bom!;
  const groups = new Map<string, ResolvedLine[]>();
  for (const l of bom.lines) {
    if (!l.selected || (l.class !== "resistor" && l.class !== "capacitor") || !l.wanted.package) continue;
    const v = parseValue(l.wanted.value, l.class === "resistor" ? "Ω" : "F");
    if (v === null) continue;
    const k = `${l.class}|${l.wanted.package}|${v.toPrecision(4)}`;
    groups.set(k, [...(groups.get(k) ?? []), l]);
  }
  const out: Proposal[] = [];
  for (const lines of groups.values()) {
    const mpns = [...new Set(lines.map((l) => normalizeMpn(l.selected!.mpn)))];
    if (lines.length < 2 || mpns.length < 2) continue;
    const refs = lines.flatMap((l) => l.refs).join(", ");
    // Strictest line decides: the chosen part must meet every line's value, package and voltage.
    const strict = [...lines].sort((a, b) => (minVoltage(b) ?? 0) - (minVoltage(a) ?? 0))[0]!;
    const perBoard = lines.reduce((a, l) => a + l.quantityPerBoard, 0);
    const candidates = lines.map((l) => {
      const recs = input.lookups[normalizeMpn(l.selected!.mpn)] ?? [];
      const checks = lines.flatMap((x) => partConstraints(x, recs[0] ?? null, input.requirements).filter((c) => c.id === "specs"));
      const offers = mergedOffers(recs);
      const cost = pricing(offers, perBoard, [focus], bom.currency)[0]!.choice?.extended ?? null;
      return { line: l, recs, checks, cost };
    }).filter((c) => c.recs.length && c.checks.every((x) => x.status === "met") && c.cost !== null)
      .sort((a, b) => a.cost! - b.cost!);
    if (!candidates.length) { excluded.push({ title: `Consolidate ${refs}`, reason: "no single part is confirmed to meet every line's value, package and rating" }); continue; }
    const best = candidates[0]!;
    const before = lines.reduce((a, l) => a + (lineCost(l, l.offers, focus, bom.currency) ?? 0), 0);
    const impact: Impact[] = [
      { metric: "unique BOM lines", before: bom.lines.length, after: bom.lines.length - (lines.length - 1), unit: "lines", better: "lower" },
      { metric: `${refs} cost per board`, at: `${focus} boards`, before: money(before / focus), after: money(best.cost! / focus), unit: bom.currency, better: "lower" },
    ];
    const assumptions: string[] = [];
    if (s.assemblyFeePerUniquePart !== null) {
      impact.push({ metric: "assembly setup fees per order", before: money(s.assemblyFeePerUniquePart * lines.length), after: money(s.assemblyFeePerUniquePart), unit: bom.currency, better: "lower" });
      assumptions.push(`assembly fee ${s.assemblyFeePerUniquePart} ${bom.currency} per unique part (${s.assemblyFeeSource})`);
    }
    out.push(finish({
      objective: "consolidation", title: `Use ${best.line.selected!.mpn} for all ${lines[0]!.wanted.value} ${lines[0]!.wanted.package} parts (${refs})`,
      subject: refs, change: { kind: "consolidate", from: mpns.join(" + "), to: best.line.selected!.mpn, details: { strictest: strict.key } },
      impact, basis: { method: "combined quantity priced with the sourcing rules; every line's value, package and voltage re-checked", inputs: lines.map((l) => `line ${l.key}`), assumptions },
      ...confidenceOf(best.checks, true), effort: "S", cost_note: "No layout change. Fewer parts to buy, stock and load on the pick-and-place.",
      affects: { interfaces: [], manufacturability: ["fewer feeder setups"], standards: [] },
      constraints: best.checks.slice(0, 1), benefit: 5 + (before > best.cost! ? (100 * (before - best.cost!)) / Math.max(before, 1e-9) / 4 : 0),
      targets: [],
    }));
  }
  return out;
}

function confidenceOf(constraints: ConstraintCheck[], liveData: boolean): { confidence: Proposal["confidence"]; confidence_reason: string } {
  if (constraints.some((c) => c.status === "needs_review")) return { confidence: "medium", confidence_reason: "some constraints need an engineer's review" };
  if (!liveData) return { confidence: "medium", confidence_reason: "based on fixture offer data, not live distributor data" };
  return { confidence: "high", confidence_reason: "distributor data and constraint checks agree" };
}

export function finish(p: Omit<Proposal, "fingerprint" | "score"> & { benefit: number }): Proposal {
  const { benefit, ...rest } = p;
  const conf = { high: 1, medium: 0.7, low: 0.4 }[p.confidence];
  const effort = { S: 1, M: 1.5, L: 2.5 }[p.effort];
  return { ...rest, fingerprint: fingerprint(p.objective, p.change.kind, p.subject, p.change.from, p.change.to),
           score: Math.round((benefit * conf * 100) / effort) / 100 };
}
