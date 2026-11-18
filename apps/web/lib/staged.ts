import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// Where StagedFileInput may put files: {project}/uploads/... in project-files, staging/... in knowledge-files.
const STAGING = /^(project-files:[0-9a-f-]{36}\/uploads|knowledge-files:staging)\/[0-9a-f-]{36}\/[\w.-]{1,120}$/;

/**
 * The file a form submitted in `field`: either posted with the form, or staged in storage by StagedFileInput, in which
 * case it is downloaded (as the signed-in user, so storage rules apply) and the staged copy removed. Callers check
 * and store it exactly as they would a posted file.
 */
export async function formFile(supabase: SupabaseClient, form: FormData, field: string): Promise<File | null> {
  const ref = String(form.get(`${field}__staged`) ?? "");
  if (ref) {
    if (!STAGING.test(ref)) throw new Error("The uploaded file reference is not valid; choose the file again.");
    const [bucket, path] = [ref.slice(0, ref.indexOf(":")), ref.slice(ref.indexOf(":") + 1)];
    const { data, error } = await supabase.storage.from(bucket).download(path);
    await supabase.storage.from(bucket).remove([path]);
    if (error || !data) throw new Error(`The uploaded file could not be read back (${error?.message ?? "missing"}); choose it again.`);
    const name = String(form.get(`${field}__name`) ?? "") || path.split("/").pop()!;
    return new File([data], name, { type: String(form.get(`${field}__type`) ?? "") || data.type });
  }
  const f = form.get(field);
  return f instanceof File && f.size > 0 ? f : null;
}
