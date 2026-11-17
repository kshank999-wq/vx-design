"use server";
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
  const { data, error } = await supabase.auth.signUp(credentials(form));
  if (error) fail("/login", error);
  if (!data.session) redirect("/login?notice=" + encodeURIComponent("Check your email to confirm the account, then sign in."));
  redirect("/projects");
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
