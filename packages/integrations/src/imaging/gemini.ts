/**
 * Google Gemini native image generation ("Nano Banana") via generateContent.
 *
 * Request and response shapes follow Google's API reference (checked 18 Nov 2026): parts with inlineData for
 * reference images, generationConfig.responseModalities ["IMAGE"] and imageConfig.aspectRatio; the image comes back
 * as candidates[].content.parts[].inlineData. Safety refusals arrive as promptFeedback.blockReason (no candidates)
 * or a candidate finishReason such as IMAGE_SAFETY. Google adds a SynthID watermark to every generated image.
 * Untested against the live API until a key is configured.
 */
import { fromBase64, ImageProviderError, toBase64, type Fetch, type GeneratedImage, type ImageProvider, type ImageRequest } from "./types.ts";

export const GEMINI_DEFAULT_MODEL = "gemini-nano-banana-2.1";
const REFUSALS = new Set(["SAFETY", "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII",
                          "IMAGE_RECITATION", "RECITATION"]);

interface Part { text?: string; inlineData?: { mimeType?: string; data?: string }; inline_data?: { mime_type?: string; data?: string } }
interface GeminiResponse {
  candidates?: { content?: { parts?: Part[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: Record<string, unknown>;
  modelVersion?: string;
  error?: { code?: number; message?: string; status?: string };
}

export class GeminiImageProvider implements ImageProvider {
  readonly id = "gemini" as const;
  readonly label = "Google Gemini image";
  readonly terms = "Google Gemini API terms; images carry a SynthID watermark. Paid-tier data is not used to train Google's models (check the current terms).";
  readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly fetchFn: Fetch;
  private readonly base: string;

  constructor(apiKey: string | undefined, model = GEMINI_DEFAULT_MODEL, fetchFn: Fetch = fetch,
              base = "https://generativelanguage.googleapis.com/v1beta") {
    this.apiKey = apiKey;
    this.model = model;
    this.fetchFn = fetchFn;
    this.base = base;
  }

  configured(): boolean { return !!this.apiKey; }

  async generate(req: ImageRequest): Promise<GeneratedImage> {
    if (!this.apiKey) throw new ImageProviderError("gemini", "not_configured", "GEMINI_API_KEY is not set");
    const body = {
      contents: [{ role: "user", parts: [
        { text: req.prompt },
        ...req.references.map((r) => ({ inlineData: { mimeType: r.mimeType, data: toBase64(r.data) } })),
      ] }],
      generationConfig: {
        responseModalities: ["IMAGE"],
        imageConfig: { aspectRatio: req.aspectRatio },
        ...(req.seed != null ? { seed: req.seed } : {}),
      },
    };
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}/models/${encodeURIComponent(this.model)}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180_000),
      });
    } catch (e) {
      throw new ImageProviderError("gemini", "network", (e as Error).message);
    }
    const text = await res.text();
    let json: GeminiResponse;
    try { json = JSON.parse(text) as GeminiResponse; } catch { throw new ImageProviderError("gemini", "parse", `HTTP ${res.status}: ${text.slice(0, 200)}`); }
    if (res.status === 429) throw new ImageProviderError("gemini", "rate_limit", json.error?.message ?? "rate limited");
    if (res.status === 401 || res.status === 403) throw new ImageProviderError("gemini", "auth", json.error?.message ?? `HTTP ${res.status}`);
    if (!res.ok) throw new ImageProviderError("gemini", "http", `HTTP ${res.status}: ${json.error?.message ?? text.slice(0, 200)}`);
    if (json.promptFeedback?.blockReason) {
      throw new ImageProviderError("gemini", "refused", `prompt blocked (${json.promptFeedback.blockReason})`);
    }
    const cand = json.candidates?.[0];
    if (!cand) throw new ImageProviderError("gemini", "parse", "no candidates in the response");
    const parts = cand.content?.parts ?? [];
    const img = parts.map((p) => p.inlineData ? { mime: p.inlineData.mimeType, data: p.inlineData.data }
                                : p.inline_data ? { mime: p.inline_data.mime_type, data: p.inline_data.data } : null)
                     .find((x) => x?.data && (x.mime ?? "").startsWith("image/"));
    const note = parts.map((p) => p.text).filter(Boolean).join("\n").trim();
    if (!img) {
      if (cand.finishReason && REFUSALS.has(cand.finishReason)) {
        throw new ImageProviderError("gemini", "refused", `image declined (${cand.finishReason})${note ? `: ${note.slice(0, 200)}` : ""}`);
      }
      throw new ImageProviderError("gemini", "parse", `no image returned (finishReason ${cand.finishReason ?? "none"})${note ? `: ${note.slice(0, 200)}` : ""}`);
    }
    return {
      mimeType: img.mime!, data: fromBase64(img.data!), provider: "gemini", model: json.modelVersion ?? this.model,
      seed: req.seed != null ? String(req.seed) : null, revisedPrompt: null,
      meta: { usage: json.usageMetadata ?? null, watermark: "SynthID (added by Google)", note: note || null, finishReason: cand.finishReason ?? null },
    };
  }
}
