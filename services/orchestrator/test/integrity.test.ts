/**
 * Integrity checker against the local Supabase stack: an intact store passes; a missing or altered file is named.
 *   ./scripts/test-integrity.sh  (or pnpm test with SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY set)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { checkIntegrity, listRecords } from "../src/integrity.ts";

const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const skip = !URL || !KEY ? "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required" : false;

test("integrity: intact store passes; missing and altered files are found", { skip }, async () => {
  const db = createClient(URL!, KEY!, { auth: { persistSession: false } });
  const records = await listRecords(db);
  assert.ok(records.length >= 2, "needs at least two stored files (run any e2e test first)");
  const clean = await checkIntegrity(db);
  assert.equal(clean.ok, true, JSON.stringify({ missing: clean.missing.slice(0, 3), mismatched: clean.mismatched.slice(0, 3), chains: clean.chains.broken }));
  const [gone, altered] = records;
  const r = await checkIntegrity(db, { fetch: async (x) => {
    if (x.path === gone!.path) return null;
    const { data } = await db.storage.from(x.bucket).download(x.path);
    const bytes = new Uint8Array(await data!.arrayBuffer());
    if (x.path === altered!.path) bytes[0] = bytes[0]! ^ 0xff;
    return bytes;
  } });
  assert.equal(r.ok, false);
  assert.ok(r.missing.some((m) => m.path === gone!.path));
  assert.ok(r.mismatched.some((m) => m.path === altered!.path));
});
