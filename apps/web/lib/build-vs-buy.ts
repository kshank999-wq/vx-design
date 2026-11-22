import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeMpn } from "@vx/integrations";
import type { CatalogModule, ModuleSuggestions, Need } from "@vx/planning";
import { lookupPart } from "@/lib/part-lookup";

/** Markets as a project records them (US, EU…) → the radio certification each needs. */
export const REGION_CERT: Record<string, string> = { US: "FCC", CA: "ISED", EU: "CE/RED", UK: "UKCA", JP: "TELEC", AU: "RCM", NZ: "RCM", KR: "KC", CN: "SRRC", IN: "WPC" };
export const certsForRegions = (regions: string[]) => [...new Set(regions.map((r) => REGION_CERT[r.toUpperCase()] ?? r).filter(Boolean))];

/** What kind of module a subsystem name suggests. */
export function guessKind(title: string): string {
  const t = title.toLowerCase();
  if (/radio|wi-?fi|bluetooth|\bble\b|lora|gnss|\bgps\b|cellular|\blte\b|\brf\b|wireless|zigbee|thread|uwb/.test(t)) return "radio_module";
  if (/\bsom\b|compute|processor|\bsoc\b|\bcpu\b|linux|host|main board|application processor/.test(t)) return "som";
  if (/display|screen|lcd|oled|touch/.test(t)) return "display";
  if (/power|battery|charger|\bbms\b|regulator|converter|supply/.test(t)) return "power_module";
  if (/camera|sensor|imu|microphone|mic\b|hall|accelerometer/.test(t)) return "sensor_module";
  return "other";
}

const num = (s: string | null | undefined) => (s && s.trim() !== "" && Number.isFinite(Number(s)) ? Number(s) : null);
const list = (s: string | null | undefined) => (s ?? "").split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);

/** A need from the page's form or query (the same field names). */
export function readNeed(get: (k: string) => string | null): Need {
  const dims = { x: num(get("max_x")) ?? undefined, y: num(get("max_y")) ?? undefined, z: num(get("max_z")) ?? undefined };
  const title = (get("title") ?? "").trim();
  return {
    title, kind: get("kind") || guessKind(title), interfaces: list(get("interfaces")), radios: list(get("radios")),
    supply_v: num(get("supply_v")), max_dims_mm: dims.x || dims.y || dims.z ? dims : null, regions: list(get("regions")),
    quantity: num(get("quantity")), requirement_refs: list(get("requirements")),
  };
}

export async function catalogModules(supabase: SupabaseClient): Promise<CatalogModule[]> {
  const { data } = await supabase.from("modules").select("id, kind, name, manufacturer, mpn, status, lifecycle, interfaces, radios, supply, dimensions_mm, certifications").limit(2000);
  return (data ?? []) as CatalogModule[];
}

/**
 * Keeps the model's suggestions that a distributor (or the saved parts catalog) confirms by part number, and adds each
 * new one to the modules catalog as a draft that says where it came from. The model's specifications go in as stated
 * and unverified; its certification claims are kept as a note, never as a certification (those need a grant).
 */
export async function addConfirmedSuggestions(supabase: SupabaseClient, need: Need, s: ModuleSuggestions):
    Promise<{ added: string[]; existing: string[]; unconfirmed: string[]; errors: string[] }> {
  const out = { added: [] as string[], existing: [] as string[], unconfirmed: [] as string[], errors: [] as string[] };
  const today = new Date().toISOString().slice(0, 10);
  for (const c of s.candidates) {
    const n = normalizeMpn(c.mpn);
    const { data: known } = await supabase.from("modules").select("id").eq("normalized_mpn", n).limit(1);
    if (known?.length) { out.existing.push(c.name); continue; }
    const hit = await lookupPart(supabase, [c.mpn]);
    if (!hit) { out.unconfirmed.push(`${c.name} (${c.mpn})`); continue; }
    const d = c.dimensions_mm;
    const performance: Record<string, string> = { "Suggested for": need.title, "Why": c.why };
    if (c.certifications.length) performance["Certifications (claimed by the model, unverified)"] = c.certifications.join(", ");
    for (const sp of hit.identity.specs.slice(0, 8)) performance[sp.name] = sp.value;
    const mod = {
      kind: c.kind, name: c.name, manufacturer: hit.identity.manufacturer || c.manufacturer, mpn: hit.identity.mpn || c.mpn,
      normalized_mpn: normalizeMpn(hit.identity.mpn || c.mpn), description: hit.identity.title,
      interfaces: c.interfaces, radios: c.radios,
      supply: Object.fromEntries(Object.entries({ v_min: c.supply_v_min, v_max: c.supply_v_max }).filter(([, v]) => v != null)),
      dimensions_mm: d ? Object.fromEntries(Object.entries(d).filter(([, v]) => v != null)) : {},
      performance, certifications: [], cad: [],
      lifecycle: hit.identity.specs.find((x) => x.name === "Lifecycle")?.value.replace(/ /g, "_").toLowerCase() || "unknown",
      source_url: "", checked_on: today,
      source_note: `Suggested by AI for "${need.title}" on ${today}; part number confirmed at ${hit.source}. ` +
        "Interfaces, supply, size and certifications are as the model stated them: check them against the datasheet, then verify.",
    };
    if (!["active", "nrnd", "last_time_buy", "obsolete", "unknown"].includes(mod.lifecycle)) mod.lifecycle = "unknown";
    const { error } = await supabase.rpc("save_module", { p_id: null, p_module: mod });
    if (error) out.errors.push(`${c.name}: ${error.message}`); else out.added.push(c.name);
  }
  return out;
}
