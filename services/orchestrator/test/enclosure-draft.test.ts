// The draft an enclosure needs comes from its parts' manufacturing routes (material minimum plus finish).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { WorkerDb } from "../src/db.ts";

const { SUPABASE_URL: URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE, SUPABASE_ANON_KEY: ANON } = process.env;

test("enclosure draft from the manufacturing routes", { skip: !URL || !SERVICE || !ANON }, async () => {
  const admin = createClient(URL!, SERVICE!, { auth: { persistSession: false } });
  const email = `draft-${Date.now()}@example.test`, password = "correct-horse-battery";
  assert.ifError((await admin.auth.admin.createUser({ email, password, email_confirm: true })).error);
  const user = createClient(URL!, ANON!, { auth: { persistSession: false } });
  assert.ifError((await user.auth.signInWithPassword({ email, password })).error);
  const { data: project } = await user.from("projects").insert({ name: "Draft test" }).select("id").single();
  const db = new WorkerDb(URL!, SERVICE!);
  assert.deepEqual(await db.enclosureDraft(project!.id, "enclosure"), { deg: 0, why: null }, "no routes: straight walls");
  const save = (name: string, source: string | null, process: string, material: string) => user.rpc("save_part_route", { p_project: project!.id, p_id: null,
    p_name: name, p_source_key: source, p_needs: {}, p_prototype_option: "fdm_asa", p_prototype_qty: 1, p_production_process: process,
    p_production_material: material, p_production_volume: 5000, p_finish: null, p_notes: null });
  const { data: base } = await save("Enclosure base", "artifact:enclosure/base", "injection_molding", "pc_abs");
  assert.equal((await db.enclosureDraft(project!.id, "enclosure")).deg, 1);
  assert.ifError((await user.rpc("save_part_molding", { p_id: base, p_molding: { finish: "MT-11010" } })).error);
  const d = await db.enclosureDraft(project!.id, "enclosure");
  assert.equal(d.deg, 2.5, "a light texture adds 1.5°");
  assert.match(d.why!, /Enclosure base is injection molded in pc_abs with a MT-11010 finish/);
  assert.equal((await db.enclosureDraft(project!.id, "other-task")).deg, 2.5, "matched by name too");
  await save("Bracket", null, "injection_molding", "pa66_gf");
  await save("Enclosure lid", "artifact:enclosure/lid", "cnc", "al6061");
  assert.equal((await db.enclosureDraft(project!.id, "enclosure")).deg, 2.5, "other parts and machined lids do not change it");
});
