import "server-only";
import { createHmac } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Card top-ups through Stripe Checkout, with no Stripe library: the web server creates a Checkout session for an amount
 * of credit and, once Stripe says it is paid (the return page, or the webhook if the browser closed first), records the
 * credit with record_payment, signed with the server key so nobody can record a payment themselves. Stripe is asked on
 * the return page and, for any checkout still open, each time the Billing page opens, so a payment whose browser closed
 * early is credited at the next visit. Each payment is recorded once. No webhook is needed.
 *
 *   STRIPE_SECRET_KEY   sk_live_… or sk_test_… (server only)
 */
const STRIPE = process.env.VX_STRIPE_API ?? "https://api.stripe.com/v1";

export const stripeConfigured = () => !!process.env.STRIPE_SECRET_KEY;

/** Credit amounts offered, in dollars; any whole amount from MIN_TOP_UP to MAX_TOP_UP can be typed. */
export const TOP_UPS = [20, 50, 100, 250];
export const MIN_TOP_UP = 10;
export const MAX_TOP_UP = 5000;

async function stripe(path: string, init: { method?: string; form?: Record<string, string> } = {}) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("Card payments are not set up (STRIPE_SECRET_KEY)");
  const res = await fetch(`${STRIPE}${path}`, {
    method: init.method ?? (init.form ? "POST" : "GET"),
    headers: { Authorization: `Bearer ${key}`, ...(init.form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    body: init.form ? new URLSearchParams(init.form).toString() : undefined,
  });
  const body = (await res.json()) as Record<string, unknown> & { error?: { message?: string } };
  if (!res.ok) throw new Error(`Stripe: ${body.error?.message ?? res.status}`);
  return body;
}

export interface CheckoutSession { id: string; url: string | null; payment_status: string; amount_total: number | null; currency: string | null; client_reference_id: string | null; metadata: Record<string, string> | null }

export async function createCheckout(userId: string, dollars: number, origin: string): Promise<CheckoutSession> {
  return (await stripe("/checkout/sessions", { form: {
    mode: "payment",
    client_reference_id: userId,
    "metadata[account]": userId,
    "metadata[purpose]": "vx-credit",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(Math.round(dollars * 100)),
    "line_items[0][price_data][product_data][name]": "VX Design credit",
    "line_items[0][price_data][product_data][description]": "Prepaid balance for AI and worker compute, charged per call at the rates on your statement.",
    success_url: `${origin}/account/billing?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/account/billing?notice=${encodeURIComponent("Payment cancelled; nothing was charged.")}`,
  } })) as unknown as CheckoutSession;
}

export async function getCheckout(id: string): Promise<CheckoutSession> {
  if (!/^cs_[A-Za-z0-9_]+$/.test(id)) throw new Error("not a Checkout session");
  return (await stripe(`/checkout/sessions/${id}`)) as unknown as CheckoutSession;
}

/** Records a paid Checkout session as credit for the signed-in account. Null when it is not (yet) a paid credit of theirs. */
export async function recordPaidCheckout(supabase: SupabaseClient, userId: string, s: CheckoutSession): Promise<"recorded" | "already recorded" | null> {
  const account = s.metadata?.account ?? s.client_reference_id;
  if (s.metadata?.purpose !== "vx-credit" || account !== userId || s.payment_status !== "paid" || s.currency !== "usd" || !s.amount_total) return null;
  const key = process.env.VX_ASSISTANT_SIGNING_KEY;
  if (!key) throw new Error("VX_ASSISTANT_SIGNING_KEY is not set on the web server");
  const ref = `stripe:${s.id}`;
  const signedAt = Date.now();
  const msg = ["vx-billing-v1", userId, String(s.amount_total), ref, String(signedAt)].join("\n");
  const { data, error } = await supabase.rpc("record_payment", {
    p_amount_cents: s.amount_total, p_ref: ref, p_description: `Card payment (Stripe …${s.id.slice(-8)})`,
    p_signed_at_ms: signedAt, p_signature: createHmac("sha256", key).update(msg, "utf8").digest("hex"),
  });
  if (error) throw new Error(error.message);
  return data as "recorded" | "already recorded";
}

/** Asks Stripe about the account's checkouts still open (last 3 days): paid ones are credited, abandoned ones closed. */
export async function settleOpenCheckouts(supabase: SupabaseClient, userId: string): Promise<number> {
  if (!stripeConfigured()) return 0;
  const since = new Date(Date.now() - 3 * 86400e3).toISOString();
  const { data } = await supabase.from("billing_checkouts").select("session_id, amount_cents, created_at").eq("status", "open").gte("created_at", since).limit(10);
  let credited = 0;
  for (const c of data ?? []) {
    try {
      const s = await getCheckout(c.session_id);
      if ((await recordPaidCheckout(supabase, userId, s)) === "recorded") credited++;
      else if ((s as unknown as { status?: string }).status === "expired") await supabase.rpc("note_checkout", { p_session: c.session_id, p_amount_cents: c.amount_cents, p_status: "expired" });
    } catch (e) { console.error(`checkout ${c.session_id}: ${(e as Error).message}`); }
  }
  return credited;
}

export const money = (n: number, digits = 2) => `${n < 0 ? "−" : ""}$${Math.abs(Number(n)).toFixed(digits)}`;
