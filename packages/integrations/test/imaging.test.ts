// Image adapters against the request/response shapes in the providers' published references (checked 18 Nov 2026).
// No live calls: fetch is replaced. Live tests wait for keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FixtureImageProvider, GeminiImageProvider, ImageProviderError, imageProviderFromEnv, OpenAiImageProvider, openAiSize,
         type ImageRequest } from "../src/index.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const b64 = Buffer.from(PNG).toString("base64");
const req = (refs = 0): ImageRequest => ({
  prompt: "Product concept render of a slate", aspectRatio: "4:3", seed: 7,
  references: Array.from({ length: refs }, (_, i) => ({ mimeType: "image/png", data: new Uint8Array([i]), label: `ref ${i + 1}` })),
});
function fakeFetch(status: number, body: unknown, calls: { url: string; init: RequestInit }[] = []) {
  return Object.assign(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }, { calls }) as unknown as typeof fetch & { calls: { url: string; init: RequestInit }[] };
}
async function refusal(p: Promise<unknown>, kind: string) {
  await assert.rejects(p, (e: unknown) => e instanceof ImageProviderError && e.kind === kind);
}

test("gemini: request shape (references as inlineData, image modality, aspect ratio, seed) and image parsed", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = fakeFetch(200, { candidates: [{ content: { parts: [{ text: "Here it is" }, { inlineData: { mimeType: "image/png", data: b64 } }] },
                                            finishReason: "STOP" }], usageMetadata: { totalTokenCount: 1300 }, modelVersion: "gemini-nano-banana-2.1" }, calls);
  const g = new GeminiImageProvider("k", "gemini-nano-banana-2.1", f);
  const img = await g.generate(req(2));
  assert.equal(calls[0]!.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-nano-banana-2.1:generateContent");
  assert.equal((calls[0]!.init.headers as Record<string, string>)["x-goog-api-key"], "k");
  const body = JSON.parse(String(calls[0]!.init.body));
  assert.equal(body.contents[0].parts[0].text, "Product concept render of a slate");
  assert.deepEqual(body.contents[0].parts[1], { inlineData: { mimeType: "image/png", data: "AA==" } });
  assert.equal(body.contents[0].parts.length, 3);
  assert.deepEqual(body.generationConfig, { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "4:3" }, seed: 7 });
  assert.deepEqual(img.data, PNG);
  assert.equal(img.mimeType, "image/png");
  assert.equal(img.seed, "7");
  assert.equal(img.meta.watermark, "SynthID (added by Google)");
  assert.equal(img.meta.note, "Here it is");
});

test("gemini: snake_case inline_data is accepted too", async () => {
  const f = fakeFetch(200, { candidates: [{ content: { parts: [{ inline_data: { mime_type: "image/jpeg", data: b64 } }] } }] });
  const img = await new GeminiImageProvider("k", undefined, f).generate(req());
  assert.equal(img.mimeType, "image/jpeg");
});

test("gemini: safety refusals, rate limits and auth are told apart", async () => {
  await refusal(new GeminiImageProvider("k", undefined, fakeFetch(200, { promptFeedback: { blockReason: "SAFETY" } })).generate(req()), "refused");
  await refusal(new GeminiImageProvider("k", undefined, fakeFetch(200, { candidates: [{ content: { parts: [{ text: "cannot" }] }, finishReason: "IMAGE_SAFETY" }] })).generate(req()), "refused");
  await refusal(new GeminiImageProvider("k", undefined, fakeFetch(200, { candidates: [{ content: { parts: [] }, finishReason: "NO_IMAGE" }] })).generate(req()), "parse");
  await refusal(new GeminiImageProvider("k", undefined, fakeFetch(429, { error: { message: "quota" } })).generate(req()), "rate_limit");
  await refusal(new GeminiImageProvider("k", undefined, fakeFetch(403, { error: { message: "API key invalid" } })).generate(req()), "auth");
  await refusal(new GeminiImageProvider(undefined).generate(req()), "not_configured");
  const e = new ImageProviderError("gemini", "rate_limit", "x");
  assert.equal(e.retryable, true);
  assert.equal(new ImageProviderError("gemini", "refused", "x").retryable, false);
});

test("openai: generations JSON without references; edits multipart with image[] for several references", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const ok = { created: 1, data: [{ b64_json: b64 }], usage: { total_tokens: 10 }, output_format: "png" };
  const o = new OpenAiImageProvider("sk", "gpt-image-2", fakeFetch(200, ok, calls));
  const img = await o.generate(req());
  assert.equal(calls[0]!.url, "https://api.openai.com/v1/images/generations");
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, "Bearer sk");
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)),
    { model: "gpt-image-2", prompt: "Product concept render of a slate", n: 1, size: "1536x1024", output_format: "png" });
  assert.deepEqual(img.data, PNG);
  assert.equal(img.seed, null, "GPT image models take no seed");

  await o.generate(req(2));
  assert.equal(calls[1]!.url, "https://api.openai.com/v1/images/edits");
  const form = calls[1]!.init.body as FormData;
  assert.equal(form.getAll("image[]").length, 2);
  assert.equal(form.get("model"), "gpt-image-2");
  await o.generate(req(1));
  assert.equal((calls[2]!.init.body as FormData).getAll("image").length, 1);
  assert.equal(openAiSize("1:1"), "1024x1024");
  assert.equal(openAiSize("3:4"), "1024x1536");
});

test("openai: moderation refusal vs other errors", async () => {
  await refusal(new OpenAiImageProvider("sk", undefined, fakeFetch(400, { error: { message: "Your request was rejected by the safety system.", code: "moderation_blocked", type: "image_generation_user_error", param: null } })).generate(req()), "refused");
  await refusal(new OpenAiImageProvider("sk", undefined, fakeFetch(400, { error: { message: "Invalid size", code: null, type: "invalid_request_error", param: "size" } })).generate(req()), "http");
  await refusal(new OpenAiImageProvider("sk", undefined, fakeFetch(500, { error: { message: "image could not be generated", code: null, type: "server_error", param: null } })).generate(req()), "http");
});

test("fixture: deterministic, labelled placeholder", async () => {
  const f = new FixtureImageProvider();
  const a = await f.generate({ ...req(1), seed: undefined });
  const b = await f.generate({ ...req(1), seed: undefined });
  assert.deepEqual(a.data, b.data);
  const svg = new TextDecoder().decode(a.data);
  assert.match(svg, /OFFLINE PLACEHOLDER · not a generated concept · concept, not CAD/);
  assert.match(svg, /Refines: ref 1/);
  assert.equal(a.mimeType, "image/svg+xml");
});

test("provider chosen from the environment", () => {
  assert.equal(imageProviderFromEnv({ VX_IMAGES: "fixture" })?.id, "fixture");
  assert.equal(imageProviderFromEnv({ VX_IMAGES: "off", GEMINI_API_KEY: "k" }), null);
  assert.equal(imageProviderFromEnv({}), null);
  assert.equal(imageProviderFromEnv({ GEMINI_API_KEY: "k", OPENAI_API_KEY: "o" })?.id, "gemini");
  assert.equal(imageProviderFromEnv({ GEMINI_API_KEY: "k", OPENAI_API_KEY: "o", VX_IMAGE_PROVIDER: "openai" })?.id, "openai");
  assert.equal(imageProviderFromEnv({ OPENAI_API_KEY: "o", VX_IMAGE_MODEL: "gpt-image-2" })?.model, "gpt-image-2");
});
