"use client";
import Link from "next/link";
import { useEffect, useState } from "react";

interface Live {
  run: { id: string; name: string | null; status: string; stop_reason: string | null; ai_max: number; ai_spent: number } | null;
  working?: { key: string; title: string; started_at: string | null; step: string | null }[];
  waiting?: number;
  questions?: number;
}
const mmss = (since: string | null, now: number) => {
  if (!since) return "";
  const s = Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/**
 * Under the project menu on every project page: the design run, live. What it is working on (with a running clock and
 * the latest step), what waits for you, and a link back to the run. Polls a small status endpoint, so the page itself
 * is never reloaded under your hands.
 */
export function LiveRunStrip({ projectId }: { projectId: string }) {
  const [live, setLive] = useState<Live | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let stop = false;
    const load = async () => {
      if (document.visibilityState !== "visible") return;
      try { const r = await fetch(`/api/projects/${projectId}/live`, { cache: "no-store" }); if (r.ok && !stop) setLive(await r.json()); } catch { /* next tick */ }
    };
    load();
    const poll = setInterval(load, 5000), tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { stop = true; clearInterval(poll); clearInterval(tick); };
  }, [projectId]);
  const run = live?.run;
  if (!run) return null;
  const href = `/projects/${projectId}/runs/${run.id}`;
  const active = ["pending", "running", "paused"].includes(run.status);
  const waiting = live?.waiting ?? 0;
  const questions = live?.questions ?? 0;
  const ask = questions > 0 && <Link className="live-strip-need" href={`/projects/${projectId}/questions`} data-testid="live-questions">{questions} question{questions > 1 ? "s" : ""} for you</Link>;
  if (!active && !waiting) {
    return (
      <div className={`live-strip live-strip-idle`} data-testid="live-strip">
        <span className="live-strip-dot idle" aria-hidden="true" />
        <span>Last run <strong>{run.status}</strong>{run.stop_reason ? `: ${run.stop_reason}` : ""}</span>
        {ask}
        <Link className="live-strip-link" href={href}>Open the run</Link>
      </div>
    );
  }
  const working = live?.working ?? [];
  return (
    <div className={`live-strip live-strip-${run.status}`} data-testid="live-strip" role="status" aria-live="polite">
      <span className={`live-strip-dot ${active && run.status !== "paused" ? "" : "idle"}`} aria-hidden="true" />
      <span className="live-strip-main">
        <strong>{run.status === "paused" ? "Design run paused" : !active ? "Run stopped" : working.length ? "Design run working" : "Design run in progress"}</strong>
        {working.length > 0 && <> · {working.map((w, i) => (
          <span key={w.key} className="live-strip-task">{i ? ", " : ""}{w.title} <span className="mono">{mmss(w.started_at, now)}</span>
            {w.step && working.length === 1 && <span className="live-strip-step"> — {w.step.slice(0, 140)}</span>}</span>))}</>}
        {active && !working.length && run.status !== "paused" && <span className="muted"> · between tasks</span>}
      </span>
      {waiting > 0 && <Link className="live-strip-need" href={`${href}#approvals`}>{waiting} waiting for your approval</Link>}
      {ask}
      <span className="small muted">AI ${run.ai_spent.toFixed(2)} of ${run.ai_max.toFixed(0)}</span>
      <Link className="live-strip-link" href={href}>Open the run →</Link>
    </div>
  );
}
