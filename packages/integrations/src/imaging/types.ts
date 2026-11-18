/**
 * Image generation for concepts (spec §9): a provider-neutral adapter, like the model gateway. Every image is a
 * concept, never engineering geometry; the provider, model, prompt, references and seed travel with it.
 */

export type ImageProviderId = "gemini" | "openai" | "fixture";
export type AspectRatio = "1:1" | "3:2" | "2:3" | "4:3" | "3:4" | "16:9";

export interface ReferenceImage {
  mimeType: string;
  data: Uint8Array;
  /** What the reference is, for the record ("variant 2 of round 1"). */
  label: string;
}

export interface ImageRequest {
  prompt: string;
  references: ReferenceImage[];
  aspectRatio: AspectRatio;
  /** Honoured only by providers that support it; the image records whether it was. */
  seed?: number;
}

export interface GeneratedImage {
  mimeType: string;
  data: Uint8Array;
  provider: ImageProviderId;
  model: string;
  seed: string | null;
  /** The prompt as the provider rewrote it, if it did. */
  revisedPrompt: string | null;
  /** Usage, watermark notice, text the model returned alongside the image. */
  meta: Record<string, unknown>;
}

export class ImageProviderError extends Error {
  readonly provider: ImageProviderId;
  /** refused: the provider's safety system declined (not retryable with the same prompt). */
  readonly kind: "auth" | "rate_limit" | "refused" | "http" | "network" | "parse" | "not_configured";
  constructor(provider: ImageProviderId, kind: ImageProviderError["kind"], message: string) {
    super(`${provider}: ${message}`);
    this.provider = provider;
    this.kind = kind;
  }
  get retryable(): boolean {
    return this.kind === "rate_limit" || this.kind === "network" || this.kind === "http";
  }
}

export interface ImageProvider {
  readonly id: ImageProviderId;
  readonly label: string;
  readonly model: string;
  configured(): boolean;
  /** Recorded with every image: what the terms say about use and data sharing (checked by the owner). */
  readonly terms: string;
  generate(req: ImageRequest): Promise<GeneratedImage>;
}

export type Fetch = typeof fetch;

export function toBase64(b: Uint8Array): string {
  return Buffer.from(b).toString("base64");
}
export function fromBase64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64"));
}

/** Spec §9: generateConcept(prompt, references, n) -> images plus provider, model, prompt and seed. */
export async function generateConcept(provider: ImageProvider, prompt: string, references: ReferenceImage[], n: number,
                                      aspectRatio: AspectRatio = "4:3"): Promise<GeneratedImage[]> {
  const out: GeneratedImage[] = [];
  for (let i = 0; i < n; i++) out.push(await provider.generate({ prompt, references, aspectRatio }));
  return out;
}
