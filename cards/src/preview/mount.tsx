import React from 'react';
import {createRoot} from 'react-dom/client';
import {Player, PlayerRef} from '@remotion/player';
import type {PreviewModel} from '../../../src/lib/preview/previewTypes';
import {TimelinePreview} from './TimelinePreview';

/** Callbacks the studio gives the preview (the player's clock drives the studio's playhead). */
export interface PreviewHandlers {
  onFrame: (frame: number) => void;
  onPlay: () => void;
  onPause: () => void;
}

export interface PreviewController {
  /** Replaces the timeline shown (after every edit). */
  setModel: (model: PreviewModel) => void;
  seek: (frame: number) => void;
  play: () => void;
  pause: () => void;
  isPlaying: () => boolean;
  destroy: () => void;
}

const Host: React.FC<{model: PreviewModel; handlers: PreviewHandlers; playerRef: React.MutableRefObject<PlayerRef | null>}> = ({model, handlers, playerRef}) => {
  const ref = React.useRef<PlayerRef>(null);
  React.useEffect(() => {
    const player = ref.current;
    if (!player) return;
    playerRef.current = player;
    const onFrame = (e: {detail: {frame: number}}) => handlers.onFrame(e.detail.frame);
    const onPlay = () => handlers.onPlay();
    const onPause = () => handlers.onPause();
    player.addEventListener('frameupdate', onFrame);
    player.addEventListener('play', onPlay);
    player.addEventListener('pause', onPause);
    player.addEventListener('ended', onPause);
    return () => {
      player.removeEventListener('frameupdate', onFrame);
      player.removeEventListener('play', onPlay);
      player.removeEventListener('pause', onPause);
      player.removeEventListener('ended', onPause);
      playerRef.current = null;
    };
  }, [handlers, playerRef]);
  return (
    <Player
      ref={ref}
      component={TimelinePreview}
      inputProps={{model}}
      durationInFrames={Math.max(1, model.totalFrames)}
      fps={model.fps}
      compositionWidth={model.width}
      compositionHeight={model.height}
      controls={false}
      clickToPlay={false}
      doubleClickToFullscreen={false}
      spaceKeyToPlayOrPause={false}
      numberOfSharedAudioTags={6}
      // Remotion is free for individuals and companies of up to 3 people (cards/README.md).
      acknowledgeRemotionLicense
      style={{width: '100%', height: '100%'}}
    />
  );
};

/** Mounts the preview player into `element`; the studio calls setModel with the timeline to show. */
export function mount(element: HTMLElement, handlers: PreviewHandlers): PreviewController {
  const root = createRoot(element);
  const playerRef: React.MutableRefObject<PlayerRef | null> = {current: null};
  let model: PreviewModel | null = null;
  return {
    setModel(next) {
      model = next;
      root.render(<Host model={next} handlers={handlers} playerRef={playerRef} />);
    },
    seek: (frame) => playerRef.current?.seekTo(Math.max(0, Math.min(frame, (model?.totalFrames ?? 1) - 1))),
    play: () => playerRef.current?.play(),
    pause: () => playerRef.current?.pause(),
    isPlaying: () => playerRef.current?.isPlaying() ?? false,
    destroy: () => root.unmount(),
  };
}
