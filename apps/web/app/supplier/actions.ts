"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { fail, requireUser } from "@/lib/auth";

const str = (form: FormData, k: string) => String(form.get(k) ?? "").trim();
const optNum = (form: FormData, k: string) => (str(form, k) === "" ? null : Number(str(form, k)));

export async function submitQuote(recipientId: string, form: FormData) {
  const { supabase } = await requireUser();
  const qty = form.getAll("quantity").map(String);
  const price = form.getAll("unit_price").map(String);
  const lines = qty.map((q, i) => ({ quantity: q.trim(), unit_price: (price[i] ?? "").trim() }))
    .filter((l) => l.quantity !== "" || l.unit_price !== "")
    .map((l) => ({ quantity: Number(l.quantity), unit_price: Number(l.unit_price) }));
  if (!lines.length) fail("/supplier", "Quote at least one quantity.");
  const { error } = await supabase.rpc("submit_quote", {
    p_recipient_id: recipientId,
    p_quote: { currency: str(form, "currency").toUpperCase(), lines, tooling_cost: optNum(form, "tooling_cost"),
               shipping_cost: optNum(form, "shipping_cost"), lead_time_days: optNum(form, "lead_time_days"),
               valid_until: str(form, "valid_until") || null, notes: str(form, "notes") || null },
  });
  if (error) fail("/supplier", error);
  revalidatePath("/supplier");
  redirect("/supplier?notice=" + encodeURIComponent("Quote submitted. You can revise it while the RFQ is open."));
}

export async function declineRfq(recipientId: string, form: FormData) {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("decline_rfq", { p_recipient_id: recipientId, p_reason: str(form, "reason") || null });
  if (error) fail("/supplier", error);
  revalidatePath("/supplier");
  redirect("/supplier?notice=" + encodeURIComponent("Declined. Please delete any copies of the packet."));
}
