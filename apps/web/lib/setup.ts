import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

export const PRODUCT_CLASSES: [string, string][] = [["handheld", "Handheld device"], ["wearable", "Wearable"], ["iot_sensor", "IoT / sensor"],
  ["desktop_av", "Desktop / AV gear"], ["industrial", "Industrial"], ["automotive", "Automotive"], ["medical", "Medical"], ["other", "Other"]];
export const MARKETS = ["US", "EU", "UK", "Canada", "Japan", "Australia", "China"];
export const RADIOS = ["Wi-Fi", "Bluetooth LE", "LoRa", "Cellular", "NFC", "GPS", "None"];
export const STANDARDS = ["FCC Part 15", "CE RED", "UKCA", "ISED", "UL 62368-1", "IP54", "IP67", "RoHS", "REACH"];
export const POWER = ["Rechargeable Li-ion", "USB-C", "AA / AAA cells", "Mains (AC)", "PoE", "12 V DC"];
export const SETUP_STEPS = [
  { key: "project", title: "Project", sub: "Name, purpose, class" },
  { key: "mockup", title: "Mock-up", sub: "Look, references, concepts" },
  { key: "intake", title: "Intake", sub: "Use, markets, power, radios" },
  { key: "inputs", title: "Inputs", sub: "Specs, parts, prior work" },
  { key: "plan", title: "Review & plan", sub: "Check and launch" },
] as const;

export interface SetupState {
  project: { name: string; description: string | null; code: string | null; product_class: string | null };
  intake: Record<string, unknown> | null;
  counts: { visuals: number; concepts: number; specs: number; requirements: number; parts: number; prior: number; registerReady: boolean; plans: number };
  checks: { key: string; label: string; done: boolean; step: number }[];
  readiness: number;
  stepDone: boolean[];
  log: { at: string; text: string }[];
}

const EVENT: Record<string, string> = {
  "project.identity_saved": "project details saved", "intake.saved": "intake saved", "reference.added": "reference added",
  "part.recorded": "part recorded", "prior_work.requested": "earlier-work list requested", "plan.created": "plan generated",
  "requirements.extracted": "requirements extracted", "document.uploaded": "specification uploaded", "concepts.requested": "concept round requested",
};

/** What the guided setup knows about a project: what is filled in, how ready it is to plan, and recent activity. */
export async function setupState(supabase: SupabaseClient, projectId: string): Promise<SetupState | null> {
  const count = (q: PromiseLike<{ count: number | null }>) => q.then((r) => r.count ?? 0);
  const [{ data: project }, { data: intake }, visuals, concepts, specs, requirements, parts, prior, { data: reg }, plans, { data: events }] = await Promise.all([
    supabase.from("projects").select("name, description, code, product_class").eq("id", projectId).maybeSingle(),
    supabase.from("project_intake").select("*").eq("project_id", projectId).maybeSingle(),
    count(supabase.from("project_references").select("id", { count: "exact", head: true }).eq("project_id", projectId).is("part_id", null).not("kind", "in", "(prior_design,datasheet,model_3d)")),
    count(supabase.from("concept_rounds").select("id", { count: "exact", head: true }).eq("project_id", projectId)),
    count(supabase.from("documents").select("id", { count: "exact", head: true }).eq("project_id", projectId)),
    count(supabase.from("requirements").select("id", { count: "exact", head: true }).eq("project_id", projectId).neq("status", "rejected")),
    count(supabase.from("project_parts").select("id", { count: "exact", head: true }).eq("project_id", projectId)),
    count(supabase.from("flux_audits").select("id", { count: "exact", head: true }).eq("project_id", projectId).eq("status", "ready")),
    supabase.from("prior_work_registers").select("id").eq("project_id", projectId).eq("status", "ready").limit(1).maybeSingle(),
    count(supabase.from("plans").select("id", { count: "exact", head: true }).eq("project_id", projectId)),
    supabase.from("audit_events").select("event_type, created_at").eq("project_id", projectId).order("id", { ascending: false }).limit(6),
  ]);
  if (!project) return null;
  const i = intake as Record<string, unknown> | null;
  const has = (k: string) => { const v = i?.[k]; return Array.isArray(v) ? v.length > 0 : v != null && v !== ""; };
  const checks = [
    { key: "identity", label: "Name and purpose", done: !!project.name && !!project.description, step: 0 },
    { key: "class", label: "Product class", done: !!project.product_class, step: 0 },
    { key: "visuals", label: "A mock-up, reference or concept", done: visuals + concepts > 0, step: 1 },
    { key: "use", label: "Intended use", done: has("intended_use"), step: 2 },
    { key: "markets", label: "Markets", done: has("regions"), step: 2 },
    { key: "qty", label: "Production quantity", done: has("quantity"), step: 2 },
    { key: "power", label: "Power source", done: has("power_source"), step: 2 },
    { key: "specs", label: "A specification", done: specs > 0, step: 3 },
    { key: "reqs", label: "Requirements extracted", done: requirements > 0, step: 3 },
    { key: "prior", label: "Parts chosen or prior work (if any)", done: parts + prior > 0 || !!reg, step: 3 },
    { key: "plan", label: "A plan", done: plans > 0, step: 4 },
  ];
  const stepDone = [0, 1, 2, 3, 4].map((s) => checks.filter((c) => c.step === s).every((c) => c.done));
  return {
    project, intake: i, checks, stepDone,
    counts: { visuals, concepts, specs, requirements, parts, prior, registerReady: !!reg, plans },
    readiness: Math.round(100 * checks.filter((c) => c.done).length / checks.length),
    log: (events ?? []).map((e) => ({ at: e.created_at as string, text: EVENT[e.event_type as string] ?? (e.event_type as string).replace(/[._]/g, " ") })),
  };
}
