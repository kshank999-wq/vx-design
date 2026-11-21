"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

/** The header's navigation; the current section is highlighted. */
export function TopNav({ links }: { links: { href: string; label: string }[] }) {
  const path = usePathname();
  return (
    <nav className="topnav" aria-label="Main">
      {links.map((l) => {
        const here = path === l.href || path.startsWith(`${l.href}/`);
        return <Link key={l.href} href={l.href} aria-current={here ? "page" : undefined}>{l.label}</Link>;
      })}
    </nav>
  );
}
