/**
 * The product's look in words, from the frozen concept or mock-up image: what engineering must keep (form,
 * proportions, materials and colours, where the screen, buttons, ports and labels are). Written once per design
 * freeze and given to every later design step.
 */
import { z } from "zod";
import type { LanguageModel, Usage } from "./llm/model.ts";

export const LOOK_PROMPT_VERSION = "look-v1";

export const DesignLook = z.object({
  description: z.string().describe("8-15 sentences: overall form and proportions; materials, finishes and colours; every visible feature " +
    "(screen, buttons, ports, lights, labels, fasteners, seams) and where it sits; how it is held or mounted; what the design must keep."),
});
export type DesignLook = z.infer<typeof DesignLook>;

const SYSTEM = `You are an industrial designer briefing the engineering team. Describe the product in the image precisely enough that a mechanical, electrical and firmware team keeps to its look: overall form and proportions, materials, finishes and colours, and every visible feature with its position (top/bottom/left/right/front/back, approximate fraction of the length). Say what must be preserved. Describe only what is visible; do not invent internal parts or dimensions.`;

export async function describeLook(i: { project: string; name: string; note: string | null; cmf: string | null; image: { bytes: Uint8Array; mime: string } },
                                   model: LanguageModel): Promise<{ look: DesignLook; usage: Usage }> {
  const media = (["image/png", "image/jpeg", "image/webp", "image/gif"].includes(i.image.mime) ? i.image.mime : "image/png") as "image/png";
  const r = await model.generate({
    purpose: "design_look", system: SYSTEM, schema: DesignLook,
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: media, data: Buffer.from(i.image.bytes).toString("base64") } },
      { type: "text", text: `Product: ${i.project}\nFrozen design: ${i.name}${i.note ? `\nNote: ${i.note}` : ""}${i.cmf ? `\nCMF given by the team: ${i.cmf}` : ""}\n\nDescribe the look for the engineering team.` },
    ] }],
  });
  return { look: r.output, usage: r.usage };
}

export function offlineLook(): DesignLook {
  return { description: "Offline stand-in, not AI: the look of the frozen design was not described. Keep to the frozen image and envelope." };
}
