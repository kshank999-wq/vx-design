"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

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
  // Live numbers on the menu items, fetched every 20 s on every project page (and whenever the live strip fetches).
  const [badges, setBadges] = useState<Badges | null>(null);
  const prev = useRef<Badges | null>(null);
  const [toasts, setToasts] = useState<{ id: number; text: string; href: string }[]>([]);
  useEffect(() => {
    let stop = false;
    const apply = (b: Badges | null) => {
      if (!b || stop) return;
      // Something new that needs the person: a toast on the page and, if allowed, a desktop notification.
      const news = alerts(prev.current, b, base);
      prev.current = b;
      setBadges(b);
      if (news.length) {
        setToasts((t) => [...t, ...news.map((n, i) => ({ id: Date.now() + i, ...n }))].slice(-4));
        try {
          if ("Notification" in window && Notification.permission === "granted" && document.visibilityState !== "visible") {
            for (const n of news) new Notification(`VX Design: ${name}`, { body: n.text, tag: n.text });
          }
        } catch { /* not available */ }
      }
    };
    const tick = async () => {
      try { const r = await fetch(`${base.replace("/projects/", "/api/projects/")}/live`, { cache: "no-store" }); if (r.ok) apply((await r.json()).badges ?? null); } catch { /* next tick */ }
    };
    const on = (e: Event) => apply((e as CustomEvent).detail?.badges ?? null);
    window.addEventListener("vx-live", on);
    tick();
    const t = setInterval(tick, 20000);
    return () => { stop = true; clearInterval(t); window.removeEventListener("vx-live", on); };
  }, [base, name]);
  const [canNotify, setCanNotify] = useState(false);
  useEffect(() => { try { setCanNotify("Notification" in window && Notification.permission === "default"); } catch { /* none */ } }, []);
  // In the order people work: what we are making, the plan, the decisions it needs, the work, the results, the cost.
  const top = [{ href: base, label: "Overview" }, { href: `${base}/inputs`, label: "Inputs" }, { href: `${base}/plan`, label: "Plan" }, { href: `${base}/questions`, label: "Questions" }, { href: `${base}/todo`, label: "To do" }, { href: `${base}/runs`, label: "Runs" }, { href: `${base}/workspace`, label: "Workspace" }, { href: `${base}/usage`, label: "AI usage" }];
  return (
    <nav className="project-nav" aria-label="Project" ref={ref} data-testid="project-nav">
      <Link href={base} className="pn-name" title={name}>{name}</Link>
      <span className="pn-sep" />
      {top.map((t) => <Link key={t.href} href={t.href} className="pn-item" aria-current={here(t.href) ? "page" : undefined}>{t.label}
        {t.label === "Plan" && badges?.plan && (
          <span className="pn-badges" data-testid="plan-badge"><span className="pn-badge pn-badge-wait" title={`Plan v${badges.plan.version} needs you: ${badges.plan.state === "submit" ? "review it and submit it for approval" : "approve it or return it"}`}>
            plan v{badges.plan.version}: {badges.plan.state === "submit" ? "submit" : "approve"}</span></span>)}
        {t.label === "Workspace" && (badges?.proposals ?? 0) > 0 && (
          <span className="pn-badges" data-testid="proposals-badge"><span className="pn-badge pn-badge-wait" title="Plan updates the design agent proposed: decide them at the top of the workspace">{badges!.proposals} plan update{badges!.proposals! > 1 ? "s" : ""}</span></span>)}
        {t.label === "To do" && (badges?.todos ?? 0) > 0 && (
          <span className="pn-badges" data-testid="todo-badge"><span className="pn-badge pn-badge-wait" title={`${badges!.todos} file(s) to get for the design`}>{badges!.todos}</span></span>)}
        {t.label === "Questions" && (badges?.questions ?? 0) > 0 && (
          <span className="pn-badges" data-testid="questions-badge"><span className="pn-badge pn-badge-wait" title={`${badges!.questions} open question(s) for you`}>{badges!.questions}</span></span>)}
        {t.label === "Runs" && badges && (badges.running > 0 || badges.problems > 0 || (badges.waiting ?? 0) > 0 || badges.active_runs > 0 || !!badges.stopped) && (
          <span className="pn-badges" data-testid="runs-badges">
            {badges.active_runs > (badges.paused_runs ?? 0) && <span className="pn-badge pn-badge-ok" title={`${badges.active_runs - (badges.paused_runs ?? 0)} run(s) going, working on ${badges.running} step(s) now`}>{badges.active_runs - (badges.paused_runs ?? 0) === 1 ? "running" : `${badges.active_runs - (badges.paused_runs ?? 0)} running`}</span>}
            {(badges.paused_runs ?? 0) > 0 && <span className="pn-badge pn-badge-wait" title="A run is paused: open it to resume">{badges.paused_runs === 1 ? "paused" : `${badges.paused_runs} paused`}</span>}
            {(badges.waiting ?? 0) > 0 && <span className="pn-badge pn-badge-wait" title={`${badges.waiting} result(s) waiting for your approval`}>{badges.waiting} to approve</span>}
            {badges.problems > 0 && <span className="pn-badge pn-badge-bad" title={`${badges.problems} step(s) could not finish`}>{badges.problems} problem{badges.problems > 1 ? "s" : ""}</span>}
            {!!badges.stopped && badges.active_runs === 0 && <span className="pn-badge pn-badge-bad" title={badges.stopped.reason ?? "The run stopped"}>stopped</span>}
          </span>)}
      </Link>)}
      {canNotify && <button type="button" className="btn-link small pn-notify" onClick={async () => { try { await Notification.requestPermission(); } catch { /* none */ } setCanNotify(false); }}
        title="Get a desktop notification when a run stops, a result waits for approval or a question comes in">🔔 Turn on alerts</button>}
      {toasts.length > 0 && (
        <div className="toasts" role="status" aria-live="polite" data-testid="toasts">{toasts.map((t) => (
          <div key={t.id} className="toast"><Link href={t.href} onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>{t.text}</Link>
            <button type="button" aria-label="Dismiss" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>×</button></div>))}</div>
      )}
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

interface Badges {
  active_runs: number; running: number; problems: number; waiting?: number; paused_runs?: number;
  questions?: number; todos?: number; proposals?: number; plan?: { id: string; version: number; state: "submit" | "approve" } | null;
  stopped?: { id: string; reason: string | null } | null;
}

/** What changed since the last look that a person should act on. Nothing on the first look (the badges show that). */
function alerts(before: Badges | null, now: Badges, base: string): { text: string; href: string }[] {
  if (!before) return [];
  const out: { text: string; href: string }[] = [];
  if (now.stopped && now.stopped.id !== before.stopped?.id) out.push({ text: `The run stopped: ${now.stopped.reason ?? "it needs you"}`, href: `${base}/runs/${now.stopped.id}` });
  if (now.problems > before.problems) out.push({ text: `${now.problems - before.problems} step(s) could not finish`, href: `${base}/runs` });
  if ((now.waiting ?? 0) > (before.waiting ?? 0)) out.push({ text: `${(now.waiting ?? 0) - (before.waiting ?? 0)} result(s) waiting for your approval`, href: `${base}/runs` });
  if ((now.questions ?? 0) > (before.questions ?? 0)) out.push({ text: `${(now.questions ?? 0) - (before.questions ?? 0)} new question(s) for you`, href: `${base}/questions` });
  if ((now.todos ?? 0) > (before.todos ?? 0)) out.push({ text: `${(now.todos ?? 0) - (before.todos ?? 0)} new file(s) to get on your to-do list`, href: `${base}/todo` });
  if ((now.proposals ?? 0) > (before.proposals ?? 0)) out.push({ text: "The design agent proposed a plan update", href: `${base}/workspace#plan-updates` });
  if (now.plan && now.plan.id !== before.plan?.id) out.push({ text: `Plan v${now.plan.version} needs you: ${now.plan.state === "submit" ? "submit it for approval" : "approve it"}`, href: `${base}/plan` });
  if ((now.paused_runs ?? 0) > (before.paused_runs ?? 0)) out.push({ text: "A run was paused", href: `${base}/runs` });
  return out;
}
