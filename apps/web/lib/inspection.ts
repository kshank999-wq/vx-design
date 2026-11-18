/** Shared labels for inspection plans. */
export const planCode = (n: number, v: number) => `IP-${String(n).padStart(3, "0")} v${v}`;
export const KIND_LABEL: Record<string, string> = { bare_pcb: "Bare board", pcba: "Assembled board", enclosure: "Enclosure" };
export const PLAN_PILL: Record<string, string> = { draft: "awaiting_approval", approved: "complete", superseded: "" };
export const STAGE_LABEL: Record<string, string> = { incoming: "incoming", in_process: "in-process", final: "final" };
