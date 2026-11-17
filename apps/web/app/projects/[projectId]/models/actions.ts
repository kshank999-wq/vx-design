"use server";
import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { normalizeManufacturer, normalizeMpn } from "@vx/integrations";
import { fail, requireUser } from "@/lib/auth";

const MAX_BYTES = 24 * 1024 * 1024;   // under the server-action body limit (next.config.ts); larger files go by URL

/** Adds a manufacturer 3D model (uploaded STEP/ZIP or an https URL) to the library for checking. */
export async function addModel(projectId: string, form: FormData) {
  const path = `/projects/${projectId}/models`;
  const { supabase } = await requireUser();
  const mpn = String(form.get("mpn") ?? "").trim();
  const manufacturer = String(form.get("manufacturer") ?? "").trim();
  const footprint = String(form.get("footprint") ?? "").trim();
  const source = String(form.get("source") ?? "").trim();
  const license = String(form.get("license") ?? "").trim() || null;
  const url = String(form.get("url") ?? "").trim();
  const height = Number(String(form.get("height_mm") ?? "").trim());
  const shared = form.get("shared") === "on";
  const file = form.get("file");
  if (!mpn || !manufacturer || !footprint || !source) fail(path, "Part number, manufacturer, KiCad footprint and source are required.");
  let originalPath: string | null = null;
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_BYTES) fail(path, "The file is larger than 24 MB: give an https URL to it instead.");
    if (!/\.(step|stp|zip)$/i.test(file.name)) fail(path, "Upload a .step, .stp or .zip file.");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const sha = createHash("sha256").update(bytes).digest("hex");
    originalPath = `${projectId}/models/uploads/${sha.slice(0, 16)}-${file.name.replace(/[^\w.-]/g, "_")}`;
    const { error } = await supabase.storage.from("project-files").upload(originalPath, bytes, { contentType: "application/octet-stream", upsert: true });
    if (error) fail(path, error);
  } else if (!url) {
    fail(path, "Upload a STEP/ZIP file or give an https URL to one.");
  }
  const { error } = await supabase.rpc("register_part_model", {
    p_project_id: projectId, p_mpn: mpn, p_manufacturer: manufacturer, p_normalized_mpn: normalizeMpn(mpn),
    p_normalized_mfr: normalizeManufacturer(manufacturer), p_footprint: footprint,
    p_source_kind: originalPath ? "upload" : "url", p_source: source, p_source_url: originalPath ? null : url, p_license: license,
    p_original_path: originalPath, p_shared: shared, p_mechanical: Number.isFinite(height) && height > 0 ? { height_mm: height } : {},
  });
  if (error) fail(path, error);
  revalidatePath(path);
  redirect(`${path}?notice=${encodeURIComponent("Added. The KiCad worker checks it against the footprint; then verify it here.")}`);
}

export async function decideModel(projectId: string, modelId: string, approve: boolean, form: FormData) {
  const path = `/projects/${projectId}/models`;
  const { supabase } = await requireUser();
  const note = String(form.get("note") ?? "").trim() || null;
  if (!approve && !note) fail(path, "Say why the model is rejected.");
  const { error } = await supabase.rpc("decide_part_model", { p_id: modelId, p_approve: approve, p_note: note });
  if (error) fail(path, error);
  revalidatePath(path);
  redirect(`${path}?notice=${encodeURIComponent(approve ? "Verified: layouts will use this model." : "Rejected.")}`);
}
