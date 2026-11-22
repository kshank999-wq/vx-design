/**
 * A small, safe expression evaluator for engineering calculations written by the model: numbers, named quantities,
 * + - * / ^, comparisons, and/or/not, and a fixed set of math functions. No property access, no calls outside the
 * list, no strings: what the model writes is evaluated here, so the numbers in a report are computed, not claimed.
 */
const FUNCS: Record<string, (...a: number[]) => number> = {
  sqrt: Math.sqrt, abs: Math.abs, min: Math.min, max: Math.max, pow: Math.pow, exp: Math.exp, ln: Math.log, log: Math.log,
  log10: Math.log10, log2: Math.log2, sin: Math.sin, cos: Math.cos, tan: Math.tan, atan: Math.atan, floor: Math.floor,
  ceil: Math.ceil, round: Math.round,
};
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E };

type Tok = { t: "num"; v: number } | { t: "id"; v: string } | { t: "op"; v: string };

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) { i++; continue; }
    const num = /^(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(src.slice(i));
    if (num) { out.push({ t: "num", v: Number(num[0]) }); i += num[0].length; continue; }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (id) { out.push({ t: "id", v: id[0] }); i += id[0].length; continue; }
    const op = /^(<=|>=|==|!=|&&|\|\||[-+*/^(),<>!])/.exec(src.slice(i));
    if (op) { out.push({ t: "op", v: op[0] }); i += op[0].length; continue; }
    throw new Error(`unexpected "${c}" at ${i + 1}`);
  }
  return out;
}

/** Evaluates an expression with the given variables; booleans come back as 1 / 0. */
export function evaluate(src: string, vars: Record<string, number>): number {
  const toks = lex(src);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => peek()?.t === "op" && peek()!.v === v;
  const isWord = (v: string) => peek()?.t === "id" && String(peek()!.v).toLowerCase() === v;
  const expect = (v: string) => { if (!isOp(v)) throw new Error(`expected "${v}"`); p++; };
  const or = (): number => { let l = and(); while (isOp("||") || isWord("or")) { p++; const r = and(); l = l || r ? 1 : 0; } return l; };
  const and = (): number => { let l = not(); while (isOp("&&") || isWord("and")) { p++; const r = not(); l = l && r ? 1 : 0; } return l; };
  const not = (): number => { if (isOp("!") || isWord("not")) { p++; return not() ? 0 : 1; } return cmp(); };
  const cmp = (): number => {
    const l = add();
    const t = peek();
    if (t?.t === "op" && ["<", "<=", ">", ">=", "==", "!="].includes(t.v)) {
      p++;
      const r = add();
      const eq = Math.abs(l - r) <= 1e-9 * Math.max(1, Math.abs(l), Math.abs(r));
      return ({ "<": l < r, "<=": l <= r || eq, ">": l > r, ">=": l >= r || eq, "==": eq, "!=": !eq } as Record<string, boolean>)[t.v] ? 1 : 0;
    }
    return l;
  };
  const add = (): number => { let l = mul(); while (isOp("+") || isOp("-")) { const o = toks[p++]!.v; const r = mul(); l = o === "+" ? l + r : l - r; } return l; };
  const mul = (): number => { let l = unary(); while (isOp("*") || isOp("/")) { const o = toks[p++]!.v; const r = unary(); l = o === "*" ? l * r : l / r; } return l; };
  const unary = (): number => { if (isOp("-")) { p++; return -unary(); } if (isOp("+")) { p++; return unary(); } return pow(); };
  const pow = (): number => { const b = atom(); if (isOp("^")) { p++; return b ** unary(); } return b; };
  const atom = (): number => {
    const t = toks[p++];
    if (!t) throw new Error("unexpected end of expression");
    if (t.t === "num") return t.v;
    if (t.t === "op" && t.v === "(") { const v = or(); expect(")"); return v; }
    if (t.t === "id") {
      if (isOp("(")) {
        const f = FUNCS[t.v.toLowerCase()];
        if (!f) throw new Error(`unknown function ${t.v}()`);
        p++;
        const args: number[] = [];
        if (!isOp(")")) { args.push(or()); while (isOp(",")) { p++; args.push(or()); } }
        expect(")");
        return f(...args);
      }
      if (t.v in vars) return vars[t.v]!;
      if (t.v.toLowerCase() in CONSTS) return CONSTS[t.v.toLowerCase()]!;
      throw new Error(`unknown name ${t.v}`);
    }
    throw new Error(`unexpected "${t.v}"`);
  };
  const v = or();
  if (p < toks.length) throw new Error(`unexpected "${(toks[p] as { v: unknown }).v}" after the expression`);
  return v;
}

/** Names an expression uses (to order quantities and report what is missing). */
export function namesIn(src: string): string[] {
  try {
    const toks = lex(src);
    return [...new Set(toks.flatMap((t, i) => t.t === "id" && !(toks[i + 1]?.t === "op" && toks[i + 1]!.v === "(")
      && !["and", "or", "not"].includes(t.v.toLowerCase()) && !(t.v.toLowerCase() in CONSTS) ? [t.v] : []))];
  } catch { return []; }
}

/**
 * Evaluates named quantities in dependency order. Returns their values and, per quantity, the problem that kept it
 * from being computed (unknown name, a loop, a syntax error, a value that is not a finite number).
 */
export function evaluateAll(qs: { name: string; expression: string }[], given: Record<string, number> = {}):
    { values: Record<string, number>; problems: string[] } {
  const values: Record<string, number> = { ...given };
  const problems: string[] = [];
  const byName = new Map<string, string>();
  for (const q of qs) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(q.name)) problems.push(`quantity "${q.name}": names must be letters, digits and _ (no spaces or units)`);
    else if (byName.has(q.name) || q.name in given) problems.push(`quantity "${q.name}" is defined twice`);
    else byName.set(q.name, q.expression);
  }
  let pending = [...byName.keys()];
  for (let guard = 0; pending.length && guard < byName.size + 1; guard++) {
    const next: string[] = [];
    for (const n of pending) {
      const deps = namesIn(byName.get(n)!);
      if (deps.some((d) => byName.has(d) && !(d in values))) { next.push(n); continue; }
      try {
        const v = evaluate(byName.get(n)!, values);
        if (!Number.isFinite(v)) problems.push(`quantity "${n}" = ${byName.get(n)} is not a finite number`);
        else values[n] = v;
      } catch (e) { problems.push(`quantity "${n}" = ${byName.get(n)}: ${(e as Error).message}`); }
    }
    if (next.length === pending.length) {
      for (const n of next) problems.push(`quantity "${n}" depends on itself or on a quantity that could not be computed`);
      break;
    }
    pending = next;
  }
  return { values, problems };
}
