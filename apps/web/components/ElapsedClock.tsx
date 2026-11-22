"use client";
import { useEffect, useState } from "react";

/** Minutes and seconds since a time, ticking every second. */
export function ElapsedClock({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const s = Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000));
  return <span className="mono" data-testid="elapsed">{Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}</span>;
}
