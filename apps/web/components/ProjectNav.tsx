"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

export interface NavGroup { label: string; items: { href: string; label: string }[] }

/**
 * The project's menu on every project page: Overview, Inputs and Workspace, then the Define, Design, Make and Prove
 * groups as drop-downs. The current page and its group are highlighted; a drop-down closes when another opens or after
 * a click outside it.
 */
export function ProjectNav({ base, name, groups }: { base: string; name: string; groups: NavGroup[] }) {
  const path = usePathname();
  const ref = useRef<HTMLElement>(null);
  const here = (href: string) => (href === base ? path === base : path === href || path.startsWith(`${href}/`));
  useEffect(() => {
    const close = (e: MouseEvent) => {
      for (const d of ref.current?.querySelectorAll("details[open]") ?? []) if (!d.contains(e.target as Node)) d.removeAttribute("open");
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);
  useEffect(() => { for (const d of ref.current?.querySelectorAll("details[open]") ?? []) d.removeAttribute("open"); }, [path]);
  const top = [{ href: base, label: "Overview" }, { href: `${base}/inputs`, label: "Inputs" }, { href: `${base}/workspace`, label: "Workspace" }, { href: `${base}/runs`, label: "Runs" }, { href: `${base}/questions`, label: "Questions" }, { href: `${base}/usage`, label: "AI usage" }];
  return (
    <nav className="project-nav" aria-label="Project" ref={ref} data-testid="project-nav">
      <Link href={base} className="pn-name" title={name}>{name}</Link>
      <span className="pn-sep" />
      {top.map((t) => <Link key={t.href} href={t.href} className="pn-item" aria-current={here(t.href) ? "page" : undefined}>{t.label}</Link>)}
      {groups.map((g) => {
        const active = g.items.some((i) => here(i.href));
        return (
          <details key={g.label} className={`pn-group${active ? " active" : ""}`}>
            <summary className="pn-item">{g.label}{active && <span className="pn-current">: {g.items.find((i) => here(i.href))!.label}</span>}</summary>
            <div className="pn-menu">{g.items.map((i) => <Link key={i.href} href={i.href} aria-current={here(i.href) ? "page" : undefined}>{i.label}</Link>)}</div>
          </details>
        );
      })}
    </nav>
  );
}
