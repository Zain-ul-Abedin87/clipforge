/**
 * Named caption styles. One definition drives both the final render (ASS subtitles burned in by
 * FFmpeg, render/captions.ts) and the studio preview (Remotion, cards/src/preview), so the preview
 * shows the style the render will use. No imports: the browser bundle shares this file.
 *
 * The channel (style.json captions.preset) or the studio picks a preset; the channel's own font,
 * size, text colour and background still apply where a preset does not override them.
 */

export type CaptionMode =
  /** A short line of words, shown as a whole. */
  | "line"
  /** A short line whose current word is highlighted as it is spoken. */
  | "karaoke"
  /** One word at a time, popping in. */
  | "word";

export interface CaptionPreset {
  id: string;
  label: string;
  description: string;
  mode: CaptionMode;
  uppercase: boolean;
  /** Multiplier of the channel's caption font size. */
  sizeScale: number;
  /** Words per line (word mode: 1); null = the channel's maxWordsPerLine. */
  maxWords: number | null;
  /** A solid box behind the text (the channel's background colour) instead of an outline. */
  box: boolean;
  /** Text colour; null = the channel's. */
  textColor: string | null;
  /** Highlight colour of the spoken word (karaoke / word). */
  accent: string;
  outlineColor: string;
  /** Outline width in px at 1080p (ignored with a box). */
  outline: number;
  shadow: number;
}

export const CAPTION_PRESETS: readonly CaptionPreset[] = [
  { id: "classic", label: "Classic", description: "Plain text on a dark box (the default look).", mode: "line", uppercase: false, sizeScale: 1, maxWords: null, box: true, textColor: null, accent: "#FFD60A", outlineColor: "#000000", outline: 0, shadow: 0 },
  { id: "bold", label: "Bold", description: "Big capitals with a heavy outline, a few words at a time.", mode: "line", uppercase: true, sizeScale: 1.25, maxWords: 3, box: false, textColor: "#FFFFFF", accent: "#FFD60A", outlineColor: "#000000", outline: 8, shadow: 3 },
  { id: "karaoke", label: "Karaoke", description: "The spoken word lights up as it is said.", mode: "karaoke", uppercase: false, sizeScale: 1.15, maxWords: 4, box: false, textColor: "#FFFFFF", accent: "#FFD60A", outlineColor: "#000000", outline: 6, shadow: 2 },
  { id: "pop", label: "Pop", description: "One big word at a time, popping in.", mode: "word", uppercase: true, sizeScale: 1.7, maxWords: 1, box: false, textColor: "#FFFFFF", accent: "#FFD60A", outlineColor: "#000000", outline: 9, shadow: 3 },
  { id: "minimal", label: "Minimal", description: "Small, quiet text with a soft shadow.", mode: "line", uppercase: false, sizeScale: 0.8, maxWords: 7, box: false, textColor: null, accent: "#FFD60A", outlineColor: "#000000", outline: 3, shadow: 2 },
];

export const DEFAULT_CAPTION_PRESET = "classic";

export const isCaptionPreset = (id: unknown): id is string => typeof id === "string" && CAPTION_PRESETS.some((p) => p.id === id);

/** The preset with this id; unknown or missing ids fall back to Classic (old timelines have none). */
export const captionPreset = (id?: string | null): CaptionPreset => CAPTION_PRESETS.find((p) => p.id === id) ?? CAPTION_PRESETS[0];

/** Words per caption line for a style: the preset's, else the channel's. */
export const captionMaxWords = (style: { preset?: string; maxWordsPerLine: number }): number => captionPreset(style.preset).maxWords ?? style.maxWordsPerLine;
