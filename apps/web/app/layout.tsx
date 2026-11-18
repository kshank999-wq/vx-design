import type { Metadata } from "next";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { signOut } from "./login/actions";
import "./globals.css";

export const metadata: Metadata = {
  title: "VX Design",
  description: "Spec-driven electronics and hardware engineering platform",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const email = data?.claims?.email as string | undefined;
  // Owners/engineers see the supplier directory; anyone with RFQs addressed to their confirmed email sees the portal.
  const [{ data: directory }, { data: invites }] = email
    ? await Promise.all([supabase.rpc("is_directory_user"), supabase.rpc("supplier_rfqs").select("recipient_id").limit(1)])
    : [{ data: false }, { data: [] }];
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <nav className="row">
            <Link href="/projects" className="brand">VX Design</Link>
            {email && <Link href="/knowledge" className="small">Knowledge</Link>}
            {directory && <Link href="/suppliers" className="small">Suppliers</Link>}
            {email && <Link href="/account" className="small">Account</Link>}
            {(invites as unknown[] | null)?.length ? <Link href="/supplier" className="small">Supplier portal</Link> : null}
          </nav>
          {email && (
            <form action={signOut} className="row">
              <span className="muted small">{email}</span>
              <button className="btn btn-link" type="submit">Sign out</button>
            </form>
          )}
        </header>
        {children}
      </body>
    </html>
  );
}
