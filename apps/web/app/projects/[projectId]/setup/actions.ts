"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { fail, requireUser } from "@/lib/auth";

const base = (projectId: string, step: number) => `/projects/${projectId}/setup?step=${step}`;
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const many = (f: FormData, k: string) => [...f.getAll(k).map(String), ...str(f, `${k}_other`).split(",")].map((x) => x.trim()).filter((x) => x && x !== "None");
function next(projectId: string, step: number, notice: string): never {
  revalidatePath(`/projects/${projectId}/setup`);
  redirect(`${base(projectId, step)}&notice=${encodeURIComponent(notice)}`);
}

/** Step 1: the project's identity. */
export async function saveProject(projectId: string, form: FormData) {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("update_project_identity", { p_project: projectId, p_name: str(form, "name"), p_description: str(form, "description"),
    p_code: str(form, "code"), p_product_class: str(form, "product_class") });
  if (error) fail(base(projectId, 1), error);
  next(projectId, 2, "Project saved.");
}

/** Step 3: the intake, with chips for markets, radios and standards. */
export async function saveSetupIntake(projectId: string, form: FormData) {
  const { supabase } = await requireUser();
  const quantity = str(form, "quantity"), cost = str(form, "target_unit_cost");
  if (quantity && !/^\d+$/.test(quantity)) fail(base(projectId, 3), "Quantity is a whole number.");
  if (cost && !/^\d+(\.\d+)?$/.test(cost)) fail(base(projectId, 3), "Target unit cost is a number.");
  const dims = ["l", "w", "h"].map((k) => str(form, `dim_${k}`)).filter(Boolean);
  const power = [...form.getAll("power").map(String), str(form, "power_other")].filter(Boolean).join(" + ");
  const { error } = await supabase.rpc("save_intake", { p_project: projectId, p_intake: {
    intended_use: str(form, "intended_use"), regions: many(form, "regions"), quantity, target_unit_cost: cost, currency: str(form, "currency"),
    max_dimensions: dims.length === 3 ? `${dims.join(" × ")} mm` : str(form, "max_dimensions"), power_source: power,
    radios: many(form, "radios"), target_standards: many(form, "target_standards"), notes: str(form, "notes"),
  } });
  if (error) fail(base(projectId, 3), error);
  next(projectId, 4, "Intake saved.");
}
