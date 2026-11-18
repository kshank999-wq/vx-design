/** pnpm check:integrity — prints the integrity report; exits 1 if anything is missing, changed or broken. */
import { createClient } from "@supabase/supabase-js";
import { checkIntegrity } from "./integrity.ts";

const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required"); process.exit(2); }
const started = Date.now();
const r = await checkIntegrity(createClient(url, key, { auth: { persistSession: false } }));
console.log(`files checked: ${r.checked}; missing: ${r.missing.length}; changed: ${r.mismatched.length}`);
for (const m of r.missing) console.log(`  MISSING  ${m.kind} ${m.id}: ${m.bucket}/${m.path}`);
for (const m of r.mismatched) console.log(`  CHANGED  ${m.kind} ${m.id}: ${m.bucket}/${m.path} (recorded ${m.sha256.slice(0, 12)}, now ${m.actual.slice(0, 12)})`);
console.log(`audit chains checked: ${r.chains.checked}; broken: ${r.chains.broken.length}`);
for (const b of r.chains.broken) console.log(`  BROKEN   ${b.project_id ?? "global"}: ${b.problem} at event ${b.first_bad_seq}`);
console.log(`${r.ok ? "OK" : "PROBLEMS FOUND"} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
process.exit(r.ok ? 0 : 1);
