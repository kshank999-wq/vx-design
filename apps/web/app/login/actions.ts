"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { fail } from "@/lib/auth";

function credentials(form: FormData) {
  return { email: String(form.get("email") ?? "").trim(), password: String(form.get("password") ?? "") };
}

export async function signIn(form: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(credentials(form));
  if (error) fail("/login", error);
  redirect("/projects");
}

export async function signUp(form: FormData) {
  const supabase = await createClient();
  // The confirmation email links back to this site (the host must be in the project's allowed redirect URLs).
  const h = await headers();
  const origin = process.env.VX_SITE_URL ?? `${h.get("x-forwarded-proto") ?? "https"}://${h.get("x-forwarded-host") ?? h.get("host")}`;
  const { data, error } = await supabase.auth.signUp({ ...credentials(form), options: { emailRedirectTo: `${origin}/auth/callback` } });
  if (error) fail("/login", error);
  if (!data.session) redirect("/login?notice=" + encodeURIComponent("Check your email to confirm the account, then sign in."));
  redirect("/projects");
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
