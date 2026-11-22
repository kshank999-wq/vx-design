"use server";
import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { datasheetText, extractRequirements, identifyPart, matchModelToPart, stepNames } from "@vx/planning";
import { fail, requireUser } from "@/lib/auth";
import { getModel } from "@/lib/model";
import { formFile } from "@/lib/staged";
import { POLICIES, uploadProblem } from "@/lib/uploads";
import { markExtractionFailed, persistExtraction, prepareExtraction, storeDocument, type PreparedExtraction } from "@/lib/documents";
import { REFERENCE_KINDS } from "@/lib/plan-inputs";

const base = (projectId: string) => `/projects/${projectId}/inputs`;
/** The inputs page at the step the form was sent from (the page is one step at a time). */
async function here(projectId: string): Promise<string> {
  const ref = (await headers()).get("referer") ?? "";
  const step = /[?&]step=(\d)/.exec(ref)?.[1];
  return `${base(projectId)}${step ? `?step=${step}` : ""}`;
}
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
function go(path: string, notice: string): never {
  revalidatePath(path.split("?")[0]!);
  redirect(`${path}${path.includes("?") ? "&" : "?"}notice=${encodeURIComponent(notice)}`);
}
export interface UploadOutcome { ok: boolean; message: string }

/** One staged file (see StagedFileInput / InputsUpload) as a File, removing the staged copy. */
async function staged(supabase: Awaited<ReturnType<typeof requireUser>>["supabase"], ref: string, name: string, type: string) {
  const f = new FormData();
  f.set("file__staged", ref); f.set("file__name", name); f.set("file__type", type);
  return formFile(supabase, f, "file");
}

type Supa = Awaited<ReturnType<typeof requireUser>>["supabase"];
/** Stores one file as a project reference (checked, content-addressed); returns its id or a problem. */
async function storeReference(supabase: Supa, projectId: string, name: string, mime: string, bytes: Uint8Array, kind: string, title: string, note: string | null):
    Promise<{ id: string } | { problem: string }> {
  const refused = uploadProblem(name, bytes, POLICIES.reference);
  if (refused) return { problem: `${name}: ${refused}` };
  const sha = createHash("sha256").update(bytes).digest("hex");
  const path = `${projectId}/references/${sha.slice(0, 16)}-${name.replace(/[^\w.-]+/g, "_").slice(-120)}`;
  const { error: upErr } = await supabase.storage.from("project-files").upload(path, bytes, { contentType: mime, upsert: false });
  if (upErr && !/exists|duplicate/i.test(upErr.message)) return { problem: `${name}: ${upErr.message}` };
  const { data, error } = await supabase.rpc("add_project_reference", {
    p_project: projectId, p_kind: kind, p_title: title.trim() || name.replace(/\.[^.]+$/, ""), p_note: note,
    p_filename: name, p_path: path, p_sha256: sha, p_size: bytes.length, p_mime: mime,
  });
  if (error) { if (!upErr) await supabase.storage.from("project-files").remove([path]); return { problem: `${name}: ${error.message}` }; }
  return { id: data as string };
}

const PACKAGE_FILE = /\.(pdf|docx|txt|md|step|stp|stl|igs|iges|wrl|x_t|x_b)$/i;
const JUNK = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$|desktop\.ini$|\._)/i;
const MIME: Record<string, string> = { pdf: "application/pdf", step: "application/step", stp: "application/step", stl: "model/stl", txt: "text/plain", md: "text/markdown",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };

/**
 * A manufacturer's package (ZIP): its datasheets and 3D models become part files, each noted with the package it came
 * from (so a model with no part number in it can still be matched to the part its own package describes).
 */
async function expandPackage(supabase: Supa, projectId: string, zipName: string, bytes: Uint8Array): Promise<{ added: number; skipped: number; problems: string[] }> {
  const { unzipSync } = await import("fflate");
  let entries: Record<string, Uint8Array>;
  try {
    let total = 0;
    entries = unzipSync(bytes, { filter: (f) => { total += f.originalSize; return total < 400_000_000 && !f.name.endsWith("/") && !JUNK.test(f.name) && PACKAGE_FILE.test(f.name); } });
  } catch (e) { return { added: 0, skipped: 0, problems: [`${zipName}: not a readable ZIP (${(e as Error).message})`] }; }
  const pkg = zipName.replace(/\.zip$/i, "");
  const names = Object.keys(entries).slice(0, 200);
  const base = (n: string) => n.split("/").pop()!;
  const seen = new Set<string>();
  let added = 0; const problems: string[] = [];
  for (const n of names) {
    let name = base(n);
    if (seen.has(name.toLowerCase())) name = `${pkg}-${name}`;
    seen.add(name.toLowerCase());
    const ext = name.split(".").pop()!.toLowerCase();
    const kind = /\.(pdf|docx|txt|md)$/i.test(name) ? "datasheet" : "model_3d";
    const r = await storeReference(supabase, projectId, name, MIME[ext] ?? "application/octet-stream", entries[n]!, kind, name.replace(/\.[^.]+$/, ""), `From the package ${pkg}`);
    if ("problem" in r) problems.push(r.problem); else added++;
  }
  return { added, skipped: Object.keys(entries).length - names.length, problems };
}

/** A part package (ZIP) dropped on Parts chosen: opened, its datasheets and models stored as part files. */
export async function addPartPackage(projectId: string, ref: string, name: string, type: string): Promise<UploadOutcome> {
  const { supabase } = await requireUser();
  try {
    const file = await staged(supabase, ref, name, type);
    if (!file) return { ok: false, message: `${name}: the file did not arrive; choose it again.` };
    const bytes = new Uint8Array(await file.arrayBuffer());
    const refused = uploadProblem(name, bytes, POLICIES.reference);
    if (refused) return { ok: false, message: `${name}: ${refused}` };
    const r = await expandPackage(supabase, projectId, name, bytes);
    revalidatePath(base(projectId));
    if (!r.added) return { ok: false, message: `${name}: no datasheets or 3D models inside${r.problems.length ? ` (${r.problems.join("; ")})` : ""}` };
    return { ok: !r.problems.length, message: `${name}: ${r.added} file(s) unpacked${r.problems.length ? `; not stored: ${r.problems.join("; ")}` : ""}` };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

/**
 * ZIP packages that were added as references (on another step) before Parts chosen took them: each is opened into part
 * files, the ZIP reference is removed, and the files are read.
 */
export async function readPackagesAsParts(projectId: string) {
  const { supabase } = await requireUser();
  const { data: zips } = await supabase.from("project_references").select("id, filename, storage_path").eq("project_id", projectId)
    .is("part_id", null).in("kind", ["other", "datasheet", "prior_design"]).ilike("filename", "%.zip");
  const lines: string[] = [];
  for (const z of zips ?? []) {
    const { data } = await supabase.storage.from("project-files").download(z.storage_path);
    if (!data) { lines.push(`${z.filename}: could not be read`); continue; }
    const r = await expandPackage(supabase, projectId, z.filename, new Uint8Array(await data.arrayBuffer()));
    if (r.added) {
      const { data: path } = await supabase.rpc("remove_project_reference", { p_id: z.id });
      if (path) await supabase.storage.from("project-files").remove([path as string]);
    }
    lines.push(`${z.filename}: ${r.added ? `${r.added} file(s)` : "nothing to read inside"}${r.problems.length ? ` (${r.problems.length} not stored)` : ""}`);
  }
  const read = await identifyPartFiles(projectId);
  go(`${base(projectId)}?step=3`, `Unpacked ${lines.join("; ")}. ${read.message}`);
}

/** A specification staged by the browser: checked, parsed and stored like an ordinary upload. */
export async function addSpecification(projectId: string, ref: string, name: string, type: string): Promise<UploadOutcome> {
  const { supabase, userId } = await requireUser();
  try {
    const file = await staged(supabase, ref, name, type);
    if (!file) return { ok: false, message: `${name}: the file did not arrive; choose it again.` };
    const r = await storeDocument(supabase, userId, projectId, file);
    revalidatePath(base(projectId));
    return { ok: true, message: `${name}: ${r.sections} sections` };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

/**
 * Extracts requirements from every document not yet extracted (or whose extraction failed). The model reads them at
 * the same time; the results are stored one after another so requirement numbers continue across documents.
 */
export async function extractAll(projectId: string) {
  const path = await here(projectId);
  const { supabase } = await requireUser();
  let choice;
  try { choice = getModel(); } catch (e) { fail(path, e); }
  const { data: docs } = await supabase.from("documents").select("id, title, extraction_status").eq("project_id", projectId).in("extraction_status", ["pending", "failed"]).order("created_at");
  if (!docs?.length) fail(path, "Every document has been extracted. Re-extract one from its row if it changed.");
  const ready: PreparedExtraction[] = [];
  const problems: string[] = [];
  for (const d of docs) {
    try { ready.push(await prepareExtraction(supabase, d.id)); } catch (e) { problems.push((e as Error).message); }
  }
  const results = await Promise.allSettled(ready.map((p) => extractRequirements(p.parsed, choice.model)));
  let total = 0, done = 0;
  for (const [i, r] of results.entries()) {
    const p = ready[i]!;
    try {
      if (r.status === "rejected") throw r.reason as Error;
      total += await persistExtraction(supabase, projectId, p, r.value, choice);
      done++;
    } catch (e) {
      await markExtractionFailed(supabase, p.id, (e as Error).message, choice.label);
      problems.push(`${p.title}: ${(e as Error).message}`);
    }
  }
  revalidatePath(base(projectId));
  const msg = `Extracted ${total} requirement(s) from ${done} document(s).${problems.length ? ` Not extracted: ${problems.join(" | ")}` : ""}`;
  if (problems.length && !done) fail(path, msg);
  redirect(`${path}${path.includes("?") ? "&" : "?"}notice=${encodeURIComponent(msg)}`);
}

/** A mock-up, sketch, drawing or prior-work file staged by the browser: checked, stored under references/ and numbered. */
export async function addReference(projectId: string, ref: string, name: string, type: string, kind: string, title: string, note: string, partId?: string): Promise<UploadOutcome> {
  const { supabase } = await requireUser();
  try {
    if (!REFERENCE_KINDS.some(([k]) => k === kind)) return { ok: false, message: "Choose what kind of reference this is." };
    const file = await staged(supabase, ref, name, type);
    if (!file) return { ok: false, message: `${name}: the file did not arrive; choose it again.` };
    const bytes = new Uint8Array(await file.arrayBuffer());
    const refused = uploadProblem(name, bytes, POLICIES.reference);
    if (refused) return { ok: false, message: `${name}: ${refused}` };
    const sha = createHash("sha256").update(bytes).digest("hex");
    const path = `${projectId}/references/${sha.slice(0, 16)}-${name.replace(/[^\w.-]+/g, "_").slice(-120)}`;
    const mime = file.type || "application/octet-stream";
    const { error: upErr } = await supabase.storage.from("project-files").upload(path, bytes, { contentType: mime, upsert: false });
    if (upErr && !/exists|duplicate/i.test(upErr.message)) return { ok: false, message: `${name}: ${upErr.message}` };
    const { data, error } = await supabase.rpc("add_project_reference", {
      p_project: projectId, p_kind: kind, p_title: title.trim() || name.replace(/\.[^.]+$/, ""), p_note: note || null,
      p_filename: name, p_path: path, p_sha256: sha, p_size: bytes.length, p_mime: mime,
    });
    if (error) {
      if (!upErr) await supabase.storage.from("project-files").remove([path]);
      return { ok: false, message: `${name}: ${error.message}` };
    }
    if (partId) {
      const { error: attErr } = await supabase.rpc("attach_reference_to_part", { p_reference: data as string, p_part: partId });
      if (attErr) return { ok: false, message: `${name}: stored, but not attached to the part (${attErr.message})` };
    }
    revalidatePath(base(projectId));
    return { ok: true, message: `${name}: ${partId ? "attached" : "added"}` };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

export async function updateReference(projectId: string, id: string, form: FormData) {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("update_project_reference", { p_id: id, p_kind: str(form, "kind"), p_title: str(form, "title"),
    p_note: str(form, "note") || null, p_use_in_plan: form.get("use_in_plan") === "on" });
  if (error) fail(await here(projectId), error);
  go(await here(projectId), "Reference saved.");
}

export async function removeReference(projectId: string, id: string) {
  const { supabase } = await requireUser();
  const { data: path, error } = await supabase.rpc("remove_project_reference", { p_id: id });
  if (error) fail(await here(projectId), error);
  await supabase.storage.from("project-files").remove([path as string]);
  go(await here(projectId), "Reference removed.");
}

export async function setAuditInPlan(projectId: string, auditId: string, use: boolean) {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("set_flux_audit_in_plan", { p_audit: auditId, p_use: use });
  if (error) fail(await here(projectId), error);
  go(await here(projectId), use ? "The plan will build on this prior work." : "The plan will not use this prior work.");
}

/** A part already chosen (or a candidate): added, or edited when partId is given. */
export async function savePart(projectId: string, partId: string | null, form: FormData) {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("save_project_part", {
    p_project: projectId, p_id: partId, p_mpn: str(form, "mpn"), p_manufacturer: str(form, "manufacturer") || null, p_role: str(form, "role"),
    p_subsystem: str(form, "subsystem") || "other", p_status: str(form, "status") || "selected", p_note: str(form, "note") || null,
  });
  if (error) fail(await here(projectId), error);
  go(await here(projectId), partId ? "Part saved." : `${str(form, "mpn")} added. Attach its datasheet and 3D model below it.`);
}

/** Removes a part; its files stay as project files, no longer attached. */
export async function removePart(projectId: string, partId: string) {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("remove_project_part", { p_id: partId });
  if (error) fail(await here(projectId), error);
  go(await here(projectId), "Part removed. Its files are kept under Prior work; remove them there if they are not needed.");
}

/** Asks a worker to read every earlier design document and list what was already done. */
export async function requestRegister(projectId: string) {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("request_prior_work_register", { p_project: projectId });
  if (error) fail(await here(projectId), error);
  go(await here(projectId), "A worker is reading the earlier work. This page updates by itself; the list appears when it is ready.");
}

/** A person's correction to one item of the register: status, a note, or leaving it out. Kept across rebuilds. */
export async function editRegisterItem(projectId: string, registerId: string, itemId: string, form: FormData) {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("edit_prior_work_item", {
    p_register: registerId, p_item: itemId, p_status: str(form, "status") || null, p_note: str(form, "note") || null, p_excluded: form.get("excluded") === "on",
  });
  if (error) fail(await here(projectId), error);
  go(await here(projectId), `${itemId} saved.`);
}

const PART_FILE_KINDS_READ = ["datasheet", "model_3d"];
const READ_AT_ONCE = 8;

/**
 * Reads the part files not yet read: each datasheet becomes a part (part number, manufacturer, what it is, subsystem,
 * key specs) with the file attached; each 3D model is attached to the part whose number is inside it or in its name.
 * What cannot be read is noted for a person. Datasheets are read a few at a time.
 */
export async function identifyPartFiles(projectId: string): Promise<UploadOutcome> {
  const { supabase } = await requireUser();
  let choice;
  try { choice = getModel(); } catch (e) { return { ok: false, message: (e as Error).message }; }
  const { data: files } = await supabase.from("project_references").select("id, filename, kind, storage_path, note").eq("project_id", projectId)
    .is("part_id", null).is("identified_at", null).in("kind", PART_FILE_KINDS_READ).order("ref_no");
  const pkgOf = (note: string | null) => /^From the package (.+)$/.exec(note ?? "")?.[1] ?? null;
  const sheets = (files ?? []).filter((f) => f.kind === "datasheet").slice(0, READ_AT_ONCE);
  const models = (files ?? []).filter((f) => f.kind === "model_3d");
  const found: string[] = [], problems: string[] = [];
  await Promise.all(sheets.map(async (f) => {
    try {
      const { data } = await supabase.storage.from("project-files").download(f.storage_path);
      const text = data ? await datasheetText(new Uint8Array(await data.arrayBuffer()), f.filename) : null;
      if (!text) throw new Error("no text in the file (a scanned PDF?)");
      const r = await identifyPart(text, f.filename, choice.model);
      if (!r.identity) throw new Error(r.problem ?? "not identified");
      const id = r.identity;
      const { error } = await supabase.rpc("record_part_identification", { p_reference: f.id, p_mpn: id.mpn, p_manufacturer: id.manufacturer, p_role: id.title,
        p_subsystem: id.subsystem, p_specs: id.specs, p_summary: id.variants.length ? `Other ordering codes in the datasheet: ${id.variants.join(", ")}` : null });
      if (error) throw new Error(error.message);
      found.push(`${id.mpn}${id.manufacturer ? ` (${id.manufacturer})` : ""}`);
    } catch (e) {
      problems.push(`${f.filename}: ${(e as Error).message}`);
      await supabase.rpc("note_part_file", { p_reference: f.id, p_note: (e as Error).message });
    }
  }));
  // Models after datasheets, so they can match the parts just found.
  const { data: parts } = await supabase.from("project_parts").select("id, mpn, summary").eq("project_id", projectId);
  const known = (parts ?? []).map((p) => ({ ...p, variants: /Other ordering codes in the datasheet: (.*)$/.exec(p.summary ?? "")?.[1]?.split(", ") ?? [] }));
  let attached = 0;
  for (const f of models) {
    let inside: string[] = [];
    if (/\.(step|stp)$/i.test(f.filename)) {
      const { data } = await supabase.storage.from("project-files").download(f.storage_path);
      if (data) inside = stepNames(new Uint8Array(await data.arrayBuffer()));
    }
    // The package a model came in usually carries the part number in its name.
    const p = matchModelToPart(f.filename, [...inside, pkgOf(f.note) ?? ""], known);
    if (p) {
      const { error } = await supabase.rpc("attach_reference_to_part", { p_reference: f.id, p_part: p.id });
      if (!error) { attached++; await supabase.rpc("note_part_file", { p_reference: f.id, p_note: `matched to ${p.mpn}` }); continue; }
    }
    await supabase.rpc("note_part_file", { p_reference: f.id, p_note: "no part number of a listed part found in this model or its file name" });
  }
  // Files still unplaced that came in a package describing exactly one part (drawings, other models) go with that part.
  const { data: placed } = await supabase.from("project_references").select("part_id, note").eq("project_id", projectId).not("part_id", "is", null).like("note", "From the package %");
  const { data: loose } = await supabase.from("project_references").select("id, note").eq("project_id", projectId).is("part_id", null).like("note", "From the package %");
  for (const f of loose ?? []) {
    const owners = [...new Set((placed ?? []).filter((x) => x.note === f.note).map((x) => x.part_id as string))];
    if (owners.length !== 1) continue;
    const { error } = await supabase.rpc("attach_reference_to_part", { p_reference: f.id, p_part: owners[0] });
    if (!error) { attached++; await supabase.rpc("note_part_file", { p_reference: f.id, p_note: `attached with its package (${pkgOf(f.note)})` }); }
  }
  revalidatePath(base(projectId));
  const more = (files ?? []).filter((f) => f.kind === "datasheet").length - sheets.length;
  const msg = [found.length ? `Found ${found.length} part(s): ${found.join(", ")}.` : "", attached ? `Attached ${attached} file(s) to their parts.` : "",
    problems.length ? `Not read: ${problems.join(" | ")}` : "", more > 0 ? `${more} more datasheet(s) to read: press "Read the files" again.` : ""].filter(Boolean).join(" ");
  return { ok: problems.length === 0, message: msg || "Nothing new to read." };
}

/** A file that was not matched: attach it to a part a person picks, or (a datasheet) create the part from a typed number. */
export async function placePartFile(projectId: string, referenceId: string, form: FormData) {
  const { supabase } = await requireUser();
  const partId = str(form, "part_id"), mpn = str(form, "mpn");
  if (partId) {
    const { error } = await supabase.rpc("attach_reference_to_part", { p_reference: referenceId, p_part: partId });
    if (error) fail(await here(projectId), error);
    go(await here(projectId), "File attached.");
  }
  if (!mpn) fail(await here(projectId), "Choose a part, or type the part number.");
  const { error } = await supabase.rpc("record_part_identification", { p_reference: referenceId, p_mpn: mpn, p_manufacturer: str(form, "manufacturer") || null,
    p_role: str(form, "role") || mpn, p_subsystem: str(form, "subsystem") || "other", p_specs: [], p_summary: null });
  if (error) fail(await here(projectId), error);
  go(await here(projectId), `${mpn} added with this file.`);
}

/** The "Read the files" button: reads what is left and reports on the page. */
export async function readPartFiles(projectId: string) {
  const r = await identifyPartFiles(projectId);
  if (!r.ok && !/Found|Attached/.test(r.message)) fail(await here(projectId), r.message);
  go(await here(projectId), r.message);
}
