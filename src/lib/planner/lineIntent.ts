/**
 * What a non-product line does, so its B-roll can match it the way an editor would: a question to
 * the viewer gets someone thinking, "let me know in the comments" gets hands typing on a phone.
 * Only used for generic stock (GENERIC_STOCK=on); queries avoid people talking to the camera (the
 * narrator's voice over moving lips reads as fake). People shots are capped per video (peopleCap).
 */

export type LineIntent = "subscribe" | "comment" | "goodbye" | "question" | "surprise" | "problem";

const RULES: [LineIntent, RegExp][] = [
  ["subscribe", /\b(subscribe|hit the (?:bell|like)|like (?:this|the) video|smash (?:that|the) like)\b/i],
  ["comment", /\b(let (?:me|us) know|in the comments|comment below|drop a comment|tell me (?:in|below))\b/i],
  ["goodbye", /\b(thanks? (?:you )?for watching|see you (?:in the next|next time|soon)|good ?bye|until next time)\b/i],
  ["question", /\b(what do you think|have you ever|would you rather|which (?:one )?(?:would|will|do) you|ask yourself|are you (?:sure|ready))\b|\?\s*$/i],
  ["surprise", /\b(shock(?:ed|ing)|surpris(?:ed|ing)|blew my mind|couldn't believe|can't believe|jaw.?dropping|wow)\b/i],
  ["problem", /\b(problem|mistakes?|frustrat\w*|annoying|waste of|regret|went wrong)\b/i],
];

/** Stock searches per intent (Pexels / Pixabay wording, no faces talking to camera). */
export const INTENT_QUERIES: Record<LineIntent, string[]> = {
  subscribe: ["finger tapping phone screen", "thumbs up hand", "hand pressing button"],
  comment: ["hands typing on smartphone", "person texting on phone", "typing message phone close up"],
  goodbye: ["person waving goodbye", "walking away sunset", "closing door slow motion"],
  question: ["person thinking", "man scratching head thinking", "woman deciding thoughtful"],
  surprise: ["surprised person reaction", "amazed face reaction", "jaw drop surprised"],
  problem: ["frustrated person", "confused man", "annoyed woman sighing"],
};

export function lineIntent(text: string): LineIntent | undefined {
  return RULES.find(([, re]) => re.test(text))?.[0];
}

/** At most this many people / reaction scenes per video (15 % of footage scenes, at least 1). */
export const peopleCap = (footageScenes: number) => Math.max(1, Math.floor(footageScenes * 0.15));
