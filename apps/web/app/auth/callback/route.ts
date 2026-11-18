import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Finishes email confirmation (and any other emailed sign-in link). Supabase verifies the link, then redirects here
 * with a one-time `code` that is exchanged for a session using the verifier cookie set at sign-up (PKCE). Links from
 * custom email templates may carry `token_hash` and `type` instead.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as "signup" | "email" | "invite" | "magiclink" | "recovery" | "email_change" | null;
  const supabase = await createClient();
  let error: { message: string } | null = null;
  if (code) ({ error } = await supabase.auth.exchangeCodeForSession(code));
  else if (tokenHash && type) ({ error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type }));
  else error = { message: searchParams.get("error_description") ?? "This link is incomplete." };
  // A relative Location keeps the host the browser used (behind proxies the server may not know its public name).
  const to = error
    ? "/login?error=" + encodeURIComponent(`Could not confirm the email: ${error.message}. Sign in, or sign up again for a new link.`)
    : "/projects";
  return new NextResponse(null, { status: 303, headers: { Location: to } });
}
