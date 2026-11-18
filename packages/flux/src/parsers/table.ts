import { column, DESIGNATOR_HEADERS, parseCsv, splitDesignators } from "../csv.ts";
import type { ComponentFacts, ParsedFile } from "../model.ts";

const num = (s: string | undefined) => {
  if (s == null) return null;
  const m = /-?\d+(?:\.\d+)?/.exec(s.replace(",", "."));
  return m ? Number(m[0]) * (/mil/i.test(s) ? 0.0254 : /in(ch)?\b/i.test(s) ? 25.4 : 1) : null;
};

/** BOM CSV: one line per part (designators grouped) or per designator. */
export function parseBom(path: string, csv: string): ParsedFile {
  const rows = parseCsv(csv);
  const notes: string[] = [];
  const hdr = rows[0] ?? [];
  const c = {
    ref: column(hdr, DESIGNATOR_HEADERS), mpn: column(hdr, ["mpn", "manufacturer part number", "manufacturerpartnumber", "mfr part", "mfrpn", "part number", "partnumber"]),
    mfr: column(hdr, ["manufacturer", "manufacturer name", "mfr", "mfg"]), value: column(hdr, ["value", "comment", "val"]),
    pkg: column(hdr, ["package", "footprint", "case", "package/case"]), qty: column(hdr, ["quantity", "qty"]),
    dnp: column(hdr, ["dnp", "do not populate", "dni", "fitted", "populate"]),
  };
  if (c.ref < 0) return { source: "bom", path, components: [], notes: ["no designator column found; the BOM could not be matched to parts"] };
  if (c.mpn < 0) notes.push("no manufacturer part number column");
  const components: ComponentFacts[] = [];
  for (const [i, r] of rows.slice(1).entries()) {
    const refs = splitDesignators(r[c.ref] ?? "");
    if (!refs.length) continue;
    const qty = c.qty >= 0 ? Number(r[c.qty]) : NaN;
    if (Number.isFinite(qty) && qty > 0 && qty !== refs.length) notes.push(`row ${i + 2}: quantity ${qty} but ${refs.length} designator(s)`);
    const dnpRaw = c.dnp >= 0 ? (r[c.dnp] ?? "").toLowerCase() : "";
    const dnp = c.dnp >= 0 && (hdr[c.dnp]!.toLowerCase().includes("fitted") || hdr[c.dnp]!.toLowerCase().includes("populate")
      ? /^(no|false|0|n)$/.test(dnpRaw) : /^(yes|true|1|y|dnp|x)$/.test(dnpRaw));
    for (const ref of refs) {
      components.push({ designator: ref, mpn: c.mpn >= 0 ? r[c.mpn] || null : null, manufacturer: c.mfr >= 0 ? r[c.mfr] || null : null,
                        value: c.value >= 0 ? r[c.value] || null : null, package: c.pkg >= 0 ? r[c.pkg] || null : null, dnp });
    }
  }
  return { source: "bom", path, components, notes };
}

/** Pick-and-place / centroid CSV. */
export function parsePnp(path: string, csv: string): ParsedFile {
  const rows = parseCsv(csv);
  const hdr = rows[0] ?? [];
  const c = {
    ref: column(hdr, DESIGNATOR_HEADERS), x: column(hdr, ["mid x", "midx", "posx", "center-x", "centerx", "x", "locationx", "x (mm)"]),
    y: column(hdr, ["mid y", "midy", "posy", "center-y", "centery", "y", "locationy", "y (mm)"]), rot: column(hdr, ["rotation", "rot", "angle"]),
    side: column(hdr, ["layer", "side", "tb"]), pkg: column(hdr, ["package", "footprint"]), value: column(hdr, ["value", "val", "comment"]),
  };
  if (c.ref < 0 || c.x < 0 || c.y < 0) return { source: "pnp", path, components: [], notes: ["missing designator or X/Y columns"] };
  // A unit in the header ("Mid X (mil)") applies to bare numbers; a unit in the cell ("12.5mm", "500mil") wins.
  const headerScale = (h: string | undefined) => (/mil/i.test(h ?? "") ? 0.0254 : /\b(in|inch)\b/i.test(h ?? "") ? 25.4 : 1);
  const coord = (cell: string | undefined, h: string | undefined) => {
    const v = num(cell);
    return v == null ? null : /[a-z]/i.test(cell ?? "") ? v : v * headerScale(h);
  };
  const components = rows.slice(1).filter((r) => r[c.ref]).map((r) => {
    const s = (r[c.side] ?? "").toLowerCase();
    return {
      designator: r[c.ref]!.toUpperCase(), x_mm: coord(r[c.x], hdr[c.x]), y_mm: coord(r[c.y], hdr[c.y]), rotation: num(r[c.rot]),
      side: s.startsWith("b") ? "bottom" as const : s ? "top" as const : null,
      package: c.pkg >= 0 ? r[c.pkg] || null : null, value: c.value >= 0 ? r[c.value] || null : null,
    };
  });
  return { source: "pnp", path, components, notes: [] };
}
