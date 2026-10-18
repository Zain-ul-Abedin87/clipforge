import { secondsToFrame, toNumber } from "../../domain/rational.math.js";
import { AudioClip, clipEnd, MultiTrackTimeline, OverlayClip, VideoClip } from "../../domain/timeline.types.js";
import { DEFAULT_FADE } from "../../audio/duck.js";
import { captionLines, CaptionStyle, remapWords } from "../render/captions.js";
import { captionMaxWords, captionPreset } from "../render/captionPresets.js";
import { voiceParts } from "../transcriptEdit.js";
import type { PreviewClip, PreviewModel, PreviewOverlay } from "./previewTypes.js";

export type { PreviewClip, PreviewModel, PreviewOverlay } from "./previewTypes.js";

/**
 * What the studio's live preview (the Remotion Player in cards/src/Preview.tsx) needs, built from the
 * v3 timeline. Plain JSON with frame numbers and URLs, so the browser does no timeline logic:
 * clips with their transition fades, overlays (Remotion cards are rendered live from their props),
 * caption lines, the voice pieces and the music bed.
 *
 * It mirrors what the renderer does closely enough to judge an edit (cut points, cards, captions,
 * transitions, audio); pixel-exact output only comes from the real render.
 */

/** Scene transitions in the renderer (render.ts FADE / flash): 0.25 s fade, 0.3 s flash. */
export const FADE_SEC = 0.25;
export const FLASH_SEC = 0.3;

export interface PreviewInput {
  /** URL that streams the media of a timeline clip ("@logo" = the channel logo). */
  mediaUrl: (clipId: string) => string;
  voiceUrl: string;
  /** Aligned words (aligned.json), null when the project has none. */
  words: { word: string; start: number; end: number }[] | null;
}

const clipsOf = <T>(tl: MultiTrackTimeline, kind: string): T[] => tl.tracks.filter((t) => t.kind === kind && !t.muted).flatMap((t) => t.clips) as T[];

export function buildPreviewModel(tl: MultiTrackTimeline, input: PreviewInput): PreviewModel {
  const fps = toNumber(tl.fps);
  const frame = (t: Parameters<typeof secondsToFrame>[0]) => Number(secondsToFrame(t, tl.fps));
  const span = (c: { start: Parameters<typeof secondsToFrame>[0]; duration: Parameters<typeof secondsToFrame>[0] }) => ({ startFrame: frame(c.start), frames: frame(clipEnd(c)) - frame(c.start) });

  // Scene transitions live on the scene's first picture; "fade" also fades the previous scene out.
  const broll = clipsOf<VideoClip>(tl, "broll").filter((c) => c.kind === "video").sort((a, b) => toNumber(a.start) - toNumber(b.start));
  const scenes = [...tl.scenes].sort((a, b) => toNumber(a.start) - toNumber(b.start));
  const sceneClips = scenes.map((s) => broll.filter((c) => c.sceneId === s.id));
  const fadeFrames = Math.round(FADE_SEC * fps);
  const flashFrames = Math.round(FLASH_SEC * fps);
  const fadeIn = new Set<string>();
  const flash = new Set<string>();
  const fadeOut = new Set<string>();
  sceneClips.forEach((clips, i) => {
    const first = clips[0];
    if (!first) return;
    if (first.transitionIn === "fade") {
      fadeIn.add(first.id);
      const prev = sceneClips[i - 1]?.at(-1);
      if (prev) fadeOut.add(prev.id);
    } else if (first.transitionIn === "flash") flash.add(first.id);
  });

  const clips: PreviewClip[] = broll.map((c) => ({
    id: c.id,
    kind: c.media.kind === "image" ? "image" : "video",
    url: input.mediaUrl(c.id),
    ...span(c),
    sourceInSec: toNumber(c.media.sourceIn),
    motion: c.motion,
    fit: c.fit,
    fadeInFrames: fadeIn.has(c.id) ? fadeFrames : 0,
    fadeOutFrames: fadeOut.has(c.id) ? fadeFrames : 0,
    flashFrames: flash.has(c.id) ? flashFrames : 0,
  }));

  const overlays: PreviewOverlay[] = [];
  for (const o of clipsOf<OverlayClip>(tl, "overlay")) {
    if (o.kind !== "overlay") continue;
    const base = { id: o.id, ...span(o), anim: o.overlay.anim ?? "fade" };
    if (o.overlay.card) overlays.push({ ...base, card: o.overlay.card });
    // A pre-rendered alpha video (ProRes) cannot play in a browser; its card is drawn from props above.
    else if (o.overlay.path && !o.overlay.video) overlays.push({ ...base, url: input.mediaUrl(o.id) });
  }

  const voice = clipsOf<AudioClip>(tl, "voiceover").filter((c) => c.kind === "audio").sort((a, b) => toNumber(a.start) - toNumber(b.start));
  const parts = voice.map((v) => ({ startFrame: frame(v.start), frames: frame(clipEnd(v)) - frame(v.start), sourceInSec: toNumber(v.media.sourceIn) }));

  const cap = (tl.settings?.captions ?? null) as (Partial<CaptionStyle> & { enabled: boolean }) | null;
  let captions: PreviewModel["captions"] = null;
  if (cap?.enabled && input.words?.length) {
    const aligned = input.words.map((w) => ({ ...w, source: "script" as const }));
    const preset = captionPreset(cap.preset);
    const lines = captionLines(remapWords(aligned, voiceParts(tl)), captionMaxWords({ preset: cap.preset, maxWordsPerLine: cap.maxWordsPerLine ?? 6 }), { withWords: preset.mode !== "line" });
    const toFrame = (sec: number) => Math.round(sec * fps);
    captions = {
      enabled: true,
      preset: preset.id,
      lines: lines.map((l) => ({
        startFrame: toFrame(l.start),
        endFrame: Math.max(toFrame(l.start) + 1, toFrame(l.end)),
        text: l.text,
        ...(l.words ? { words: l.words.map((w) => ({ text: w.text, startFrame: toFrame(w.start), endFrame: Math.max(toFrame(w.start) + 1, toFrame(w.end)) })) } : {}),
      })),
      fontSize: cap.fontSize ?? 54,
      textColor: cap.textColor ?? "#ffffff",
      background: cap.background ?? "rgba(0,0,0,0.55)",
      marginV: cap.marginV ?? 60,
    };
  }

  const bed = clipsOf<AudioClip>(tl, "music").find((c) => c.kind === "audio");
  const logo = tl.settings?.logo;
  return {
    fps,
    width: tl.width,
    height: tl.height,
    totalFrames: frame(tl.duration),
    clips,
    overlays,
    captions,
    voice: { url: input.voiceUrl, parts },
    music: bed ? { url: input.mediaUrl(bed.id), gainDb: bed.gainDb, duck: bed.duck ?? true, fadeInSec: bed.fadeInSec ?? DEFAULT_FADE.inSec, fadeOutSec: bed.fadeOutSec ?? DEFAULT_FADE.outSec } : null,
    logo: logo?.path ? { url: input.mediaUrl("@logo"), position: logo.position, opacity: logo.opacity } : null,
  };
}
