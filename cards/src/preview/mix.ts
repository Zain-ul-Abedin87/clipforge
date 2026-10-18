import type {PreviewModel} from '../../../src/lib/preview/previewTypes';

/**
 * The renderer ducks the music by sidechain compression while the voice speaks. The preview cannot
 * follow speech, so with ducking on it plays the bed this much quieter.
 */
export const PREVIEW_DUCK_DB = -12;

/** Linear music volume (0..1) at `frame` (0 = start of the video): level, ducking, fade in / out. */
export function musicGain(music: NonNullable<PreviewModel['music']>, frame: number, totalFrames: number, fps: number): number {
  const t = frame / fps;
  const total = totalFrames / fps;
  const fadeOut = Math.min(music.fadeOutSec, total);
  const fade = Math.min(music.fadeInSec > 0 ? t / music.fadeInSec : 1, fadeOut > 0 ? (total - t) / fadeOut : 1, 1);
  const db = music.gainDb + (music.duck ? PREVIEW_DUCK_DB : 0);
  return Math.max(0, Math.min(1, 10 ** (db / 20) * Math.max(0, fade)));
}
