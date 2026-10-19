/**
 * Prompts for regenerating a scene in Google Flow (Veo) from a reference frame of the current clip.
 * The reference image carries the exact product; the prompt asks Veo to keep it identical and only
 * change the camera. Built from rules (no AI call), so it is free and predictable; the user can edit
 * it before generating.
 */

/** Provenance source of clips regenerated in Google Flow (QA asks for YouTube's AI label). */
export const GENERATED_SOURCE = "ai_generated";

export const FLOW_ANGLES = {
  animate: { label: "Same shot, animated", camera: "Keep the framing of the reference image and add a slow, subtle push-in" },
  closeup: { label: "Close-up detail", camera: "Macro close-up that slowly glides across the key detail, shallow depth of field" },
  low: { label: "Low-angle hero", camera: "Low-angle hero shot, the camera slowly rises and tilts up toward the product" },
  orbit: { label: "Slow orbit", camera: "Slow 90-degree orbit around the product at eye level, product stays centred" },
  top: { label: "Top-down", camera: "Top-down overhead shot with a slow rotation, product centred on the surface" },
  hands: { label: "Hands-on use", camera: "Over-the-shoulder shot of hands handling and operating the product, no faces visible" },
  wide: { label: "Wide establishing", camera: "Wide establishing shot of the product in a fitting real-world setting, slow dolly-in" },
} as const;

export type FlowAngle = keyof typeof FLOW_ANGLES;
export const isFlowAngle = (a: unknown): a is FlowAngle => typeof a === "string" && a in FLOW_ANGLES;

export interface FlowPromptInput {
  /** "Ruger Security-9" (null for scenes without a product). */
  product: string | null;
  /** Spec the narration talks about ("trigger"). */
  spec?: string | null;
  /** Kind of product, for scenes where the name alone is ambiguous ("pistol", "lawn mower"). */
  category?: string | null;
  /** The narration of the scene, used only as context. */
  sceneText: string;
  angle: FlowAngle;
  /** Clip length the scene needs (Veo clips are 4-8 s). */
  seconds: number;
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

export function buildFlowPrompt(i: FlowPromptInput): string {
  const subject = i.product ? `the ${i.product}${i.category ? ` ${i.category}` : ""}` : i.category ? `the ${i.category}` : "the subject";
  const focus = i.spec ? ` Focus on the ${i.spec}.` : "";
  const context = clean(i.sceneText).slice(0, 220);
  const seconds = Math.max(4, Math.min(8, Math.round(i.seconds)));
  return clean(`Cinematic product B-roll of ${subject}, exactly as in the reference image: same model, shape, colours and markings; do not add or change any parts, text or logos.
${FLOW_ANGLES[i.angle].camera}.${focus}
Realistic natural lighting, sharp detail, smooth stabilised camera, 16:9, about ${seconds} seconds.
No on-screen text, no captions, no watermarks, no people's faces.
Scene context (do not show as text): "${context}"`).replace(/ \./g, ".");
}
