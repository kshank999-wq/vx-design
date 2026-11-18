/**
 * Picks the concept image provider from the worker's environment. Keys are worker secrets (spec §9).
 *   VX_IMAGES=fixture   offline placeholder (labelled on the image)
 *   VX_IMAGES=off       no image generation
 *   VX_IMAGE_PROVIDER   gemini | openai, when both keys are set (default gemini)
 *   VX_IMAGE_MODEL      override the provider's default model
 */
import { FixtureImageProvider } from "./fixture.ts";
import { GEMINI_DEFAULT_MODEL, GeminiImageProvider } from "./gemini.ts";
import { OPENAI_DEFAULT_IMAGE_MODEL, OpenAiImageProvider } from "./openai.ts";
import type { ImageProvider } from "./types.ts";

export function imageProviderFromEnv(env: Record<string, string | undefined> = process.env): ImageProvider | null {
  if (env.VX_IMAGES === "fixture") return new FixtureImageProvider();
  if (env.VX_IMAGES === "off") return null;
  const gemini = env.GEMINI_API_KEY ? new GeminiImageProvider(env.GEMINI_API_KEY, env.VX_IMAGE_MODEL || GEMINI_DEFAULT_MODEL) : null;
  const openai = env.OPENAI_API_KEY ? new OpenAiImageProvider(env.OPENAI_API_KEY, env.VX_IMAGE_MODEL || OPENAI_DEFAULT_IMAGE_MODEL) : null;
  if (env.VX_IMAGE_PROVIDER === "openai") return openai;
  if (env.VX_IMAGE_PROVIDER === "gemini") return gemini;
  return gemini ?? openai;
}
