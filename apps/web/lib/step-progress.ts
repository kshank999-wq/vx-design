/**
 * A rough "how far along" for a step that is being worked on, from two things we know:
 *  - how long finished steps of the same kind took (the typical time), against how long this one has been going;
 *  - for steps that work in rounds (layout, schematic, enclosure, power, analysis), which round it has finished.
 * The larger of the two is shown, never 100% until the step is done, and labelled as an estimate.
 */

// Rounds a step may take at most (its repair limit + the first round).
const MAX_ROUNDS: Record<string, number> = { pcb_layout: 4, schematic: 4, enclosure: 4, power: 4, simulation: 3, assembly: 3 };
// When there is no history yet: a typical time in seconds for each kind of step.
const DEFAULT_SECONDS: Record<string, number> = { pcb_layout: 1500, schematic: 600, enclosure: 600, simulation: 420, power: 420, sourcing: 240 };

export interface Progress { pct: number; label: string; slow: boolean }

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

/** Typical seconds per discipline from finished (succeeded) executions. */
export function typicalSeconds(rows: { discipline: string; started_at: string | null; finished_at: string | null }[]): Map<string, number> {
  const by = new Map<string, number[]>();
  for (const r of rows) {
    if (!r.started_at || !r.finished_at) continue;
    const s = (new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()) / 1000;
    if (s > 5) by.set(r.discipline, [...(by.get(r.discipline) ?? []), s]);
  }
  return new Map([...by].map(([d, xs]) => [d, median(xs)!]));
}

export function estimateProgress(p: { discipline: string; startedAt: string | null; lastLog: string | null; typical?: number | null; now?: number }): Progress {
  const now = p.now ?? Date.now();
  const elapsed = p.startedAt ? Math.max(0, (now - new Date(p.startedAt).getTime()) / 1000) : 0;
  const typical = p.typical ?? DEFAULT_SECONDS[p.discipline] ?? 300;
  const timePct = Math.min(0.95, elapsed / typical);
  const m = /\bround (\d+)\b/i.exec(p.lastLog ?? "");
  const max = MAX_ROUNDS[p.discipline];
  const roundPct = m && max ? Math.min(0.95, Number(m[1]) / max) : 0;
  const storing = /^step store/i.test(p.lastLog ?? "");
  const frac = Math.min(0.97, Math.max(timePct, roundPct, storing ? 0.95 : 0));
  const pct = Math.round(100 * frac);
  // Time left: from the rounds when they say it is further along than the clock does, else from the typical time.
  const left = roundPct > timePct && frac > 0 ? elapsed * (1 / frac - 1) : Math.max(0, typical - elapsed);
  const slow = elapsed > typical * 1.25 && roundPct <= timePct;
  const when = slow ? "taking longer than usual" : left < 60 ? "under a minute left" : `about ${Math.round(left / 60)} min left`;
  const rounds = m && max ? ` · round ${m[1]} of up to ${max}` : "";
  return { pct, slow, label: `about ${pct}%${rounds} · ${when}` };
}
