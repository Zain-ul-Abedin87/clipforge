import type { OverlayClip, VideoClip } from "../../domain/timeline.types.js";

/**
 * The JSON the studio's live preview (cards/src/preview) plays; built by buildPreviewModel. Kept free
 * of Node imports so the browser bundle and the cards project can share these types.
 */

export interface PreviewClip {
  id: string;
  kind: "video" | "image";
  url: string;
  startFrame: number;
  frames: number;
  /** Seconds into the source file at the clip start. */
  sourceInSec: number;
  motion: VideoClip["motion"];
  fit: VideoClip["fit"];
  /** Frames of fade from black at the clip start / to black at its end (scene transitions). */
  fadeInFrames: number;
  fadeOutFrames: number;
  /** Flash transition: a white flash fading out over this many frames at the start. */
  flashFrames: number;
}

export interface PreviewOverlay {
  id: string;
  startFrame: number;
  frames: number;
  anim: NonNullable<OverlayClip["overlay"]["anim"]>;
  /** A Remotion card, rendered live from its props. */
  card?: { comp: string; props: Record<string, unknown> };
  /** A still PNG layer. */
  url?: string;
}

export interface PreviewModel {
  fps: number;
  width: number;
  height: number;
  totalFrames: number;
  clips: PreviewClip[];
  overlays: PreviewOverlay[];
  captions: {
    enabled: boolean;
    /** Caption style id (src/lib/render/captionPresets.ts). */
    preset: string;
    lines: { startFrame: number; endFrame: number; text: string; words?: { text: string; startFrame: number; endFrame: number }[] }[];
    fontSize: number;
    textColor: string;
    background: string;
    marginV: number;
  } | null;
  voice: { url: string; parts: { startFrame: number; frames: number; sourceInSec: number }[] };
  music: { url: string; gainDb: number; duck: boolean; fadeInSec: number; fadeOutSec: number } | null;
  logo: { url: string; position: string; opacity: number } | null;
}
