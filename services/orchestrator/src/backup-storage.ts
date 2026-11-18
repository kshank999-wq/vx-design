/**
 * Storage backup for the recovery drill (G6): downloads the listed objects ("bucket<TAB>path" lines on stdin) into
 * <out>/<bucket>/<path> and writes <out>/manifest.json with each file's sha256 and size.
 *   node backup-storage.ts <out>   (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createClient } from "@supabase/supabase-js";

const out = process.argv[2];
if (!out) { console.error("usage: backup-storage.ts <out-dir>"); process.exit(2); }
const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const items = readFileSync(0, "utf8").split("\n").filter(Boolean).map((l) => { const [bucket, ...p] = l.split("\t"); return { bucket: bucket!, path: p.join("\t") }; });
const manifest: { bucket: string; path: string; sha256: string; size: number }[] = [];
const failed: string[] = [];
const queue = [...items];
await Promise.all(Array.from({ length: 8 }, async () => {
  for (let it = queue.shift(); it; it = queue.shift()) {
    const { data, error } = await db.storage.from(it.bucket).download(it.path);
    if (error || !data) { failed.push(`${it.bucket}/${it.path}: ${error?.message}`); continue; }
    const bytes = new Uint8Array(await data.arrayBuffer());
    if (it.path.split("/").includes("..")) { failed.push(`${it.bucket}/${it.path}: unsafe path`); continue; }
    const file = join(out, it.bucket, it.path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
    manifest.push({ ...it, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length });
  }
}));
manifest.sort((a, b) => (a.bucket + a.path < b.bucket + b.path ? -1 : 1));
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 1));
console.log(`storage: ${manifest.length} object(s) backed up${failed.length ? `, ${failed.length} failed` : ""}`);
for (const f of failed) console.error(`  ${f}`);
process.exit(failed.length ? 1 : 0);
