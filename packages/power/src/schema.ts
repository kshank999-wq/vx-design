/**
 * Power tree: the description the model proposes and the calculator checks.
 *
 * Sources feed rails; converters take one rail (or source) and produce another; loads draw current
 * from a rail in each operating mode. Every number says where it came from (basis), so the report can
 * separate datasheet values from requirements and assumptions.
 */
import { z } from "zod";

export const Basis = z.object({
  kind: z.enum(["datasheet", "requirement", "measurement", "calculation", "assumption"]),
  ref: z.string().describe("Datasheet (part number and the stated value), requirement ref code, or why it was assumed"),
});
export type Basis = z.infer<typeof Basis>;

const Range = z.object({ min: z.number(), nom: z.number(), max: z.number() });

export const Chemistry = z.enum(["li_ion", "li_po", "lifepo4", "nimh", "alkaline", "other"]);

export const PowerSource = z.object({
  id: z.string().describe("Rail id of this source, e.g. VBAT, VBUS"),
  kind: z.enum(["battery", "usb", "dc_input", "external"]),
  label: z.string(),
  voltage: Range.describe("Volts at the source terminals: minimum (e.g. battery cut-off), nominal, maximum (e.g. full charge)"),
  max_current_a: z.number().nullable().describe("Continuous current the source can deliver (USB port limit, adapter rating, battery max discharge)"),
  battery: z.object({
    chemistry: Chemistry,
    cells_series: z.number().int(),
    cells_parallel: z.number().int(),
    capacity_mah: z.number().describe("Per cell"),
    usable_fraction: z.number().describe("Share of rated capacity used (cut-off, ageing, temperature), e.g. 0.8"),
  }).nullable(),
  basis: Basis,
});

export const Converter = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(["ldo", "buck", "boost", "buck_boost", "load_switch"]),
  mpn: z.string().nullable(),
  input: z.string().describe("Rail or source id feeding this converter"),
  output_rail: z.string().describe("Rail id it produces, e.g. +3V3"),
  vout: z.number().describe("Output voltage (for a load switch, ignored: the output follows the input)"),
  vin_range: z.object({ min: z.number(), max: z.number() }).nullable().describe("Rated input voltage range"),
  max_output_a: z.number().describe("Rated continuous output current"),
  efficiency: z.number().nullable().describe("Switching converters: efficiency 0-1 at the expected load (null for LDOs and load switches)"),
  quiescent_a: z.number().describe("Ground/quiescent current"),
  dropout_v: z.number().nullable().describe("LDO dropout at full load (null otherwise)"),
  ron_ohm: z.number().nullable().describe("Load switch on-resistance (null otherwise)"),
  theta_ja_c_per_w: z.number().nullable().describe("Junction-to-ambient thermal resistance of the package on this board"),
  tj_max_c: z.number().describe("Maximum junction temperature, usually 125"),
  enable_after: z.string().nullable().describe("Rail whose power-good enables this converter (sequencing), or null"),
  soft_start_ms: z.number().nullable().describe("Output soft-start time, for inrush estimates"),
  basis: Basis,
});

export const Rail = z.object({
  id: z.string(),
  label: z.string(),
  capacitance_uf: z.number().nullable().describe("Total capacitance on the rail, for inrush estimates"),
});

export const Load = z.object({
  id: z.string(),
  label: z.string(),
  rail: z.string(),
  current_a: z.record(z.string(), z.number()).describe("Average current per operating mode id, in amps"),
  peak_a: z.number().nullable().describe("Short peak current (radio TX, backlight, motor start), or null"),
  basis: Basis,
});

export const Mode = z.object({
  id: z.string(),
  label: z.string(),
  hours_per_day: z.number().describe("Typical hours per day in this mode, for the mixed-use battery estimate"),
});

export const PowerTree = z.object({
  name: z.string(),
  title: z.string(),
  summary: z.string(),
  ambient_c: z.object({ nominal: z.number(), max: z.number() }),
  sources: z.array(PowerSource),
  converters: z.array(Converter),
  rails: z.array(Rail),
  loads: z.array(Load),
  modes: z.array(Mode),
  sequencing: z.array(z.object({ before: z.string(), after: z.string(), reason: z.string() }))
    .describe("Rails that must be up before others"),
  assumptions: z.array(z.string()),
  open_questions: z.array(z.string()),
});
export type PowerTree = z.infer<typeof PowerTree>;
export type PowerSource = z.infer<typeof PowerSource>;
export type Converter = z.infer<typeof Converter>;
export type Load = z.infer<typeof Load>;

/** Typical cell voltages (min = common cut-off, max = full charge) used when checking a battery source. */
export const CELL_VOLTAGES: Record<z.infer<typeof Chemistry>, { min: number; nom: number; max: number }> = {
  li_ion: { min: 3.0, nom: 3.6, max: 4.2 },
  li_po: { min: 3.0, nom: 3.7, max: 4.2 },
  lifepo4: { min: 2.5, nom: 3.2, max: 3.65 },
  nimh: { min: 1.0, nom: 1.2, max: 1.45 },
  alkaline: { min: 0.9, nom: 1.5, max: 1.6 },
  other: { min: 0, nom: 0, max: 0 },
};
