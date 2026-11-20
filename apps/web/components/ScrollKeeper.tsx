"use client";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

const KEY = "vx-scroll";

/**
 * Keeps the page where it was after a form is submitted. Server actions finish by reloading the page they came from
 * (with ?notice= or ?error=), which would otherwise jump to the top. The position is remembered on submit and put
 * back when the same page renders again within a minute; the message, which is shown at the top of the page, is
 * repeated in a small pop-up so it is seen where the person is.
 */
export function ScrollKeeper() {
  const pathname = usePathname();
  const search = useSearchParams();
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null);

  useEffect(() => {
    const remember = () => {
      try { sessionStorage.setItem(KEY, JSON.stringify({ path: location.pathname, y: window.scrollY, at: Date.now() })); } catch { /* private mode */ }
    };
    document.addEventListener("submit", remember, true);
    return () => document.removeEventListener("submit", remember, true);
  }, []);

  useEffect(() => {
    let saved: { path: string; y: number; at: number } | null = null;
    try { saved = JSON.parse(sessionStorage.getItem(KEY) ?? "null"); } catch { saved = null; }
    if (!saved || saved.path !== pathname || Date.now() - saved.at > 60_000) return;
    try { sessionStorage.removeItem(KEY); } catch { /* ignore */ }
    const y = saved.y;
    // After the navigation has rendered (and scrolled to the top), go back.
    const t = setTimeout(() => requestAnimationFrame(() => window.scrollTo({ top: y, behavior: "instant" as ScrollBehavior })), 0);
    const error = search.get("error"), notice = search.get("notice");
    if ((error || notice) && y > 200) setToast({ text: (error ?? notice)!, error: !!error });
    return () => clearTimeout(t);
  }, [pathname, search]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.error ? 12_000 : 6_000);
    return () => clearTimeout(t);
  }, [toast]);

  if (!toast) return null;
  return (
    // The text is drawn by CSS from data-text: the banner at the top of the page already announces it to screen readers.
    <div aria-hidden="true" className={`toast banner ${toast.error ? "banner-error" : "banner-notice"}`} data-testid="toast" data-text={toast.text} onClick={() => setToast(null)} />
  );
}
