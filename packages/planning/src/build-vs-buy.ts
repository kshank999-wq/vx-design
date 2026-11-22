/**
 * Build versus buy for one subsystem (a radio, the compute, a camera, power). Ready-made modules from the catalog are
 * matched against the need by code: interfaces, radios, the supply voltage the product has, the space it has, and the
 * markets the radio must be certified for. A module that misses a hard constraint is shown with the reason; a field the
 * catalog does not know is shown as unknown, never guessed. The fitting modules and a custom (chip-down) option become
 * a trade study on the "module vs custom" criteria, scored from the catalog where it has the data and from stated
 * rules of thumb where it does not; every rule of thumb says so and can be edited before deciding.
 */
import { z } from "zod";
import type { LanguageModel, Usage } from "./llm/model.ts";
import { LIFECYCLE_RATING, TRADE_TEMPLATES, type Criterion, type Scores, type TradeOption } from "./trade-study.ts";

export const BUILD_VS_BUY_VERSION = "build-vs-buy-v1";

export interface Need {
  title: string;
  kind: string;                      // module kind: radio_module, som, dev_board, sensor_module, power_module, display, other
  interfaces: string[];              // each must be offered by the module (USB, MIPI CSI-2, I2C, UART, PCIe ...)
  radios: string[];                  // each must be offered (Wi-Fi, Bluetooth LE, LoRa, GNSS ...)
  supply_v?: number | null;          // a rail the product has: the module must accept it
  max_dims_mm?: { x?: number; y?: number; z?: number } | null;
  regions: string[];                 // markets: FCC, ISED, CE/RED, UKCA, TELEC ... (radio certification needed there)
  quantity?: number | null;
  requirement_refs?: string[];
}

export interface CatalogModule {
  id: string; kind: string; name: string; manufacturer: string; mpn: string; status: string; lifecycle: string;
  interfaces: string[]; radios: string[]; supply: { v_min?: number; v_max?: number };
  dimensions_mm: { x?: number; y?: number; z?: number };
  certifications: { regime: string; id: string }[];
}

export interface ModuleMatch {
  module: CatalogModule;
  fits: boolean;
  /** Hard constraints the module does not meet. */
  misses: string[];
  /** Constraints the catalog cannot answer for this module (unknown, not assumed). */
  unknown: string[];
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
// Spellings that mean the same thing.
const SAME: [RegExp, string][] = [
  [/^(wifi|wlan|80211\w*)$/, "wifi"], [/^(ble|bluetoothle|bluetoothlowenergy|bt5\w*|bluetooth5\w*)$/, "ble"], [/^(bluetooth|bt|btclassic)$/, "bluetooth"],
  [/^(mipicsi|mipicsi2|csi|csi2)$/, "mipicsi"], [/^(mipidsi|dsi)$/, "mipidsi"], [/^(i2c|iic|twi)$/, "i2c"], [/^(gnss|gps)$/, "gnss"],
  [/^(cered|red|ce)$/, "ce"], [/^(ic|ised|isedcanada)$/, "ised"], [/^(usb20|usb2|usb)$/, "usb"], [/^(usb3\w*|usbc3\w*)$/, "usb3"],
];
const canon = (s: string) => { const n = norm(s); return SAME.find(([re]) => re.test(n))?.[1] ?? n; };
const offers = (have: string[], want: string) => {
  const w = canon(want);
  return have.some((h) => { const c = canon(h); return c === w || c.startsWith(w) || (w === "usb" && c === "usb3") || (w === "ble" && c === "bluetooth5"); });
};

export function matchModules(need: Need, modules: CatalogModule[]): ModuleMatch[] {
  const out = modules.filter((m) => !need.kind || m.kind === need.kind || need.kind === "other").map((m): ModuleMatch => {
    const misses: string[] = [], unknown: string[] = [];
    const ifs = need.interfaces.filter(Boolean), rad = need.radios.filter(Boolean);
    if (ifs.length && !m.interfaces.length) unknown.push(`interfaces (${ifs.join(", ")})`);
    else for (const i of ifs) if (!offers(m.interfaces, i)) misses.push(`no ${i}`);
    if (rad.length && !m.radios.length) unknown.push(`radios (${rad.join(", ")})`);
    else for (const r of rad) if (!offers(m.radios, r)) misses.push(`no ${r}`);
    if (need.supply_v != null) {
      const { v_min, v_max } = m.supply ?? {};
      if (v_min == null && v_max == null) unknown.push(`supply range (needs to accept ${need.supply_v} V)`);
      else if ((v_min != null && need.supply_v < v_min) || (v_max != null && need.supply_v > v_max)) {
        misses.push(`supply ${v_min ?? "?"}–${v_max ?? "?"} V does not accept the ${need.supply_v} V rail`);
      }
    }
    const lim = need.max_dims_mm ?? {};
    if (lim.x != null || lim.y != null || lim.z != null) {
      const d = m.dimensions_mm ?? {};
      if (d.x == null || d.y == null) unknown.push("size");
      else {
        const [a, b] = [Math.max(d.x, d.y), Math.min(d.x, d.y)];
        const [la, lb] = [Math.max(lim.x ?? Infinity, lim.y ?? Infinity), Math.min(lim.x ?? Infinity, lim.y ?? Infinity)];
        if (a > la || b > lb) misses.push(`${d.x} x ${d.y} mm does not fit ${lim.x ?? "any"} x ${lim.y ?? "any"} mm`);
        if (lim.z != null && d.z != null && d.z > lim.z) misses.push(`${d.z} mm tall, ${lim.z} mm available`);
        if (lim.z != null && d.z == null) unknown.push("height");
      }
    }
    if ((need.radios.length || need.kind === "radio_module") && need.regions.length) {
      const regimes = new Set(m.certifications.map((c) => canon(c.regime)));
      for (const r of need.regions) if (!regimes.has(canon(r))) (m.certifications.length ? misses : unknown).push(`${r} certification`);
    }
    if (m.lifecycle === "obsolete" || m.lifecycle === "last_time_buy") misses.push(`lifecycle: ${m.lifecycle.replace(/_/g, " ")}`);
    return { module: m, fits: !misses.length, misses, unknown };
  });
  return out.sort((a, b) => Number(b.fits) - Number(a.fits) || a.misses.length - b.misses.length || a.unknown.length - b.unknown.length
    || Number(b.module.status === "verified") - Number(a.module.status === "verified") || a.module.name.localeCompare(b.module.name));
}

/** Rules of thumb for designing the same function chip-down instead (edit them in the study). Engineering at $120/h. */
const RATE = 120;
const CUSTOM: Record<string, { hours: number; cert_usd: number; weeks: number; cert_rating: number; note: string }> = {
  radio_module: { hours: 160, cert_usd: 15000, weeks: 14, cert_rating: 1, note: "RF layout and matching, antenna tuning, and full intentional-radiator certification in each market" },
  som:          { hours: 480, cert_usd: 0, weeks: 20, cert_rating: 3, note: "processor, DDR and power sequencing on an 8+ layer board, plus OS bring-up" },
  dev_board:    { hours: 240, cert_usd: 0, weeks: 12, cert_rating: 3, note: "the board's functions designed onto your own PCB" },
  sensor_module:{ hours: 30, cert_usd: 0, weeks: 3, cert_rating: 4, note: "sensor, filtering and calibration on your board" },
  power_module: { hours: 50, cert_usd: 0, weeks: 4, cert_rating: 4, note: "converter design, layout for EMI, thermal and load testing" },
  display:      { hours: 60, cert_usd: 0, weeks: 6, cert_rating: 4, note: "panel driver, backlight and touch integration" },
  other:        { hours: 80, cert_usd: 0, weeks: 6, cert_rating: 3, note: "designing the function from parts" },
};
/** Integrating a ready module (carrier or footprint, firmware bring-up), and a radio module's remaining certification. */
const INTEGRATE: Record<string, { hours: number; cert_usd: number; weeks: number }> = {
  radio_module: { hours: 24, cert_usd: 3000, weeks: 3 }, som: { hours: 120, cert_usd: 0, weeks: 8 }, dev_board: { hours: 40, cert_usd: 0, weeks: 3 },
  sensor_module: { hours: 8, cert_usd: 0, weeks: 1 }, power_module: { hours: 8, cert_usd: 0, weeks: 1 }, display: { hours: 20, cert_usd: 0, weeks: 2 },
  other: { hours: 24, cert_usd: 0, weeks: 2 },
};

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "option";

/** The trade study for a need: up to `max` modules (fitting first, then unknown, never ones that miss) and custom. */
export function buildVsBuyStudy(need: Need, matches: ModuleMatch[], max = 4): { question: string; context: string; criteria: Criterion[]; options: TradeOption[]; scores: Scores } {
  const t = TRADE_TEMPLATES.module_vs_custom!;
  const criteria = structuredClone(t.criteria);
  const picked = matches.filter((m) => !m.misses.length).slice(0, max);
  const options: TradeOption[] = [];
  const scores: Scores = {};
  const used = new Set<string>();
  const integ = INTEGRATE[need.kind] ?? INTEGRATE.other!, custom = CUSTOM[need.kind] ?? CUSTOM.other!;
  for (const m of picked) {
    let key = slug(m.module.name); for (let n = 2; used.has(key); n++) key = `${slug(m.module.name)}-${n}`;
    used.add(key);
    options.push({ key, name: m.module.name, mpn: m.module.mpn, manufacturer: m.module.manufacturer,
      description: `${m.module.kind.replace(/_/g, " ")} from the catalog (${m.module.status === "verified" ? "verified entry" : "entry not yet verified"})` +
        (m.unknown.length ? `; not known: ${m.unknown.join(", ")}` : "") });
    const d = m.module.dimensions_mm ?? {};
    const certified = need.regions.length > 0 && need.regions.every((r) => m.module.certifications.some((c) => canon(c.regime) === canon(r)));
    scores[key] = {
      meets_requirements: m.unknown.length ? { value: null, basis: `the catalog does not say: ${m.unknown.join(", ")}` }
        : { value: true, basis: `meets every constraint checked: ${[...need.interfaces, ...need.radios].join(", ") || "kind"}${need.supply_v != null ? `, ${need.supply_v} V supply` : ""}${need.regions.length ? `, certified ${need.regions.join("/")}` : ""}`, source: "catalog" },
      nre: { value: integ.hours * RATE + (certified ? integ.cert_usd : CUSTOM[need.kind]?.cert_usd ?? 0),
             basis: `rule of thumb: ${integ.hours} h integration at $${RATE}/h` + (need.kind === "radio_module" ? (certified ? ` + $${integ.cert_usd} for the product's own testing (module grant reused)` : ` + $${custom.cert_usd} certification (no grant for ${need.regions.join("/") || "your markets"} in the catalog)`) : "") },
      time_to_prototype: { value: integ.weeks, basis: `rule of thumb for integrating a ${m.module.kind.replace(/_/g, " ")}` },
      certification_effort: { value: need.kind === "radio_module" ? (certified ? 5 : 2) : 4, basis: need.kind === "radio_module"
        ? (certified ? `module grants for ${need.regions.join(", ")} in the catalog` : "no module grant recorded for every market") : "no radio certification involved" },
      supply_risk: { value: LIFECYCLE_RATING[m.module.lifecycle] ?? 3, basis: `catalog lifecycle: ${m.module.lifecycle.replace(/_/g, " ")}`, source: "catalog" },
      ...(d.x != null && d.y != null ? { board_area: { value: Math.round(d.x * d.y), basis: `${d.x} x ${d.y} mm footprint from the catalog`, source: "catalog" as const } } : {}),
    };
  }
  options.push({ key: "custom", name: "Custom design (chip-down)", description: `Designed from parts on your own board: ${custom.note}` });
  scores.custom = {
    meets_requirements: { value: true, basis: "a custom design can be made to meet them (at the cost below)" },
    nre: { value: custom.hours * RATE + custom.cert_usd, basis: `rule of thumb: ${custom.hours} h design at $${RATE}/h` + (custom.cert_usd ? ` + $${custom.cert_usd} certification` : "") },
    time_to_prototype: { value: custom.weeks, basis: "rule of thumb, including one board respin" },
    certification_effort: { value: custom.cert_rating, basis: custom.cert_usd ? "full certification of your own radio design" : "rule of thumb" },
    supply_risk: { value: 3, basis: "depends on the parts chosen" },
  };
  const constraints = [need.interfaces.length && `interfaces ${need.interfaces.join(", ")}`, need.radios.length && `radios ${need.radios.join(", ")}`,
    need.supply_v != null && `runs from ${need.supply_v} V`, need.max_dims_mm && (need.max_dims_mm.x || need.max_dims_mm.y) && `fits ${need.max_dims_mm.x ?? "any"} x ${need.max_dims_mm.y ?? "any"}${need.max_dims_mm.z ? ` x ${need.max_dims_mm.z}` : ""} mm`,
    need.regions.length && `certified for ${need.regions.join(", ")}`].filter(Boolean).join("; ");
  const excluded = matches.filter((m) => m.misses.length).map((m) => `${m.module.name}: ${m.misses.join(", ")}`);
  return {
    question: `${need.title}: buy a module or design it?`,
    context: `Build vs buy (${BUILD_VS_BUY_VERSION}). Need: ${constraints || "as described"}${need.quantity ? `; ${need.quantity} units` : ""}. ` +
      `Unit costs come from the parts catalog (Fill from catalog); the custom option's unit cost and every rule of thumb are estimates to edit.` +
      (excluded.length ? ` Catalog modules that do not fit: ${excluded.slice(0, 8).join("; ")}.` : ""),
    criteria, options, scores,
  };
}

// --- Candidate suggestions (the model proposes; distributors confirm) -------------------------------------------
export const ModuleSuggestions = z.object({
  candidates: z.array(z.object({
    name: z.string(), manufacturer: z.string(), mpn: z.string().describe("Orderable manufacturer part number"),
    kind: z.enum(["radio_module", "som", "dev_board", "sensor_module", "power_module", "display", "other"]),
    why: z.string().describe("One sentence: why it fits this need"),
    interfaces: z.array(z.string()), radios: z.array(z.string()),
    supply_v_min: z.number().nullable(), supply_v_max: z.number().nullable(),
    dimensions_mm: z.object({ x: z.number().nullable(), y: z.number().nullable(), z: z.number().nullable() }).nullable(),
    certifications: z.array(z.string()).describe("Regimes the module holds grants for, e.g. FCC, ISED, CE/RED; only ones you are confident of"),
  })).max(8),
});
export type ModuleSuggestions = z.infer<typeof ModuleSuggestions>;

export async function suggestModules(need: Need & { context?: string }, model: LanguageModel): Promise<{ suggestions: ModuleSuggestions; usage: Usage }> {
  const r = await model.generate({
    purpose: "module_suggest", schema: ModuleSuggestions,
    system: "You are a hardware engineer who knows the module market (system-on-modules, radio modules, camera, display, power and sensor modules). " +
      "Suggest ready-made, currently produced modules that meet the need. Give exact orderable part numbers; every one is checked against distributors " +
      "and anything not found is dropped, so do not guess numbers. Prefer modules with long-term availability and existing certifications. " +
      "Give specifications only when you are confident; leave them null otherwise.",
    messages: [{ role: "user", content: `Need: ${need.title}\nKind: ${need.kind}\nInterfaces: ${need.interfaces.join(", ") || "-"}\nRadios: ${need.radios.join(", ") || "-"}\n` +
      `Supply available: ${need.supply_v ?? "-"} V\nSpace: ${need.max_dims_mm ? `${need.max_dims_mm.x ?? "?"} x ${need.max_dims_mm.y ?? "?"} x ${need.max_dims_mm.z ?? "?"} mm` : "-"}\n` +
      `Markets: ${need.regions.join(", ") || "-"}\nQuantity: ${need.quantity ?? "-"}\n${need.context ? `\nContext:\n${need.context}` : ""}\n\nSuggest up to 6 modules.` }],
  });
  return { suggestions: r.output, usage: r.usage };
}

export const OFFLINE_MODULE_SUGGESTIONS: ModuleSuggestions = {
  candidates: [{ name: "Offline stand-in module", manufacturer: "Example", mpn: "OFFLINE-MODULE-1", kind: "other", why: "Offline stand-in: not a real suggestion.",
    interfaces: [], radios: [], supply_v_min: null, supply_v_max: null, dimensions_mm: null, certifications: [] }],
};
