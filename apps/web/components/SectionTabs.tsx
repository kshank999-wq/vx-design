"use client";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

export interface Section { key: string; label: string; badge?: string | number | null; content: ReactNode }

/**
 * One section of a page at a time. The open tab comes from ?tab= when present, else the one last opened on this page
 * (kept for the browser session, so saving a form returns to it), else `initial` (where the work is), else the first. Every panel stays in the page (only
 * hidden), so forms and links in other tabs keep working.
 */
export function SectionTabs({ sections, id = "tabs", initial }: { sections: Section[]; id?: string; initial?: string }) {
  const path = usePathname();
  const params = useSearchParams();
  const store = `vx-tab:${path}:${id}`;
  const wanted = params.get("tab");
  const first = initial && sections.some((s) => s.key === initial) ? initial : sections[0]!.key;
  const [tab, setTab] = useState(() => (wanted && sections.some((s) => s.key === wanted) ? wanted : first));
  useEffect(() => {
    if (wanted && sections.some((s) => s.key === wanted)) { setTab(wanted); return; }
    try { const t = sessionStorage.getItem(store); if (t && sections.some((s) => s.key === t)) setTab(t); } catch { /* storage blocked */ }
  }, [store, wanted, sections]);
  // A tab can disappear after a form is sent (its last item handled): show where the work is instead.
  const open = sections.some((s) => s.key === tab) ? tab : first;
  const choose = (k: string) => { setTab(k); try { sessionStorage.setItem(store, k); } catch { /* storage blocked */ } };
  return (
    <div className="section-tabs">
      <div className="tabs" role="tablist" aria-label="Sections" data-testid={`${id}-tabs`}>
        {sections.map((s) => (
          <button key={s.key} type="button" role="tab" className="tab" aria-selected={open === s.key} aria-current={open === s.key ? "page" : undefined}
            onClick={() => choose(s.key)} data-tab={s.key}>
            {s.label}{s.badge != null && s.badge !== "" ? <span className="tab-count">{s.badge}</span> : null}
          </button>
        ))}
      </div>
      {sections.map((s) => <div key={s.key} role="tabpanel" hidden={open !== s.key} data-panel={s.key}>{s.content}</div>)}
    </div>
  );
}
