import React from 'react';
import {AbsoluteFill, Html5Audio, Html5Video, Img, Sequence, interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import type {PreviewClip, PreviewModel, PreviewOverlay} from '../../../src/lib/preview/previewTypes';
import * as Cards from '../Cards';
import {captionPreset} from '../../../src/lib/render/captionPresets';
import {musicGain} from './mix';
import {CardLength} from './remotionShim';

/**
 * The studio's live preview: the v3 timeline as one Remotion composition, played by @remotion/player.
 * Pictures, cards (the same React components the render uses), captions, transitions, logo, voice and
 * music are drawn from a PreviewModel (src/lib/preview/previewModel.ts).
 */

const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;
const fill: React.CSSProperties = {width: '100%', height: '100%'};

/**
 * A media element that cannot be decoded (a file being replaced during an edit, a broken download)
 * would otherwise throw out of the player; the preview logs it and shows black / silence instead.
 */
const mediaError = (url: string) => (e: unknown) => console.warn(`preview: cannot play ${url}`, e);

/** Card components by name; only functions exported by Cards.tsx can be named by the timeline. */
const cardComponent = (comp: string): React.ComponentType<Record<string, unknown>> | null => {
  const c = (Cards as Record<string, unknown>)[comp];
  return typeof c === 'function' && /^[A-Z]/.test(comp) ? (c as React.ComponentType<Record<string, unknown>>) : null;
};

const motionTransform = (motion: PreviewClip['motion'], progress: number): string => {
  const zoom = (from: number, to: number) => `scale(${from + (to - from) * progress})`;
  switch (motion) {
    case 'zoom_in': return zoom(1, 1.08);
    case 'zoom_out': return zoom(1.08, 1);
    case 'pan_left': return `scale(1.08) translateX(${(0.5 - progress) * 4}%)`;
    case 'pan_right': return `scale(1.08) translateX(${(progress - 0.5) * 4}%)`;
    default: return 'none';
  }
};

const ClipView: React.FC<{clip: PreviewClip}> = ({clip}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const fadeIn = clip.fadeInFrames ? interpolate(frame, [0, clip.fadeInFrames], [0, 1], clamp) : 1;
  const fadeOut = clip.fadeOutFrames ? interpolate(frame, [clip.frames - clip.fadeOutFrames, clip.frames], [1, 0], clamp) : 1;
  const flash = clip.flashFrames ? interpolate(frame, [0, clip.flashFrames], [1, 0], clamp) : 0;
  const objectFit = clip.fit === 'cover' ? 'cover' : 'contain';
  return (
    <AbsoluteFill style={{opacity: Math.min(fadeIn, fadeOut), backgroundColor: '#000'}}>
      {clip.kind === 'video' ? (
        <Html5Video src={clip.url} trimBefore={Math.round(clip.sourceInSec * fps)} muted style={{...fill, objectFit}} onError={mediaError(clip.url)} />
      ) : (
        <Img src={clip.url} style={{...fill, objectFit, transform: motionTransform(clip.motion, frame / Math.max(1, clip.frames))}} />
      )}
      {flash > 0 ? <AbsoluteFill style={{backgroundColor: '#fff', opacity: flash}} /> : null}
    </AbsoluteFill>
  );
};

const OverlayView: React.FC<{overlay: PreviewOverlay}> = ({overlay}) => {
  const Card = overlay.card ? cardComponent(overlay.card.comp) : null;
  if (overlay.card) {
    // Cards animate themselves and fade out over their last frames (see CardLength).
    return Card ? (
      <CardLength.Provider value={overlay.frames}>
        <Card {...overlay.card.props} />
      </CardLength.Provider>
    ) : null;
  }
  return <StillOverlay overlay={overlay} />;
};

/** A PNG layer with the renderer's slide / fade entrance (approximate). */
const StillOverlay: React.FC<{overlay: PreviewOverlay}> = ({overlay}) => {
  const frame = useCurrentFrame();
  const enter = interpolate(frame, [0, 8], [0, 1], clamp);
  const exit = interpolate(frame, [overlay.frames - 8, overlay.frames], [1, 0], clamp);
  const offset = (1 - enter) * 60;
  const transform = overlay.anim === 'slide_up' ? `translateY(${offset}px)` : overlay.anim === 'slide_left' ? `translateX(${offset}px)` : overlay.anim === 'slide_right' ? `translateX(${-offset}px)` : 'none';
  return <Img src={overlay.url ?? ''} style={{...fill, objectFit: 'contain', opacity: Math.min(enter, exit), transform}} />;
};

/** Captions in the model's preset (src/lib/render/captionPresets.ts), the same definition the render's ASS uses. */
const Captions: React.FC<{captions: NonNullable<PreviewModel['captions']>}> = ({captions}) => {
  const frame = useCurrentFrame();
  const preset = captionPreset(captions.preset);
  const line = captions.lines.find((l) => frame >= l.startFrame && frame < l.endFrame);
  if (!line) return null;
  const color = preset.textColor ?? captions.textColor;
  const style: React.CSSProperties = {
    fontFamily: 'Arial, Helvetica, sans-serif',
    fontWeight: 700,
    fontSize: Math.round(captions.fontSize * preset.sizeScale),
    lineHeight: 1.2,
    textAlign: 'center',
    textTransform: preset.uppercase ? 'uppercase' : 'none',
    color: preset.mode === 'word' ? preset.accent : color,
    ...(preset.box
      ? {background: captions.background, padding: '6px 22px', borderRadius: 8}
      : {
          // CSS strokes are centred on the edge; painting the fill over it leaves half the width outside.
          WebkitTextStroke: `${preset.outline * 2}px ${preset.outlineColor}`,
          paintOrder: 'stroke fill',
          textShadow: preset.shadow ? `0 ${preset.shadow * 2}px ${preset.shadow * 3}px rgba(0,0,0,.6)` : undefined,
        }),
  };
  let content: React.ReactNode = line.text;
  if (preset.mode === 'karaoke' && line.words) {
    content = line.words.map((w, i) => (
      <span key={i} style={{color: frame >= w.startFrame ? preset.accent : color}}>
        {w.text}{' '}
      </span>
    ));
  } else if (preset.mode === 'word') {
    const pop = interpolate(frame - line.startFrame, [0, 4], [0.75, 1], clamp);
    style.transform = `scale(${pop})`;
  }
  return (
    <AbsoluteFill style={{justifyContent: 'flex-end', alignItems: 'center', paddingBottom: captions.marginV}}>
      <div style={{maxWidth: '86%', ...style}}>{content}</div>
    </AbsoluteFill>
  );
};

const LOGO_SPOT: Record<string, React.CSSProperties> = {
  'top-left': {top: 36, left: 40},
  'top-right': {top: 36, right: 40},
  'bottom-left': {bottom: 36, left: 40},
  'bottom-right': {bottom: 36, right: 40},
};

export const TimelinePreview: React.FC<{model: PreviewModel}> = ({model}) => {
  const {fps} = useVideoConfig();
  const premount = Math.round(fps);
  return (
    <AbsoluteFill style={{backgroundColor: '#000'}}>
      {model.clips.map((c) => (
        <Sequence key={c.id} from={c.startFrame} durationInFrames={Math.max(1, c.frames)} premountFor={premount}>
          <ClipView clip={c} />
        </Sequence>
      ))}
      {model.overlays.map((o) => (
        <Sequence key={o.id} from={o.startFrame} durationInFrames={Math.max(1, o.frames)} premountFor={premount}>
          <OverlayView overlay={o} />
        </Sequence>
      ))}
      {model.logo ? <Img src={model.logo.url} style={{position: 'absolute', height: 90, opacity: model.logo.opacity, ...(LOGO_SPOT[model.logo.position] ?? LOGO_SPOT['top-right'])}} /> : null}
      {model.captions ? <Captions captions={model.captions} /> : null}
      {model.voice.parts.map((p) => (
        <Sequence key={`voice_${p.startFrame}`} from={p.startFrame} durationInFrames={Math.max(1, p.frames)}>
          <Html5Audio src={model.voice.url} trimBefore={Math.round(p.sourceInSec * fps)} onError={mediaError(model.voice.url)} />
        </Sequence>
      ))}
      {model.music ? <Html5Audio src={model.music.url} loop volume={(f) => musicGain(model.music!, f, model.totalFrames, fps)} onError={mediaError(model.music.url)} /> : null}
    </AbsoluteFill>
  );
};
