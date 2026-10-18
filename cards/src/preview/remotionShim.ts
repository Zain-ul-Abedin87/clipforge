import React from 'react';
import {useVideoConfig as useRemotionVideoConfig} from 'remotion';

/**
 * The preview bundle resolves `remotion` for cards/src/Cards.tsx to this module (see
 * cards/build-preview.mjs), so the cards run unchanged inside the studio preview.
 *
 * A card computes its fade-out from useVideoConfig().durationInFrames. In a render that is the card's
 * own length; inside the preview timeline it is the length of the whole video, so the preview wraps
 * every card in CardLength with the length the timeline gives it.
 */
export * from 'remotion';

export const CardLength = React.createContext<number | null>(null);

export const useVideoConfig: typeof useRemotionVideoConfig = () => {
  const config = useRemotionVideoConfig();
  const length = React.useContext(CardLength);
  return length === null ? config : {...config, durationInFrames: length};
};
