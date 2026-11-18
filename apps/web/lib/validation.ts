export const STAGES: Record<string, string> = {
  incoming_inspection: "Incoming inspection", bring_up: "Bring-up", functional: "Functional", firmware: "Firmware",
  fit_finish: "Fit and finish", environmental: "Environmental", other: "Other",
};

export interface MeasurementDef {
  key: string; label: string; kind: "numeric" | "boolean" | "text"; unit?: string; min?: number; max?: number; expected?: string;
  requirement_ref?: string; basis?: string;
}

/** "3.2 – 3.4 V", "≥ 8 h", "yes", "—" */
export function limitText(m: { kind: string; unit?: string | null; min?: number | null; max?: number | null; expected?: string | null }): string {
  const u = m.unit ? ` ${m.unit}` : "";
  if (m.kind === "numeric") {
    if (m.min != null && m.max != null) return `${m.min} – ${m.max}${u}`;
    if (m.min != null) return `≥ ${m.min}${u}`;
    if (m.max != null) return `≤ ${m.max}${u}`;
    return "recorded only";
  }
  return m.expected ?? "recorded only";
}
