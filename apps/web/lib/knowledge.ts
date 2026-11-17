import type { createClient } from "./supabase/server";

type Supabase = Awaited<ReturnType<typeof createClient>>;

export const LICENSES = {
  public_domain: { label: "Public domain", excerpts: true, file: true,
    help: "e.g. US federal regulations. Excerpts are indexed and the file is kept." },
  open_license: { label: "Open licence", excerpts: true, file: true,
    help: "CC BY, EU legal texts and similar. Excerpts are indexed and the file is kept, with attribution." },
  vendor_terms: { label: "Manufacturer document", excerpts: true, file: false,
    help: "Datasheets and application notes: excerpts are indexed for engineering use; the file stays on the vendor's site." },
  reference_only: { label: "Reference only", excerpts: false, file: false,
    help: "Copyrighted standards and books (IPC, IEC, ISO): metadata and the official link only, no text." },
  licensed_copy: { label: "Licensed copy (this project)", excerpts: true, file: true,
    help: "A copy your organisation licensed or received under NDA: kept privately for one project, never shared." },
  unknown: { label: "Unknown", excerpts: false, file: false,
    help: "Treated as reference only until someone checks the terms." },
} as const;
export type License = keyof typeof LICENSES;

export const SOURCE_KINDS = ["standard", "regulation", "datasheet", "application_note", "vendor_rule", "tool_documentation", "reference", "other"] as const;

export const APPLICABILITY: Record<string, string> = { applies: "Applies", may_apply: "May apply", does_not_apply: "Does not apply" };

export interface KnowledgeHit {
  result_kind: "excerpt" | "source" | "standard";
  source_id: string | null;
  standard_id: string | null;
  project_id: string | null;
  kind: string;
  title: string;
  identifier: string | null;
  publisher: string;
  official_url: string | null;
  edition: string | null;
  license: License;
  excerpt_allowed: boolean;
  status: string;
  last_verified_at: string | null;
  locator: string | null;
  snippet: string | null;
  rank: number;
}

export async function searchKnowledge(supabase: Supabase, query: string, projectId: string | null, limit = 10): Promise<KnowledgeHit[]> {
  if (!query.trim()) return [];
  const { data, error } = await supabase.rpc("search_knowledge", { p_query: query.slice(0, 500), p_project_id: projectId, p_limit: limit });
  if (error) throw new Error(`Knowledge search failed: ${error.message}`);
  return (data ?? []) as KnowledgeHit[];
}

/** One-line citation: "IPC-2152 (IPC), edition unconfirmed · reference only". */
export function citation(h: KnowledgeHit): string {
  const name = h.identifier ? `${h.identifier} ${h.title}` : h.title;
  const edition = h.edition ? `edition ${h.edition}` : "edition unconfirmed";
  const verified = h.result_kind === "standard" ? (h.status === "reviewed" ? "reviewed" : "not yet reviewed")
    : h.status === "verified" ? "verified" : "unverified";
  return `${name} (${h.publisher})${h.locator ? `, ${h.locator}` : ""}; ${edition}; ${LICENSES[h.license]?.label.toLowerCase() ?? h.license}; ${verified}`;
}
