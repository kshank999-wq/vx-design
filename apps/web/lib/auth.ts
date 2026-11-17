import "server-only";
import { redirect } from "next/navigation";
import { createClient } from "./supabase/server";

export async function requireUser() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const sub = data?.claims?.sub;
  if (!sub) redirect("/login");
  return { supabase, userId: sub as string, email: (data!.claims.email as string | undefined) ?? "" };
}

/** Redirects back to `path` with an error banner message. */
export function fail(path: string, error: unknown): never {
  const message = error instanceof Error ? error.message : typeof error === "object" && error && "message" in error
    ? String((error as { message: unknown }).message) : String(error);
  redirect(`${path}${path.includes("?") ? "&" : "?"}error=${encodeURIComponent(message.slice(0, 400))}`);
}
