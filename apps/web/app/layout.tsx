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
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <Link href="/projects" className="brand">VX Design</Link>
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
