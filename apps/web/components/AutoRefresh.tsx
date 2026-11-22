"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Re-renders the server page every few seconds while something is in progress. */
export function AutoRefresh({ intervalMs = 3000, quiet = false }: { intervalMs?: number; quiet?: boolean }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, intervalMs);
    return () => clearInterval(id);
  }, [router, intervalMs]);
  return quiet ? null : <span className="muted small live-dot" aria-live="off">live</span>;
}
