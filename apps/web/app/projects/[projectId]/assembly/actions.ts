"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { AssemblyDraft, checkAssembly, generateAssembly, linesToFasteners, linesToParts, textLines, type AssemblyStep } from "@vx/planning";
import { fail, requireUser } from "@/lib/auth";
import { assemblyInput } from "@/lib/assembly";
import { getModel } from "@/lib/model";

const base = (projectId: string) => `/projects/${projectId}/assembly`;
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
function go(projectId: string, notice: string): never {
  revalidatePath(base(projectId));
  redirect(`${base(projectId)}?notice=${encodeURIComponent(notice)}`);
}

/** Drafts assembly instructions from what the project knows (a new draft version; earlier drafts are superseded). */
export async function draftAssembly(projectId: string, form: FormData) {
  const { supabase } = await requireUser();
  let choice;
  try { choice = getModel(projectId); } catch (e) { fail(base(projectId), e); }
  const guidance = str(form, "guidance") || null;
  let id: string;
  try {
    const input = await assemblyInput(supabase, projectId, guidance);
    if (!input.made.length && !input.bought.length && !input.boards.length) {
      throw new Error("There is nothing to assemble yet: add parts already chosen (Project inputs), manufacturing routes, or a board.");
    }
    const r = await generateAssembly(input, choice.model);
    const { data, error } = await supabase.rpc("create_assembly_instructions", {
      p_project: projectId, p_content: r.draft, p_problems: r.remaining, p_model: choice.label, p_usage: r.usage, p_guidance: guidance, p_based_on: null,
    });
    if (error) throw new Error(error.message);
    id = data as string;
  } catch (e) {
    fail(base(projectId), `Drafting failed: ${(e as Error).message}`);
  }
  go(projectId, `Draft ready (${id.slice(0, 8)}). Read it through, correct it, then ask a reviewer to approve it.`);
}

async function loadDraft(supabase: Awaited<ReturnType<typeof requireUser>>["supabase"], projectId: string, id: string) {
  const { data } = await supabase.from("assembly_instructions").select("id, status, content").eq("id", id).eq("project_id", projectId).single();
  if (!data) fail(base(projectId), "Version not found.");
  if (data.status !== "draft") fail(base(projectId), "Only a draft can be changed: start a revision.");
  return AssemblyDraft.parse(data.content);
}
async function save(supabase: Awaited<ReturnType<typeof requireUser>>["supabase"], projectId: string, id: string, d: AssemblyDraft, notice: string): Promise<never> {
  const { error } = await supabase.rpc("update_assembly_instructions", { p_id: id, p_content: d });
  if (error) fail(base(projectId), error);
  go(projectId, notice);
}

export async function saveHeader(projectId: string, id: string, form: FormData) {
  const { supabase } = await requireUser();
  const d = await loadDraft(supabase, projectId, id);
  d.title = str(form, "title") || d.title;
  d.safety = textLines(str(form, "safety"));
  d.tools = textLines(str(form, "tools"));
  d.final_test = textLines(str(form, "final_test"));
  await save(supabase, projectId, id, d, "Saved.");
}

export async function saveStep(projectId: string, id: string, index: number, form: FormData) {
  const { supabase } = await requireUser();
  const d = await loadDraft(supabase, projectId, id);
  if (!d.steps[index]) fail(base(projectId), "Step not found.");
  const minutes = Number(str(form, "minutes"));
  const step: AssemblyStep = {
    title: str(form, "title") || d.steps[index]!.title, parts: linesToParts(str(form, "parts")), fasteners: linesToFasteners(str(form, "fasteners")),
    tools: textLines(str(form, "tools")), instructions: textLines(str(form, "instructions")), cautions: textLines(str(form, "cautions")),
    check: str(form, "check") || null, figure: str(form, "figure") || null, minutes: Number.isFinite(minutes) && minutes > 0 ? minutes : d.steps[index]!.minutes,
  };
  d.steps[index] = step;
  await save(supabase, projectId, id, d, `Step ${index + 1} saved.`);
}

export async function moveStep(projectId: string, id: string, index: number, by: -1 | 1) {
  const { supabase } = await requireUser();
  const d = await loadDraft(supabase, projectId, id);
  const j = index + by;
  if (j < 0 || j >= d.steps.length) fail(base(projectId), "Cannot move that step further.");
  [d.steps[index], d.steps[j]] = [d.steps[j]!, d.steps[index]!];
  await save(supabase, projectId, id, d, `Step moved to position ${j + 1}.`);
}

export async function deleteStep(projectId: string, id: string, index: number) {
  const { supabase } = await requireUser();
  const d = await loadDraft(supabase, projectId, id);
  d.steps.splice(index, 1);
  await save(supabase, projectId, id, d, `Step ${index + 1} removed.`);
}

export async function addStep(projectId: string, id: string) {
  const { supabase } = await requireUser();
  const d = await loadDraft(supabase, projectId, id);
  d.steps.push({ title: "New step", parts: [], fasteners: [], tools: [], instructions: ["Describe the action."], cautions: [], check: null, figure: null, minutes: 5 });
  await save(supabase, projectId, id, d, `Step ${d.steps.length} added at the end.`);
}

/** Runs the checks again on the edited draft (parts fitted, figures, torques) without changing it. */
export async function recheck(projectId: string, id: string) {
  const { supabase } = await requireUser();
  const d = await loadDraft(supabase, projectId, id);
  const problems = checkAssembly(d, await assemblyInput(supabase, projectId, null));
  go(projectId, problems.length ? `Still to fix: ${problems.join(" | ")}` : "Checks pass: every part is fitted, figures exist and every fastener has a torque or a reason.");
}

export async function approve(projectId: string, id: string) {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("approve_assembly_instructions", { p_id: id });
  if (error) fail(base(projectId), error);
  go(projectId, "Approved. This version is locked; export it for the assembler.");
}

/** A new draft starting from an approved (or earlier) version. */
export async function revise(projectId: string, id: string) {
  const { supabase } = await requireUser();
  const { data: v } = await supabase.from("assembly_instructions").select("content, model").eq("id", id).eq("project_id", projectId).single();
  if (!v) fail(base(projectId), "Version not found.");
  const { error } = await supabase.rpc("create_assembly_instructions", { p_project: projectId, p_content: v.content, p_problems: [], p_model: v.model,
    p_usage: [], p_guidance: null, p_based_on: id });
  if (error) fail(base(projectId), error);
  go(projectId, "Revision started: edit the new draft and have it approved again.");
}
