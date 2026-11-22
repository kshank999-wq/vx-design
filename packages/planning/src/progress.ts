/**
 * Repair loops stop when they stop making progress, instead of paying for every allowed round: when the checks
 * report exactly the same problems as the round before, or the model returns an output it has already returned.
 * Comparison is on the checked facts (problem lists from ERC/DRC/calculators, the output itself), never on asking a
 * model whether something changed.
 */
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) =>
  x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x);

export class ProgressTracker {
  /** Output seen -> the round it was first seen and that round's problems. */
  private seen = new Map<string, { round: number; problems: string }>();
  private lastProblems: string | null = null;
  private round = 0;

  /**
   * Call after each failed round with that round's output and problems. Returns why repairing should stop (no
   * progress), or null to continue. An output only counts as repeated when it also drew the same problems (a tool
   * such as an autorouter can turn out differently on the same input).
   */
  check(output: unknown, problems: (string | { message: string })[]): string | null {
    this.round++;
    const out = canon(output);
    const probs = problems.map((p) => (typeof p === "string" ? p : p.message).replace(/\s+/g, " ").trim()).sort().join("\n");
    const earlier = this.seen.get(out);
    const sameProblems = this.lastProblems !== null && probs === this.lastProblems;
    if (!earlier) this.seen.set(out, { round: this.round, problems: probs });
    this.lastProblems = probs;
    if (earlier && earlier.problems === probs) return `stopped early: round ${this.round} returned the same output as round ${earlier.round} with the same problems, so further rounds would repeat it`;
    if (sameProblems) return `stopped early: round ${this.round} still has exactly the same ${problems.length} problem(s) as round ${this.round - 1}`;
    return null;
  }
}
