import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * How money is shown to the person looking. Customers see one price (our cost times their plan's rate, which
 * includes the markup); VX Design administrators see our cost, the price and the markup. In-house projects (plans
 * not billed) have a rate of 1, so their figures are our cost.
 */
export interface Pricing { admin: boolean; rate: number; price: (costUsd: number) => number }

export async function viewerPricing(supabase: SupabaseClient, projectId?: string | null): Promise<Pricing> {
  const [{ data: admin }, rateRes] = await Promise.all([
    supabase.rpc("is_platform_admin"),
    projectId ? supabase.rpc("project_billing_rate", { p_project: projectId }) : Promise.resolve({ data: 1 }),
  ]);
  const rate = Number(rateRes.data ?? 1) || 1;
  return { admin: !!admin, rate, price: (c: number) => c * rate };
}
