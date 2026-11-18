/**
 * OpenAI image generation (GPT image models).
 *
 * Shapes follow OpenAI's published OpenAPI spec (checked 18 Nov 2026): POST /v1/images/generations (JSON: model,
 * prompt, n, size, quality, output_format) and, with reference images, POST /v1/images/edits (multipart, repeated
 * image[] fields). GPT image models always return data[].b64_json. The model must be named explicitly; gpt-image-1
 * was shut down on 23 Oct 2026. Untested against the live API until a key is configured.
 */
import { fromBase64, ImageProviderError, type AspectRatio, type Fetch, type GeneratedImage, type ImageProvider, type ImageRequest } from "./types.ts";

export const OPENAI_DEFAULT_IMAGE_MODEL = "gpt-image-2.5-sunburst";

/** GPT image sizes: square, landscape or portrait. */
export function openAiSize(a: AspectRatio): string {
  if (a === "1:1") return "1024x1024";
  return a === "2:3" || a === "3:4" ? "1024x1536" : "1536x1024";
}

interface OpenAiResponse {
  data?: { b64_json?: string; revised_prompt?: string }[];
  usage?: Record<string, unknown>;
  output_format?: string;
  error?: { message?: string; code?: string | null; type?: string };
}

export class OpenAiImageProvider implements ImageProvider {
  readonly id = "openai" as const;
  readonly label = "OpenAI image";
  readonly terms = "OpenAI API terms: API data is not used for training by default (check the current terms and data-retention settings).";
  readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly fetchFn: Fetch;
  private readonly base: string;

  constructor(apiKey: string | undefined, model = OPENAI_DEFAULT_IMAGE_MODEL, fetchFn: Fetch = fetch, base = "https://api.openai.com/v1") {
    this.apiKey = apiKey;
    this.model = model;
    this.fetchFn = fetchFn;
    this.base = base;
  }

  configured(): boolean { return !!this.apiKey; }

  async generate(req: ImageRequest): Promise<GeneratedImage> {
    if (!this.apiKey) throw new ImageProviderError("openai", "not_configured", "OPENAI_API_KEY is not set");
    const size = openAiSize(req.aspectRatio);
    let init: RequestInit;
    let path: string;
    if (req.references.length) {
      const form = new FormData();
      form.set("model", this.model);
      form.set("prompt", req.prompt);
      form.set("n", "1");
      form.set("size", size);
      form.set("output_format", "png");
      const field = req.references.length > 1 ? "image[]" : "image";
      req.references.forEach((r, i) => form.append(field, new Blob([new Uint8Array(r.data)], { type: r.mimeType }), `reference-${i + 1}.${r.mimeType.split("/")[1] ?? "png"}`));
      init = { method: "POST", headers: { authorization: `Bearer ${this.apiKey}` }, body: form };
      path = "/images/edits";
    } else {
      init = { method: "POST", headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
               body: JSON.stringify({ model: this.model, prompt: req.prompt, n: 1, size, output_format: "png" }) };
      path = "/images/generations";
    }
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}${path}`, { ...init, signal: AbortSignal.timeout(180_000) });
    } catch (e) {
      throw new ImageProviderError("openai", "network", (e as Error).message);
    }
    const text = await res.text();
    let json: OpenAiResponse;
    try { json = JSON.parse(text) as OpenAiResponse; } catch { throw new ImageProviderError("openai", "parse", `HTTP ${res.status}: ${text.slice(0, 200)}`); }
    const msg = json.error?.message ?? text.slice(0, 200);
    if (res.status === 429) throw new ImageProviderError("openai", "rate_limit", msg);
    if (res.status === 401 || res.status === 403) throw new ImageProviderError("openai", "auth", msg);
    if (res.status === 400 && /moderation|safety|content.?policy/i.test(`${json.error?.code ?? ""} ${msg}`)) {
      throw new ImageProviderError("openai", "refused", msg);
    }
    if (!res.ok) throw new ImageProviderError("openai", "http", `HTTP ${res.status}: ${msg}`);
    const img = json.data?.[0];
    if (!img?.b64_json) throw new ImageProviderError("openai", "parse", "no image in the response");
    const fmt = json.output_format ?? "png";
    return {
      mimeType: `image/${fmt === "jpg" ? "jpeg" : fmt}`, data: fromBase64(img.b64_json), provider: "openai", model: this.model,
      seed: null, revisedPrompt: img.revised_prompt ?? null,
      meta: { usage: json.usage ?? null, size, endpoint: path },
    };
  }
}
