/** Normalised views of a design, whatever export they came from. Designators are upper-case; pins are "REF.PIN". */

export type Source = "flux_json" | "bom" | "pnp" | "edif" | "ipc356" | "gerber" | "odbpp" | "idf";

export interface ComponentFacts {
  designator: string;
  mpn?: string | null;
  manufacturer?: string | null;
  value?: string | null;
  package?: string | null;
  footprint?: string | null;
  x_mm?: number | null;
  y_mm?: number | null;
  rotation?: number | null;
  side?: "top" | "bottom" | null;
  dnp?: boolean;
  /** Why the part is there, as the designer recorded it (Flux BOM: Role, Role Details, Design Note, Functional Group). */
  design?: DesignNotes | null;
  /** Distributor part numbers recorded with the part (LCSC, DigiKey, Mouser…). */
  suppliers?: Record<string, string>;
}

export interface DesignNotes { role?: string | null; details?: string | null; note?: string | null; group?: string | null; datasheet?: string | null; specification?: string | null }

/** net name -> set of "REF.PIN" */
export type Netlist = Map<string, Set<string>>;

export interface BoardFacts {
  width_mm?: number | null;
  height_mm?: number | null;
  thickness_mm?: number | null;
  copper_layers?: number | null;
  layer_names?: string[];
  min_trace_mm?: number | null;
  min_space_mm?: number | null;
  holes?: { x_mm: number; y_mm: number; d_mm: number }[];
}

export interface AssetRef { name: string; sha256?: string | null; size?: number | null }

export interface ParsedFile {
  source: Source;
  path: string;
  components?: ComponentFacts[];
  nets?: Netlist;
  board?: BoardFacts;
  assets?: AssetRef[];
  meta?: Record<string, unknown>;
  notes: string[];            // what could not be read, in plain words
}

export const pinKey = (ref: string, pin: string) => `${ref.trim().toUpperCase()}.${pin.trim().toUpperCase()}`;
export const normMpn = (s: string | null | undefined) => (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
