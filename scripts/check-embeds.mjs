// Runs every Supabase select with an embedded relation in the web app and worker against the local API (limit 0),
// so a new table that makes a join ambiguous (PostgREST PGRST201) fails here instead of as a "not found" page.
// Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (./scripts/test-e2e-embeds.sh sets them).
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const { SUPABASE_URL: URL, SUPABASE_SERVICE_ROLE_KEY: KEY } = process.env;
if (!URL || !KEY) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
const files = execSync("git ls-files 'apps/web/app/*.ts' 'apps/web/app/*.tsx' 'apps/web/lib/*.ts' 'apps/web/components/*.tsx' 'services/orchestrator/src/*.ts'",
                       { encoding: "utf8" }).trim().split("\n").filter(Boolean);
const seen = new Set(), bad = [];
for (const f of files) {
  const re = /\.from\("([a-z_]+)"\)\s*\.select\("([^"]*\([^"]*)"/g;
  for (const m of readFileSync(f, "utf8").matchAll(re)) {
    const key = `${m[1]}|${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const r = await fetch(`${URL}/rest/v1/${m[1]}?select=${encodeURIComponent(m[2].replace(/\s+/g, ""))}&limit=0`,
                          { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
    if (!r.ok) { const j = await r.json().catch(() => ({})); bad.push(`${f}: ${m[1]}: ${j.code ?? r.status} ${(j.message ?? "").slice(0, 160)}`); }
  }
}
if (bad.length) { console.error(`${bad.length} select(s) fail:\n${bad.join("\n")}`); process.exit(1); }
console.log(`Embedded selects check passed (${seen.size} selects).`);
