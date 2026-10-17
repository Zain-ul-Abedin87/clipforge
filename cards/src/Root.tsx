import React from 'react';
import {Composition} from 'remotion';
import {RankCard, PriceCard, SpecCard, LowerThird, SpecBars, ProsCons, PriceTag, CompareTable, GaugeCard, PartCallout, PhotoParallax} from './Cards';

// Lengths here are only defaults for the Studio preview; render.mjs sets each card's real length.
const c = {fps: 30, width: 1920, height: 1080};
export const Root: React.FC = () => (
  <>
    <Composition id="RankCard" component={RankCard} durationInFrames={75} {...c} defaultProps={{rank: 5, name: 'PRODUCT NAME'}} />
    <Composition id="PriceCard" component={PriceCard} durationInFrames={75} {...c} defaultProps={{name: 'PRODUCT NAME', price: '$279'}} />
    <Composition id="SpecCard" component={SpecCard} durationInFrames={90} {...c} defaultProps={{title: 'PRODUCT NAME', rows: [['WEIGHT', '250 g'], ['BATTERY', '30 h'], ['SIZE', '6.3 in']]}} />
    <Composition id="LowerThird" component={LowerThird} durationInFrames={90} {...c} defaultProps={{title: 'PRODUCT NAME', sub: 'Best budget pick', rank: 5 as number | null}} />
    <Composition id="SpecBars" component={SpecBars} durationInFrames={120} {...c} defaultProps={{title: 'PRODUCT NAME', rows: [{label: 'Battery', value: '30 h', pct: 0.8}, {label: 'Weight', value: '250 g', pct: 0.5}]}} />
    <Composition id="ProsCons" component={ProsCons} durationInFrames={120} {...c} defaultProps={{title: 'PRODUCT NAME', pros: ['Great battery', 'Light'], cons: ['Pricey']}} />
    <Composition id="PriceTag" component={PriceTag} durationInFrames={90} {...c} defaultProps={{name: 'PRODUCT NAME', price: '$299', note: ''}} />
    <Composition id="CompareTable" component={CompareTable} durationInFrames={150} {...c} defaultProps={{title: 'Head to head', products: ['A', 'B', 'C'], rows: [{label: 'Price', values: ['$1', '$2', '$3']}], highlight: 1 as number | undefined}} />
    <Composition id="GaugeCard" component={GaugeCard} durationInFrames={120} {...c} defaultProps={{title: 'PRODUCT NAME', label: 'Engine', value: '163 cc', pct: 0.7, compare: [{name: 'A', value: '163 cc', pct: 0.7, me: true}, {name: 'B', value: '223 cc', pct: 1}] as {name: string; value: string; pct: number; me?: boolean}[] | undefined}} />
    <Composition id="PartCallout" component={PartCallout} durationInFrames={150} {...c} defaultProps={{photo: 'callout/sample.jpg', box: {x: 0.4, y: 0.4, w: 0.2, h: 0.2}, aspect: 1.5, title: 'PRODUCT NAME', label: 'Deck', value: '14-gauge steel'}} />
    <Composition id="PhotoParallax" component={PhotoParallax} durationInFrames={90} {...c} defaultProps={{photo: 'callout/sample.jpg', aspect: 1.5}} />
  </>
);
