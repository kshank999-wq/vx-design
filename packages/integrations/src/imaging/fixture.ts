/**
 * Offline stand-in (VX_IMAGES=fixture): draws a plain, clearly labelled placeholder instead of calling a provider,
 * so the concept workflow can be developed and tested without keys. It is not a generated concept and says so on
 * the image itself.
 */
import { createHash } from "node:crypto";
import type { GeneratedImage, ImageProvider, ImageRequest } from "./types.ts";

const PALETTES = [["#1f2933", "#f97316"], ["#e5e7eb", "#2563eb"], ["#3f3f46", "#22c55e"], ["#78716c", "#facc15"], ["#0f766e", "#f1f5f9"]];
const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]!));

function wrap(text: string, width: number, lines: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const w of text.split(/\s+/)) {
    if ((cur + " " + w).trim().length > width) { out.push(cur.trim()); cur = w; } else cur += " " + w;
    if (out.length === lines) break;
  }
  if (out.length < lines && cur.trim()) out.push(cur.trim());
  return out;
}

export class FixtureImageProvider implements ImageProvider {
  readonly id = "fixture" as const;
  readonly label = "Offline placeholder (not a generated concept)";
  readonly model = "fixture-placeholder-1";
  readonly terms = "Offline placeholder drawn by VX Design; no external service is called.";
  configured(): boolean { return true; }

  async generate(req: ImageRequest): Promise<GeneratedImage> {
    const h = createHash("sha256").update(req.prompt).update(String(req.seed ?? "")).digest();
    const [body, accent] = PALETTES[h[0]! % PALETTES.length]!;
    const w = 800, ht = 600;
    const dw = 300 + (h[1]! % 120), dh = 200 + (h[2]! % 120), r = 12 + (h[3]! % 40);
    const x = (w - dw) / 2, y = (ht - dh) / 2 - 20;
    const prompt = wrap(req.prompt, 90, 3).map((l, i) => `<text x="40" y="${530 + i * 18}" font-size="13" fill="#57534e">${esc(l)}</text>`).join("");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${ht}" viewBox="0 0 ${w} ${ht}">
<rect width="${w}" height="${ht}" fill="#f5f5f4"/>
<rect x="${x + 10}" y="${y + 14}" width="${dw}" height="${dh}" rx="${r}" fill="#000" opacity=".12"/>
<rect x="${x}" y="${y}" width="${dw}" height="${dh}" rx="${r}" fill="${body}"/>
<rect x="${x + 24}" y="${y + 24}" width="${dw * 0.62}" height="${dh * 0.45}" rx="6" fill="#111827" stroke="${accent}" stroke-width="3"/>
<circle cx="${x + dw - 40}" cy="${y + 50}" r="14" fill="${accent}"/><circle cx="${x + dw - 40}" cy="${y + 95}" r="14" fill="${accent}"/>
<rect x="0" y="0" width="${w}" height="44" fill="#7c2d12"/>
<text x="20" y="28" font-size="18" font-family="sans-serif" fill="#fff" font-weight="bold">OFFLINE PLACEHOLDER · not a generated concept · concept, not CAD</text>
${req.references.length ? `<text x="40" y="505" font-size="13" fill="#57534e">Refines: ${esc(req.references.map((r) => r.label).join(", "))}</text>` : ""}
${prompt}
</svg>`;
    return {
      mimeType: "image/svg+xml", data: new TextEncoder().encode(svg), provider: "fixture", model: this.model,
      seed: req.seed != null ? String(req.seed) : h.subarray(0, 4).toString("hex"), revisedPrompt: null,
      meta: { placeholder: true, references: req.references.map((r) => r.label) },
    };
  }
}
