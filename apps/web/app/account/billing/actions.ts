"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { fail, requireUser } from "@/lib/auth";
import { createCheckout, MAX_TOP_UP, MIN_TOP_UP } from "@/lib/billing";

const PAGE = "/account/billing";

export async function choosePlan(formData: FormData) {
  const { supabase } = await requireUser();
  const plan = String(formData.get("plan") ?? "");
  const { error } = await supabase.rpc("choose_plan", { p_plan: plan });
  if (error) fail(PAGE, error);
  revalidatePath(PAGE);
  redirect(`${PAGE}?notice=${encodeURIComponent("Plan changed.")}`);
}

/** Sends the buyer to Stripe Checkout for the chosen amount of credit. */
export async function addCredit(formData: FormData) {
  const { supabase, userId } = await requireUser();
  const custom = String(formData.get("custom") ?? "").trim();
  const dollars = Number(custom || formData.get("amount"));
  if (!Number.isInteger(dollars) || dollars < MIN_TOP_UP || dollars > MAX_TOP_UP) {
    fail(PAGE, `Choose a whole amount from $${MIN_TOP_UP} to $${MAX_TOP_UP}.`);
  }
  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "https"}://${h.get("x-forwarded-host") ?? h.get("host")}`;
  let url: string | null = null;
  try {
    const c = await createCheckout(userId, dollars, origin);
    const { error } = await supabase.rpc("note_checkout", { p_session: c.id, p_amount_cents: Math.round(dollars * 100) });
    if (error) throw new Error(error.message);
    url = c.url;
  } catch (e) { fail(PAGE, e); }
  if (!url) fail(PAGE, "Stripe did not return a payment page.");
  redirect(url);
}
