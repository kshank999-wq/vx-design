/**
 * Reads one string field out of a JSON object that is still arriving (structured output streamed as text), so a
 * reply can be shown as it is written. Returns the decoded text so far, stopping before an escape sequence that has
 * not fully arrived; null until the field has started.
 */
export function partialStringField(json: string, field: string): string | null {
  const m = new RegExp(`"${field}"\\s*:\\s*"`).exec(json);
  if (!m) return null;
  let i = m.index + m[0].length, out = "";
  while (i < json.length) {
    const ch = json[i]!;
    if (ch === "\"") return out;
    if (ch !== "\\") { out += ch; i++; continue; }
    const next = json[i + 1];
    if (next == null) return out;
    if (next === "u") {
      const hex = json.slice(i + 2, i + 6);
      if (hex.length < 4) return out;
      const code = parseInt(hex, 16);
      // A high surrogate waits for its low half.
      if (code >= 0xd800 && code <= 0xdbff) {
        if (json.length < i + 12) return out;
        out += String.fromCharCode(code, parseInt(json.slice(i + 8, i + 12), 16));
        i += 12;
      } else { out += String.fromCharCode(code); i += 6; }
      continue;
    }
    out += ({ n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" } as Record<string, string>)[next] ?? next;
    i += 2;
  }
  return out;
}
