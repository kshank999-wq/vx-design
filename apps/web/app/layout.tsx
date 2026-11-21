import type { Metadata } from "next";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Suspense } from "react";
import { ScrollKeeper } from "@/components/ScrollKeeper";
import { ThemeToggle } from "@/components/ThemeToggle";
import { TopNav } from "@/components/TopNav";
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
  const links = [
    ...(email ? [{ href: "/projects", label: "Projects" }, { href: "/knowledge", label: "Knowledge" }] : []),
    ...(directory ? [{ href: "/suppliers", label: "Suppliers" }] : []),
    ...((invites as unknown[] | null)?.length ? [{ href: "/supplier", label: "Supplier portal" }] : []),
    ...(email ? [{ href: "/account", label: "Account" }] : []),
  ];
  const initials = (email ?? "").split("@")[0]!.split(/[._-]+/).filter(Boolean).slice(0, 2).map((x) => x[0]!.toUpperCase()).join("") || "?";
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Apply a saved light/dark choice before the page paints. */}
        <script dangerouslySetInnerHTML={{ __html: "try{var t=localStorage.getItem('vx-theme');if(t)document.documentElement.dataset.theme=t}catch(e){}" }} />
      </head>
      <body>
        <header className="topbar">
          <Link href="/projects" className="brand" aria-label="VX Design home"><img src="/logo.png" alt="VX Design" width={291} height={96} /></Link>
          <TopNav links={links} />
          <div className="top-actions">
            <ThemeToggle />
            {email && <>
              <span className="top-sep" />
              <span className="avatar" title={email}>{initials}</span>
              <span className="muted small top-email">{email}</span>
              <form action={signOut}><button className="btn btn-link" type="submit">Sign out</button></form>
            </>}
          </div>
        </header>
        {children}
        <Suspense fallback={null}><ScrollKeeper /></Suspense>
      </body>
    </html>
  );
}
