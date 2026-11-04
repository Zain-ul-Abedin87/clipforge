import React from 'react';
import {AbsoluteFill, interpolate, useCurrentFrame} from 'remotion';
import {captionPreset} from '../../src/lib/render/captionPresets';
import {activeWord, type FrameLine} from '../../src/lib/render/captionTiming';

/**
 * Word-highlight captions from the align timings (frames: src/lib/render/captionTiming.ts), in the
 * presets of src/lib/render/captionPresets.ts, the same definitions the render's ASS subtitles use.
 * Used by the studio preview (TimelinePreview) and as a transparent overlay composition
 * ("Captions", e.g. for Shorts). Modes: line, karaoke, word (pop), highlight (active word in the
 * accent colour, or on an accent box, slightly larger).
 */

export type CaptionsProps = {
  lines: FrameLine[];
  preset?: string;
  fontSize?: number;
  textColor?: string;
  background?: string;
  marginV?: number;
  fontFamily?: string;
  /** Vertical position: bottom (default) or middle (Shorts). */
  position?: 'bottom' | 'middle';
};

const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;

export const CaptionsLayer: React.FC<CaptionsProps> = ({lines, preset: presetId, fontSize = 54, textColor = '#ffffff', background = 'rgba(0,0,0,0.55)', marginV = 70, fontFamily, position = 'bottom'}) => {
  const frame = useCurrentFrame();
  const preset = captionPreset(presetId);
  const line = lines.find((l) => frame >= l.startFrame && frame < l.endFrame);
  if (!line) return null;
  const color = preset.textColor ?? textColor;
  const style: React.CSSProperties = {
    fontFamily: fontFamily ?? 'Inter, Arial, Helvetica, sans-serif',
    fontWeight: 800,
    fontSize: Math.round(fontSize * preset.sizeScale),
    lineHeight: 1.2,
    textAlign: 'center',
    textTransform: preset.uppercase ? 'uppercase' : 'none',
    color: preset.mode === 'word' ? preset.accent : color,
    ...(preset.box
      ? {background, padding: '6px 22px', borderRadius: 8}
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
  } else if (preset.mode === 'highlight' && line.words) {
    const k = activeWord(line, frame);
    content = line.words.map((w, i) => {
      const on = i === k;
      // A 3-frame grow when the word becomes active.
      const grow = on ? interpolate(frame - w.startFrame, [0, 3], [1, 1.12], clamp) : 1;
      const hi: React.CSSProperties = on
        ? preset.highlightBox
          ? {background: preset.accent, borderRadius: 10, padding: '0 10px', WebkitTextStroke: '0px transparent', color: '#ffffff'}
          : {color: preset.accent}
        : {};
      return (
        <React.Fragment key={i}>
          <span style={{display: 'inline-block', transform: `scale(${grow})`, ...hi}}>{w.text}</span>{' '}
        </React.Fragment>
      );
    });
  } else if (preset.mode === 'word') {
    const pop = interpolate(frame - line.startFrame, [0, 4], [0.75, 1], clamp);
    style.transform = `scale(${pop})`;
  }
  return (
    <AbsoluteFill style={{justifyContent: position === 'middle' ? 'center' : 'flex-end', alignItems: 'center', paddingBottom: position === 'middle' ? 0 : marginV}}>
      <div style={{maxWidth: '86%', ...style}}>{content}</div>
    </AbsoluteFill>
  );
};

/** Transparent overlay composition (rendered as ProRes 4444 with alpha, like the cards). */
export const Captions: React.FC<CaptionsProps> = (props) => (
  <AbsoluteFill style={{backgroundColor: 'transparent'}}>
    <CaptionsLayer {...props} />
  </AbsoluteFill>
);
