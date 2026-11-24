/**
 * Fixes to offer on a step that could not finish, read from what went wrong: each is one click that saves the
 * guidance with the step and tries it again. Only suggestions the failure itself points to are offered.
 */
export interface StepSuggestion { label: string; note: string }

export function stepSuggestions(reason: string | null | undefined, guidance: string[] = []): StepSuggestion[] {
  const r = reason ?? "";
  const said = guidance.join(" ").toLowerCase();
  const out: StepSuggestion[] = [];
  if (/unrouted|give parts more room/i.test(r)) {
    // The net most of the unrouted pins are on: on a 4-layer board it belongs on an inner plane.
    const nets = [...r.matchAll(/\[\/([^\]]+)\]/g)].map((m) => m[1]!).filter((n) => !/^(GND|GNDA|AGND|DGND)$/i.test(n));
    const tally = new Map<string, number>();
    for (const n of nets) tally.set(n, (tally.get(n) ?? 0) + 1);
    const [top, count] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
    if (top && (count ?? 0) >= 3) {
      out.push({ label: `Put ${top} on an inner plane`, note: `Use 4 layers with the inner planes GND (In1) and ${top} (In2): most of the unrouted pins are on ${top}, so they should drop to its plane through vias instead of being routed.` });
    }
    if (!/4[- ]?layer/.test(said)) out.push({ label: "Use 4 layers", note: "Use a 4-layer board: inner layers as solid GND and main-supply planes, signals on the outer layers." });
    out.push({ label: "Make the board bigger", note: "Make the board about 20% larger in each direction and spread the parts out, keeping connected parts close together and decoupling capacitors next to their pins." });
  }
  if (/drill_out_of_range|hole size out of range/i.test(r) && !/4[- ]?layer/.test(said)) {
    out.push({ label: "Use 4 layers (allows 0.2 mm holes)", note: "Use a 4-layer board (the jlcpcb-4layer-standard profile), whose rules allow the 0.2 mm holes some footprints need." });
  }
  if (/starved_thermal/i.test(r)) {
    out.push({ label: "Connect pads to the planes solidly", note: "Where pads connect to a plane and the thermal reliefs are starved, move nearby tracks and vias away from those pads so each relief gets its spokes, or keep those pads off the plane edges." });
  }
  if (/not found by/i.test(r)) {
    out.push({ label: "Choose common parts for what was not found", note: "For lines with no part number or not found, choose common in-stock parts (Samsung, Murata, Yageo, Vishay, TI, Nexperia) that match the value, rating and footprint, and list them for review." });
  }
  if (/not making progress|no progress/i.test(r)) {
    out.push({ label: "Try a simpler approach", note: "The repeated attempts were not getting closer: take a simpler approach, fix the biggest problem first, and leave optional extras out." });
  }
  return out.slice(0, 3);
}
