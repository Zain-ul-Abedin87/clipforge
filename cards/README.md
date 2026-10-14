# ClipForge cards (Remotion)

Animated overlay cards: RankCard, PriceCard, SpecCard, LowerThird (`src/Cards.tsx`).
ClipForge's timeline step renders every card of a video in one batch with `render.mjs`
(ProRes 4444 + alpha, cached in `cache/cards/` by content hash) and overlays them in the NVENC
render. If this folder has no `node_modules`, or a card fails, the old drawtext cards are used.

- Install once: `cd cards && npm install` (Chrome Headless Shell downloads on first render).
- Preview/edit: `npm run studio`.
- Turn off: `CARDS=off` in `.env`.
- Font: Anton (SIL OFL 1.1, `public/fonts/OFL.txt`).
- Licence: Remotion is free for individuals and companies with up to 3 people; bigger teams need a
  Remotion Company License (fallback: Revideo, MIT).
