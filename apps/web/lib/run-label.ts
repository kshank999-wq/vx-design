/**
 * Runs are numbered within their project in the order they were started (Run 1, Run 2, ...), so they can be told
 * apart; a name someone gave a run ("Overnight") is shown after the number. Default names ("Run", "Run (continued)")
 * add nothing and are left out.
 */
export function runNumbers(runs: { id: string; created_at: string }[]): Map<string, number> {
  const sorted = [...runs].sort((a, b) => a.created_at.localeCompare(b.created_at));
  return new Map(sorted.map((r, i) => [r.id, i + 1]));
}

export function runLabel(n: number | undefined, name: string | null | undefined): string {
  const custom = name && !/^Run( \(continued( \d+)?\))?$/.test(name.trim()) ? name.replace(/ \(continued( \d+)?\)$/, "") : null;
  return `Run ${n ?? "?"}${custom ? ` · ${custom}` : ""}`;
}
